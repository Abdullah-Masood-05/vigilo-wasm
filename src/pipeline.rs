//! The whole per-frame pipeline, minus inference.
//!
//! This is `vigilo-core`'s `detect_worker` with the four `Session::run` calls
//! cut out and replaced by a boundary the host crosses. The host — browser JS
//! driving `onnxruntime-web` — owns nothing but the graphs:
//!
//! ```text
//! begin_frame(rgba)        ->  pixels land in wasm, once
//!   face_input()           ->  Float32Array [1,3,640,640]
//!   <JS: yunet.run>
//!   decode_face(bag)       ->  FaceDetection[], sorted by score
//!   pose_input()           ->  Float32Array [1,3,224,224]   (primary face)
//!   <JS: headpose.run>
//!   decode_pose(rot)       ->  HeadPose
//!   gaze_gate()            ->  GateReason | null
//!   gaze_input()           ->  Float32Array [1,3,448,448]
//!   <JS: gaze.run>
//!   decode_gaze(yaw,pitch) ->  Gaze, incl. eye-in-head
//!   object_input()         ->  Float32Array [1,3,416,416]   (own cadence)
//!   <JS: yolox.run>
//!   decode_objects(out)    ->  ObjectDetection[]
//! end_frame(t_ms)          ->  Signals + Events
//! ```
//!
//! Every decision that is not "multiply this tensor by those weights" stays on
//! this side: which face is the primary one, whether gaze is allowed to run,
//! what an absent slot means, and what all of it adds up to. That is
//! deliberate. Reimplementing any of it in TypeScript would create a second
//! implementation of rules that are tuned against a recorded corpus, and the
//! two would drift the first time one was fixed.
//!
//! # Identity is gone on purpose
//!
//! There is no ArcFace slot here. The embedding model is 13.6 MB — as much as
//! the other four put together — to run at 0.2 Hz, and enrolment needs a
//! trusted reference photo that a browser tab does not have. `identity` is
//! therefore reported as [`SlotState::NotConfigured`] for the whole session,
//! which is the one value that tells fusion "never available" rather than
//! "absent right now".

use std::collections::BTreeMap;

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::config::Config;
use crate::to_js;
use crate::decode;
use crate::direction::DirectionTracker;
use crate::frame::FrameBuf;
use crate::fusion::FusionEngine;
use crate::models::nms;
use crate::preprocess::{FacePre, GazePre, ObjectPre, PosePre};
use crate::types::{
    Event, FaceDetection, GateReason, Gaze, HeadPose, ObjectDetection, SignalCoverage, Signals,
    SlotState, ViolationKind,
};

/// A named bag of output tensors, so YuNet's twelve heads cross the boundary
/// in one call instead of twelve positional arguments.
#[wasm_bindgen]
#[derive(Default)]
pub struct TensorBag {
    map: BTreeMap<String, Vec<f32>>,
}

#[wasm_bindgen]
impl TensorBag {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Store one output tensor under the name the graph gave it.
    pub fn set(&mut self, name: &str, data: &[f32]) {
        self.map.insert(name.to_string(), data.to_vec());
    }

    pub fn clear(&mut self) {
        self.map.clear();
    }

    #[wasm_bindgen(js_name = has)]
    pub fn has(&self, name: &str) -> bool {
        self.map.contains_key(name)
    }
}

/// What one call to [`VigiloPipeline::end_frame`] produced.
#[derive(Serialize)]
struct FrameResult {
    signals: Signals,
    events: Vec<Event>,
    active: Vec<(ViolationKind, Option<String>)>,
}

/// Which slots have a model behind them at all.
///
/// A slot with no model is [`SlotState::NotConfigured`] for the whole session;
/// a slot with a model that simply did not run this frame is
/// [`SlotState::SkippedCadence`]. Fusion treats those two very differently, so
/// the host has to say which it means rather than letting an absent tensor
/// stand for both.
#[derive(Clone, Copy)]
struct Configured {
    pose: bool,
    gaze: bool,
    objects: bool,
}

impl Default for Configured {
    fn default() -> Self {
        Self { pose: true, gaze: true, objects: true }
    }
}

#[wasm_bindgen]
pub struct VigiloPipeline {
    cfg: Config,
    configured: Configured,

    frame: FrameBuf,
    face_pre: FacePre,
    pose_pre: PosePre,
    gaze_pre: GazePre,
    object_pre: ObjectPre,
    /// COCO ids resolved once from the config allowlist.
    allowed: Vec<u32>,

    // Per-frame state, cleared by `begin_frame`.
    faces: Vec<FaceDetection>,
    head_pose: Option<HeadPose>,
    gaze: Option<Gaze>,
    objects: Vec<ObjectDetection>,
    coverage: SignalCoverage,

    // Session state, cleared by `reset`.
    engine: FusionEngine,
    directions: DirectionTracker,
}

#[wasm_bindgen]
impl VigiloPipeline {
    /// Build a pipeline from an optional TOML or JSON config string.
    #[wasm_bindgen(constructor)]
    pub fn new(config_str: Option<String>) -> Result<VigiloPipeline, JsValue> {
        let cfg = crate::parse_config(config_str)?;
        let allowed = decode::resolve_allowlist(&cfg.thresholds.objects.allowlist);
        if allowed.is_empty() {
            return Err(JsValue::from_str(
                "objects.allowlist matched no COCO class — check the spelling",
            ));
        }

        Ok(Self {
            engine: FusionEngine::new(&cfg),
            directions: DirectionTracker::new(&cfg.thresholds.debug_direction),
            configured: Configured::default(),
            frame: FrameBuf::default(),
            face_pre: FacePre::default(),
            pose_pre: PosePre::default(),
            gaze_pre: GazePre::default(),
            object_pre: ObjectPre::default(),
            allowed,
            faces: Vec::new(),
            head_pose: None,
            gaze: None,
            objects: Vec::new(),
            coverage: SignalCoverage::default(),
            cfg,
        })
    }

    /// Declare which optional models the host actually loaded.
    ///
    /// Call once, after session creation. A model that failed to download is
    /// not configured, and saying so keeps fusion from waiting on a signal
    /// that is never coming.
    #[wasm_bindgen(js_name = configureSlots)]
    pub fn configure_slots(&mut self, pose: bool, gaze: bool, objects: bool) {
        self.configured = Configured { pose, gaze, objects };
    }

    /// Start a frame from `getImageData` / `VideoFrame.copyTo` output (RGBA).
    #[wasm_bindgen(js_name = beginFrame)]
    pub fn begin_frame(&mut self, rgba: &[u8], width: u32, height: u32) -> Result<(), JsValue> {
        self.frame.set_rgba(rgba, width, height).map_err(js_err)?;
        self.clear_frame_state();
        Ok(())
    }

    /// Start a frame from tightly packed RGB8.
    #[wasm_bindgen(js_name = beginFrameRgb)]
    pub fn begin_frame_rgb(&mut self, rgb: &[u8], width: u32, height: u32) -> Result<(), JsValue> {
        self.frame.set_rgb(rgb, width, height).map_err(js_err)?;
        self.clear_frame_state();
        Ok(())
    }

    // -- face ------------------------------------------------------------

    /// YuNet input: `[1, 3, 640, 640]`, planar BGR, letterboxed top-left.
    #[wasm_bindgen(js_name = faceInput)]
    pub fn face_input(&mut self) -> Result<Vec<f32>, JsValue> {
        self.face_pre.prepare(&self.frame).map(|t| t.to_vec()).map_err(js_err)
    }

    /// Decode YuNet's twelve heads into faces, sorted by score.
    ///
    /// Also settles what an empty result means for the two models downstream
    /// of it: with no face there is nothing to crop, so pose and gaze are
    /// *gated* skips rather than failures.
    #[wasm_bindgen(js_name = decodeFace)]
    pub fn decode_face(&mut self, outputs: &TensorBag) -> Result<JsValue, JsValue> {
        let t = &self.cfg.thresholds.face;
        self.faces = decode::decode_faces(
            &|name: &str| outputs.map.get(name).map(|v| v.as_slice()),
            t.min_score as f32,
            t.nms_threshold as f32,
            t.top_k,
            self.face_pre.letterbox,
        );
        self.coverage.face = SlotState::Produced;

        if self.faces.is_empty() {
            if self.configured.pose {
                self.coverage.pose = SlotState::SkippedGated;
            }
            if self.configured.gaze {
                self.coverage.gaze = SlotState::SkippedGated;
                self.coverage.gaze_gate = Some(GateReason::NoFace);
            }
        }
        to_js(&self.faces)
    }

    #[wasm_bindgen(js_name = faceCount)]
    pub fn face_count(&self) -> usize {
        self.faces.len()
    }

    // -- head pose -------------------------------------------------------

    /// Head pose input: `[1, 3, 224, 224]`, planar RGB, ImageNet-normalized,
    /// cropped square around the **primary** face.
    ///
    /// The primary face is index 0, which is the highest-scoring box because
    /// NMS sorted them. With two people in shot that means pose describes the
    /// candidate, not whoever wandered past behind them.
    #[wasm_bindgen(js_name = poseInput)]
    pub fn pose_input(&mut self) -> Result<Vec<f32>, JsValue> {
        let bbox = self.primary_bbox()?;
        let expand = self.cfg.thresholds.pose.crop_expand as f32;
        self.pose_pre.prepare(&self.frame, &bbox, expand).map(|t| t.to_vec()).map_err(js_err)
    }

    /// Decode the `rotation_matrix` output into yaw/pitch/roll degrees.
    #[wasm_bindgen(js_name = decodePose)]
    pub fn decode_pose(&mut self, rotation_matrix: &[f32]) -> Result<JsValue, JsValue> {
        if rotation_matrix.len() < 9 {
            return Err(JsValue::from_str(&format!(
                "rotation_matrix has {} elements, expected 9",
                rotation_matrix.len()
            )));
        }
        let pose = decode::rotation_matrix_to_euler(rotation_matrix);
        self.head_pose = Some(pose);
        self.coverage.pose = SlotState::Produced;
        to_js(&pose)
    }

    // -- gaze ------------------------------------------------------------

    /// Should gaze run on this frame? `null` means yes.
    ///
    /// Asking before preprocessing saves the 448x448 resize and the ~600 MFLOP
    /// inference behind it on every frame where the answer would have been
    /// noise. The side effect is recorded: a gated frame reports
    /// `SkippedGated` with the reason, not a missing signal.
    #[wasm_bindgen(js_name = gazeGate)]
    pub fn gaze_gate(&mut self) -> Result<JsValue, JsValue> {
        let Some(face) = self.faces.first() else {
            self.coverage.gaze = SlotState::SkippedGated;
            self.coverage.gaze_gate = Some(GateReason::NoFace);
            return to_js(&Some(GateReason::NoFace));
        };
        let min_score = self.cfg.thresholds.gaze.min_face_score as f32;
        let reason = decode::gaze_gate_reason(face, min_score);
        if let Some(reason) = reason {
            self.coverage.gaze = SlotState::SkippedGated;
            self.coverage.gaze_gate = Some(reason);
        }
        to_js(&reason)
    }

    /// Gaze input: `[1, 3, 448, 448]`, planar RGB, ImageNet-normalized, over
    /// the tight face box with no expansion.
    #[wasm_bindgen(js_name = gazeInput)]
    pub fn gaze_input(&mut self) -> Result<Vec<f32>, JsValue> {
        let bbox = self.primary_bbox()?;
        self.gaze_pre.prepare(&self.frame, &bbox).map(|t| t.to_vec()).map_err(js_err)
    }

    /// Decode the two 90-bin heads, and difference against this frame's head
    /// pose to get eye-in-head.
    ///
    /// Eye-in-head is only meaningful because both terms describe the same
    /// instant, which is why pose must be decoded before gaze on a frame where
    /// both run — not merely at some nearby time.
    #[wasm_bindgen(js_name = decodeGaze)]
    pub fn decode_gaze(&mut self, yaw: &[f32], pitch: &[f32]) -> Result<JsValue, JsValue> {
        let yaw_deg = decode::decode_bins(yaw);
        let pitch_deg = decode::decode_bins(pitch);
        let gaze = decode::assemble_gaze(
            yaw_deg.to_radians(),
            pitch_deg.to_radians(),
            self.head_pose,
        );
        self.gaze = Some(gaze);
        self.coverage.gaze = SlotState::Produced;
        self.coverage.gaze_gate = None;
        to_js(&gaze)
    }

    // -- objects ---------------------------------------------------------

    /// YOLOX input: `[1, 3, 416, 416]`, planar BGR, padded with 114.
    #[wasm_bindgen(js_name = objectInput)]
    pub fn object_input(&mut self) -> Result<Vec<f32>, JsValue> {
        self.object_pre.prepare(&self.frame).map(|t| t.to_vec()).map_err(js_err)
    }

    /// Decode and suppress the `[1, 3549, 85]` grid, keeping allowlisted
    /// classes only.
    #[wasm_bindgen(js_name = decodeObjects)]
    pub fn decode_objects(&mut self, output: &[f32]) -> Result<JsValue, JsValue> {
        let t = &self.cfg.thresholds.objects;
        let candidates = decode::decode_objects(
            output,
            t.min_score as f32,
            self.object_pre.letterbox.scale,
            &self.allowed,
        );
        self.objects = nms(candidates, t.nms_threshold as f32, 100, |o| (o.class_id, o.bbox, o.score));
        self.coverage.objects = SlotState::Produced;
        to_js(&self.objects)
    }

    // -- frame completion ------------------------------------------------

    /// Record that a slot's model errored on this frame.
    ///
    /// Degrade, never die: one bad inference is not a reason to end an exam,
    /// but it must not be reported as a clean "nothing there" either.
    #[wasm_bindgen(js_name = markFailed)]
    pub fn mark_failed(&mut self, slot: &str) {
        match slot {
            "face" => self.coverage.face = SlotState::Failed,
            "pose" => self.coverage.pose = SlotState::Failed,
            "gaze" => {
                self.coverage.gaze = SlotState::Failed;
                self.coverage.gaze_gate = None;
            }
            "objects" => self.coverage.objects = SlotState::Failed,
            _ => {}
        }
    }

    /// Assemble this frame's [`Signals`], step fusion, and return both.
    ///
    /// `t_ms` is milliseconds since session start and must be monotonic. It is
    /// a parameter rather than a clock read for the same reason it is in the
    /// native engine: a recording replayed through this function must produce
    /// a byte-identical event sequence, and a function that reads the clock
    /// cannot promise that.
    #[wasm_bindgen(js_name = endFrame)]
    pub fn end_frame(&mut self, t_ms: f64) -> Result<JsValue, JsValue> {
        let t_ms = t_ms.max(0.0) as u64;

        let signals = Signals {
            seq: self.frame.seq,
            t_ms,
            faces: std::mem::take(&mut self.faces),
            head_pose: self.head_pose,
            gaze: self.gaze,
            objects: std::mem::take(&mut self.objects),
            identity_match: None,
            produced_by: self.coverage,
            // Bucketed here, on the same frame's angles, so the label and the
            // number beside it can never disagree.
            debug_directions: Some(self.directions.update(self.head_pose, self.gaze)),
            ..Default::default()
        };

        let events = self.engine.step(&signals, t_ms);
        let result =
            FrameResult { signals, events, active: self.engine.active_detail() };
        to_js(&result)
    }

    /// Close everything still open, as a session ends.
    ///
    /// Without this, a violation that was open when the tab closed never gets
    /// an end event and reads as zero-length in the report.
    pub fn finish(&mut self, t_ms: f64) -> Result<JsValue, JsValue> {
        to_js(&self.engine.finish(t_ms.max(0.0) as u64))
    }

    /// Drop all temporal state. Thresholds and loaded slots are kept.
    pub fn reset(&mut self) {
        self.engine = FusionEngine::new(&self.cfg);
        self.directions = DirectionTracker::new(&self.cfg.thresholds.debug_direction);
        self.clear_frame_state();
    }

    /// The config in force, including every default that was filled in.
    #[wasm_bindgen(js_name = config)]
    pub fn config(&self) -> Result<JsValue, JsValue> {
        to_js(&self.cfg)
    }
}

impl VigiloPipeline {
    fn clear_frame_state(&mut self) {
        self.faces.clear();
        self.objects.clear();
        self.head_pose = None;
        self.gaze = None;
        self.coverage = SignalCoverage {
            // Nothing has run yet. `face` stays `NotConfigured` until
            // `decode_face` says otherwise, so a frame the host abandoned
            // halfway cannot be mistaken for one where the detector saw
            // nobody.
            face: SlotState::NotConfigured,
            pose: slot_default(self.configured.pose),
            gaze: slot_default(self.configured.gaze),
            objects: slot_default(self.configured.objects),
            // No ArcFace in the browser build — see the module comment.
            identity: SlotState::NotConfigured,
            gaze_gate: None,
        };
    }

    fn primary_bbox(&self) -> Result<crate::types::BBox, JsValue> {
        self.faces
            .first()
            .map(|f| f.bbox)
            .ok_or_else(|| JsValue::from_str("no face on this frame to crop from"))
    }
}

/// A configured model that has not run on this frame yet is a cadence skip —
/// expected, and not a fault. An unconfigured one is unavailable for the whole
/// session.
fn slot_default(configured: bool) -> SlotState {
    if configured {
        SlotState::SkippedCadence
    } else {
        SlotState::NotConfigured
    }
}

fn js_err(e: crate::error::DetectError) -> JsValue {
    JsValue::from_str(&e.to_string())
}

