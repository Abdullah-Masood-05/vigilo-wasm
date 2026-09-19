//! `vigilo-wasm` — High-performance WebAssembly proctoring stream fusion and behavioral engine.
//!
//! Exposes `FusionEngine`, `DirectionTracker`, geometric NMS, and signal replay
//! to JavaScript, TypeScript, Bun, Node.js, and browser environments with zero copy overhead.

use wasm_bindgen::prelude::*;

pub mod decode;
pub mod frame;
pub mod models;
pub mod pipeline;
pub mod preprocess;

#[path = "../../deepscreen-detect/src/error.rs"]
pub mod error;

#[path = "../../deepscreen-detect/src/types.rs"]
pub mod types;

#[path = "../../deepscreen-detect/src/config.rs"]
pub mod config;

#[path = "../../deepscreen-detect/src/direction.rs"]
pub mod direction;

#[path = "../../deepscreen-detect/src/fusion/mod.rs"]
pub mod fusion;

#[path = "../../deepscreen-detect/src/report.rs"]
pub mod report;

use config::Config;
use direction::DirectionTracker;

pub use pipeline::{TensorBag, VigiloPipeline};
use fusion::FusionEngine;
use types::{BBox, Signals};

/// Runs automatically when the module is instantiated.
///
/// Named so it cannot be confused with the loader's own `init` default export,
/// which is what a caller actually awaits.
#[wasm_bindgen(start)]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}


/// Serialize to JS with `None` becoming `null`, not `undefined`.
///
/// `serde_wasm_bindgen`'s default maps `Option::None` to `undefined`, which
/// disagrees with `serde_json` — so the same `Signals` reached JS with
/// `gaze: undefined` live and `gaze: null` when replayed from a recording.
/// Any consumer that distinguishes them, and `JSON.stringify` does (it drops
/// `undefined` fields entirely), sees two different shapes for one value.
pub(crate) fn to_js<T: serde::Serialize + ?Sized>(value: &T) -> Result<JsValue, JsValue> {
    let serializer = serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true);
    value.serialize(&serializer).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Parse a config from TOML or JSON, or fall back to the defaults.
///
/// The format is sniffed rather than declared because the same string arrives
/// from two places that disagree: a `.toml` a proctor edited by hand, and a
/// JSON blob an admin API served. Requiring the caller to say which would put
/// the choice one level further from where the mistake is made.
pub(crate) fn parse_config(config_str: Option<String>) -> Result<Config, JsValue> {
    let Some(raw) = config_str else {
        return Ok(Config::default());
    };
    if raw.trim_start().starts_with('{') {
        serde_json::from_str::<Config>(&raw)
            .map_err(|e| JsValue::from_str(&format!("Invalid config JSON: {e}")))
    } else {
        toml::from_str::<Config>(&raw)
            .map_err(|e| JsValue::from_str(&format!("Invalid config TOML: {e}")))
    }
}

/// WebAssembly wrapper for the deterministic temporal `FusionEngine`.
#[wasm_bindgen]
pub struct WasmFusionEngine {
    engine: FusionEngine,
    cfg: Config,
}

#[wasm_bindgen]
impl WasmFusionEngine {
    /// Create a new `WasmFusionEngine` with optional TOML or JSON config string.
    /// If omitted, the default config is used.
    #[wasm_bindgen(constructor)]
    pub fn new(config_str: Option<String>) -> Result<WasmFusionEngine, JsValue> {
        let cfg = parse_config(config_str)?;
        let engine = FusionEngine::new(&cfg);
        Ok(Self { engine, cfg })
    }

    /// Advance the fusion engine by one frame of signals at discrete time `t_ms`.
    /// Accepts a JavaScript `Signals` object and returns an array of `Event`s.
    pub fn step(&mut self, signals_val: JsValue, t_ms: f64) -> Result<JsValue, JsValue> {
        let signals: Signals = serde_wasm_bindgen::from_value(signals_val)
            .map_err(|e| JsValue::from_str(&format!("Failed to deserialize Signals: {e}")))?;
        let events = self.engine.step(&signals, t_ms as u64);
        to_js(&events)
    }

    /// Advance using a JSON string for signals. Returns JSON string of events.
    pub fn step_json(&mut self, signals_json: &str, t_ms: f64) -> Result<String, JsValue> {
        let signals: Signals = serde_json::from_str(signals_json)
            .map_err(|e| JsValue::from_str(&format!("Failed to parse Signals JSON: {e}")))?;
        let events = self.engine.step(&signals, t_ms as u64);
        serde_json::to_string(&events)
            .map_err(|e| JsValue::from_str(&format!("Failed to format Events JSON: {e}")))
    }

    /// Active violation kinds currently raised (deduplicated).
    pub fn active(&self) -> Result<JsValue, JsValue> {
        let kinds = self.engine.active();
        to_js(&kinds)
    }

    /// Active violations with subjects for live HUD detail.
    pub fn active_detail(&self) -> Result<JsValue, JsValue> {
        let details = self.engine.active_detail();
        to_js(&details)
    }

    /// Finish the session at discrete time `t_ms` and close any open violations.
    pub fn finish(&mut self, t_ms: f64) -> Result<JsValue, JsValue> {
        let events = self.engine.finish(t_ms as u64);
        to_js(&events)
    }

    /// Reset the fusion engine to clean state with the current config.
    pub fn reset(&mut self) {
        self.engine = FusionEngine::new(&self.cfg);
    }
}

/// WebAssembly wrapper for angular head pose and gaze direction tracking.
#[wasm_bindgen]
pub struct WasmDirectionTracker {
    tracker: DirectionTracker,
}

#[wasm_bindgen]
impl WasmDirectionTracker {
    /// Create a new `DirectionTracker` with optional enter/exit threshold degrees.
    #[wasm_bindgen(constructor)]
    pub fn new(enter_deg: Option<f64>, exit_deg: Option<f64>) -> Self {
        let mut thresholds = config::DebugDirectionThresholds::default();
        if let Some(enter) = enter_deg {
            thresholds.enter_deg = enter;
        }
        if let Some(exit) = exit_deg {
            thresholds.exit_deg = exit;
        }
        Self {
            tracker: DirectionTracker::new(&thresholds),
        }
    }

    /// Update tracking with head pose and gaze, returning direction labels.
    pub fn update(
        &mut self,
        head_yaw_deg: Option<f32>,
        head_pitch_deg: Option<f32>,
        gaze_yaw_rad: Option<f32>,
        gaze_pitch_rad: Option<f32>,
    ) -> Result<JsValue, JsValue> {
        let head_pose = match (head_yaw_deg, head_pitch_deg) {
            (Some(y), Some(p)) => Some(types::HeadPose {
                yaw_deg: y,
                pitch_deg: p,
                roll_deg: 0.0,
            }),
            _ => None,
        };

        let gaze = match (gaze_yaw_rad, gaze_pitch_rad) {
            (Some(y), Some(p)) => Some(types::Gaze {
                yaw_rad: y,
                pitch_rad: p,
                eye_yaw_rad: None,
                eye_pitch_rad: None,
            }),
            _ => None,
        };

        let debug_directions = self.tracker.update(head_pose, gaze);
        to_js(&debug_directions)
    }
}

/// Replay a batch of recorded `Signals` through the fusion engine deterministically.
#[wasm_bindgen]
pub fn replay_signals(signals_json: &str, config_str: Option<String>) -> Result<String, JsValue> {
    let signals: Vec<Signals> = serde_json::from_str(signals_json)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse Signals array: {e}")))?;

    let cfg = parse_config(config_str)?;

    let events = fusion::replay(&signals, &cfg);
    serde_json::to_string(&events)
        .map_err(|e| JsValue::from_str(&format!("Failed to format Events: {e}")))
}

/// Fast BBox Intersection-over-Union (IoU) calculation in WASM.
#[wasm_bindgen]
pub fn calculate_iou(box_a: JsValue, box_b: JsValue) -> Result<f32, JsValue> {
    let a: BBox = serde_wasm_bindgen::from_value(box_a)
        .map_err(|e| JsValue::from_str(&format!("Invalid BBox A: {e}")))?;
    let b: BBox = serde_wasm_bindgen::from_value(box_b)
        .map_err(|e| JsValue::from_str(&format!("Invalid BBox B: {e}")))?;
    Ok(a.iou(&b))
}

/// Fast Non-Maximum Suppression (NMS) in WASM.
/// Input: Array of objects `{ class_id: number, bbox: BBox, score: number }`.
/// Returns: Array of surviving candidate objects.
#[wasm_bindgen]
pub fn non_max_suppression(
    candidates_val: JsValue,
    iou_threshold: f32,
    top_k: usize,
) -> Result<JsValue, JsValue> {
    #[derive(serde::Deserialize, serde::Serialize)]
    struct Candidate {
        class_id: u32,
        bbox: BBox,
        score: f32,
    }

    let candidates: Vec<Candidate> = serde_wasm_bindgen::from_value(candidates_val)
        .map_err(|e| JsValue::from_str(&format!("Invalid candidates: {e}")))?;

    let kept = models::nms(candidates, iou_threshold, top_k, |c| {
        (c.class_id, c.bbox, c.score)
    });

    to_js(&kept)
}

/// Returns the default system configuration as a JavaScript object.
#[wasm_bindgen]
pub fn get_default_config() -> Result<JsValue, JsValue> {
    let cfg = Config::default();
    to_js(&cfg)
}

/// Validate a configuration JSON string. Returns true if valid or throws an error.
#[wasm_bindgen]
pub fn validate_config(config_json: &str) -> Result<bool, JsValue> {
    let cfg: Config = serde_json::from_str(config_json)
        .map_err(|e| JsValue::from_str(&format!("Invalid configuration: {e}")))?;
    cfg.validate()
        .map(|_| true)
        .map_err(|e| JsValue::from_str(&format!("Validation failed: {e}")))
}
