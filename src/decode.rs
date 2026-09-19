//! Output decoding, ported from `vigilo-core`'s model wrappers.
//!
//! None of these four graphs emits a finished answer. YuNet emits twelve raw
//! anchor tensors with no NMS in the graph; YOLOX emits an undecoded grid;
//! the pose model emits a rotation matrix rather than Euler angles; the gaze
//! model emits two 90-bin classification heads rather than angles. All four
//! decodes are ported from the model authors' own postprocessing rather than
//! derived, because every one of them has a convention that is not guessable
//! and whose wrong version still produces plausible-looking numbers.

use crate::models::nms;
use crate::preprocess::{Letterbox, FACE_INPUT, OBJECT_INPUT};
use crate::types::{
    BBox, FaceDetection, FaceKeypoints, GateReason, Gaze, HeadPose, ObjectDetection,
};

/// Feature-map strides both detectors predict at.
const STRIDES: [u32; 3] = [8, 16, 32];

// ---------------------------------------------------------------------------
// YuNet
// ---------------------------------------------------------------------------

/// Decode one stride's anchor grid.
///
/// YuNet is anchor-free: each cell predicts a centre offset from its own
/// top-left corner in cell units, plus log-space width and height. Confidence
/// is the geometric mean of the classification and objectness scores, which is
/// what OpenCV's own postprocess computes.
#[allow(clippy::too_many_arguments)]
pub fn decode_face_stride(
    stride: u32,
    cls: &[f32],
    obj: &[f32],
    bbox: &[f32],
    kps: &[f32],
    score_threshold: f32,
    lb: Letterbox,
    out: &mut Vec<FaceDetection>,
) {
    let cols = (FACE_INPUT / stride) as usize;
    let n = cls.len().min(obj.len()).min(bbox.len() / 4).min(kps.len() / 10);
    let stride = stride as f32;
    let inv_scale = if lb.scale > 0.0 { 1.0 / lb.scale } else { 1.0 };

    for i in 0..n {
        let score = (cls[i].clamp(0.0, 1.0) * obj[i].clamp(0.0, 1.0)).sqrt();
        if score < score_threshold {
            continue;
        }

        let (row, col) = ((i / cols) as f32, (i % cols) as f32);
        let b = &bbox[i * 4..i * 4 + 4];
        let cx = (col + b[0]) * stride;
        let cy = (row + b[1]) * stride;
        let w = b[2].exp() * stride;
        let h = b[3].exp() * stride;

        // Straight back to source pixels: a top-left letterbox means no offset
        // term, just the inverse scale.
        let k = &kps[i * 10..i * 10 + 10];
        let point = |j: usize| {
            (((col + k[j * 2]) * stride) * inv_scale, ((row + k[j * 2 + 1]) * stride) * inv_scale)
        };

        out.push(FaceDetection {
            bbox: BBox {
                x: (cx - w * 0.5) * inv_scale,
                y: (cy - h * 0.5) * inv_scale,
                w: w * inv_scale,
                h: h * inv_scale,
            },
            score,
            keypoints: Some(FaceKeypoints {
                right_eye: point(0),
                left_eye: point(1),
                nose: point(2),
                right_mouth: point(3),
                left_mouth: point(4),
            }),
        });
    }
}

/// Look up one of YuNet's twelve outputs by stride and head name.
pub type FaceTensors<'a> = dyn Fn(&str) -> Option<&'a [f32]> + 'a;

/// Decode all three strides and suppress. `get` resolves output names like
/// `cls_8` against whatever the caller got back from the inference session.
pub fn decode_faces(
    get: &FaceTensors<'_>,
    score_threshold: f32,
    nms_threshold: f32,
    top_k: usize,
    lb: Letterbox,
) -> Vec<FaceDetection> {
    let mut candidates = Vec::new();
    for stride in STRIDES {
        let (cls, obj, bbox, kps) = (
            get(&format!("cls_{stride}")),
            get(&format!("obj_{stride}")),
            get(&format!("bbox_{stride}")),
            get(&format!("kps_{stride}")),
        );
        // A missing head means this stride contributes nothing. Skipping it is
        // right where erroring would not be: the other two strides still carry
        // real detections, and a face found at stride 16 is not less true
        // because stride 32 went missing.
        if let (Some(cls), Some(obj), Some(bbox), Some(kps)) = (cls, obj, bbox, kps) {
            decode_face_stride(
                stride,
                cls,
                obj,
                bbox,
                kps,
                score_threshold,
                lb,
                &mut candidates,
            );
        }
    }
    // Faces are a single class, so the shared suppressor is handed a constant
    // class key and behaves class-agnostically.
    nms(candidates, nms_threshold, top_k, |f| (0, f.bbox, f.score))
}

// ---------------------------------------------------------------------------
// Head pose
// ---------------------------------------------------------------------------

/// Rotation matrix to Euler angles, in degrees.
///
/// Ported from the model author's `rotation_matrix_to_euler`, including the
/// singular (gimbal-lock) branch. Row-major `[r00 r01 r02 r10 r11 r12 r20 r21 r22]`.
pub fn rotation_matrix_to_euler(r: &[f32]) -> HeadPose {
    let (r00, r10) = (r[0], r[3]);
    let (r11, r12) = (r[4], r[5]);
    let (r20, r21, r22) = (r[6], r[7], r[8]);

    let sy = (r00 * r00 + r10 * r10).sqrt();
    let singular = sy < 1e-6;

    let (pitch, roll) = if singular {
        // Gimbal lock: yaw near +/-90 degrees collapses one degree of freedom,
        // so roll is unrecoverable and is reported as zero rather than as
        // noise amplified by a near-zero denominator.
        ((-r12).atan2(r11), 0.0)
    } else {
        (r21.atan2(r22), r10.atan2(r00))
    };
    let yaw = (-r20).atan2(sy);

    HeadPose {
        pitch_deg: pitch.to_degrees(),
        yaw_deg: yaw.to_degrees(),
        roll_deg: roll.to_degrees(),
    }
}

// ---------------------------------------------------------------------------
// Gaze
// ---------------------------------------------------------------------------

const BINS: usize = 90;
const BIN_WIDTH_DEG: f32 = 4.0;
const ANGLE_OFFSET_DEG: f32 = 180.0;

/// Softmax over the bins, then expectation over bin centres, in degrees.
///
/// The bin geometry is the author's, not an assumption: 90 bins of 4 degrees
/// offset by 180, spanning -180..+176. An MPIIGaze-style +/-90 span would
/// halve every angle — a signal that still moves in the right direction and
/// quietly wrecks every threshold tuned against it.
pub fn decode_bins(logits: &[f32]) -> f32 {
    let n = logits.len().min(BINS);
    if n == 0 {
        return 0.0;
    }
    let max = logits[..n].iter().copied().fold(f32::NEG_INFINITY, f32::max);
    let mut sum = 0.0;
    let mut weighted = 0.0;
    for (i, &logit) in logits[..n].iter().enumerate() {
        let e = (logit - max).exp();
        sum += e;
        weighted += e * i as f32;
    }
    if sum <= 0.0 {
        return 0.0;
    }
    (weighted / sum) * BIN_WIDTH_DEG - ANGLE_OFFSET_DEG
}

/// Combine raw gaze with head pose to get eye-in-head.
///
/// `eye = gaze - head`, in radians, which is only meaningful because both are
/// in the same camera frame and the same sign convention. Head pose is stored
/// in degrees, so the conversion happens here rather than being assumed
/// anywhere else.
pub fn assemble_gaze(yaw_rad: f32, pitch_rad: f32, head: Option<HeadPose>) -> Gaze {
    let (eye_yaw, eye_pitch) = match head {
        Some(h) => {
            (Some(yaw_rad - h.yaw_deg.to_radians()), Some(pitch_rad - h.pitch_deg.to_radians()))
        }
        None => (None, None),
    };
    Gaze { yaw_rad, pitch_rad, eye_yaw_rad: eye_yaw, eye_pitch_rad: eye_pitch }
}

/// Should gaze run on this face?
///
/// `None` means run it. `Some(reason)` means don't, and says which test failed
/// — the breakdown is what turns a bare skip rate into a diagnosis.
///
/// **This is not a blink detector.** A real eye-aspect-ratio needs eyelid
/// landmarks, and YuNet gives five points with no eyelids. What this catches
/// is the detector losing confidence or the eye keypoints collapsing, which is
/// what a blink, motion blur and a half-turned head all look like from here.
pub fn gaze_gate_reason(face: &FaceDetection, min_face_score: f32) -> Option<GateReason> {
    if face.score < min_face_score {
        return Some(GateReason::LowFaceScore);
    }
    // Without keypoints the ratio test cannot run, so gaze goes ahead. The `?`
    // returns "no gate reason", which is the permissive answer here.
    let k = face.keypoints?;
    let dx = k.left_eye.0 - k.right_eye.0;
    let dy = k.left_eye.1 - k.right_eye.1;
    let inter_eye = (dx * dx + dy * dy).sqrt();
    if face.bbox.w <= 0.0 {
        return Some(GateReason::DegenerateBox);
    }
    // Eyes sit at roughly a quarter to a half of face width apart. Outside
    // that band the keypoints are not describing a forward-facing face.
    let ratio = inter_eye / face.bbox.w;
    if ratio < 0.15 {
        Some(GateReason::EyesTooClose)
    } else if ratio > 0.75 {
        Some(GateReason::EyesTooFar)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// YOLOX
// ---------------------------------------------------------------------------

const NUM_CLASSES: usize = 80;
/// 4 box + 1 objectness + 80 classes.
const STRIDE_ELEMS: usize = 5 + NUM_CLASSES;

use crate::models::objects::COCO_CLASSES;

/// Map allowlist names to COCO class ids, ignoring case and unknown names.
pub fn resolve_allowlist(names: &[String]) -> Vec<u32> {
    names
        .iter()
        .filter_map(|name| {
            let wanted = name.trim().to_ascii_lowercase();
            COCO_CLASSES.iter().position(|c| *c == wanted).map(|i| i as u32)
        })
        .collect()
}

/// Grid decode, per YOLOX's `demo_postprocess`.
///
/// For anchor `i` at grid `(gx, gy)` with stride `s`:
/// `cx = (raw_cx + gx) * s`, `cy = (raw_cy + gy) * s`,
/// `w = exp(raw_w) * s`, `h = exp(raw_h) * s`.
pub fn decode_objects(
    data: &[f32],
    score_threshold: f32,
    letterbox_scale: f32,
    allowed: &[u32],
) -> Vec<ObjectDetection> {
    let mut out = Vec::new();
    let inv_scale = if letterbox_scale > 0.0 { 1.0 / letterbox_scale } else { 1.0 };

    let mut offset = 0usize;
    for stride in STRIDES {
        let cells = (OBJECT_INPUT / stride) as usize;
        let stride_f = stride as f32;

        for i in 0..cells * cells {
            let base = (offset + i) * STRIDE_ELEMS;
            if base + STRIDE_ELEMS > data.len() {
                return out;
            }
            let objectness = data[base + 4];
            if objectness < score_threshold {
                continue; // cheap reject before scanning 80 classes
            }

            // Grid is row-major: meshgrid(arange(w), arange(h)) stacked.
            let (gy, gx) = ((i / cells) as f32, (i % cells) as f32);

            let mut best_class = 0usize;
            let mut best_prob = 0.0f32;
            for c in 0..NUM_CLASSES {
                let p = data[base + 5 + c];
                if p > best_prob {
                    best_prob = p;
                    best_class = c;
                }
            }

            let score = objectness * best_prob;
            if score < score_threshold {
                continue;
            }
            let class_id = best_class as u32;
            if !allowed.contains(&class_id) {
                continue;
            }

            let cx = (data[base] + gx) * stride_f;
            let cy = (data[base + 1] + gy) * stride_f;
            let w = data[base + 2].exp() * stride_f;
            let h = data[base + 3].exp() * stride_f;

            out.push(ObjectDetection {
                class_id,
                label: COCO_CLASSES[best_class].to_string(),
                score,
                bbox: BBox {
                    x: (cx - w * 0.5) * inv_scale,
                    y: (cy - h * 0.5) * inv_scale,
                    w: w * inv_scale,
                    h: h * inv_scale,
                },
            });
        }
        offset += cells * cells;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // -- YuNet ------------------------------------------------------------

    #[test]
    fn face_decode_maps_a_hit_back_through_the_letterbox() {
        // One anchor at grid (row 1, col 2), stride 32, on a frame that was
        // downscaled by half: the box must come back in source pixels, doubled.
        let cols = (FACE_INPUT / 32) as usize;
        let n = cols * cols;
        let mut cls = vec![0.0; n];
        let mut obj = vec![0.0; n];
        let bbox = vec![0.0; n * 4];
        let kps = vec![0.0; n * 10];

        let i = cols + 2;
        cls[i] = 1.0;
        obj[i] = 1.0;

        let mut out = Vec::new();
        let lb = Letterbox { scale: 0.5, width: 640, height: 360 };
        decode_face_stride(32, &cls, &obj, &bbox, &kps, 0.5, lb, &mut out);

        assert_eq!(out.len(), 1);
        let d = &out[0];
        assert!((d.score - 1.0).abs() < 1e-6);
        // cx = (2 + 0) * 32 = 64, w = e^0 * 32 = 32 -> x = 48; /0.5 -> 96
        assert!((d.bbox.x - 96.0).abs() < 1e-3, "got {}", d.bbox.x);
        assert!((d.bbox.y - 32.0).abs() < 1e-3, "got {}", d.bbox.y);
        assert!((d.bbox.w - 64.0).abs() < 1e-3, "got {}", d.bbox.w);
    }

    #[test]
    fn face_decode_drops_everything_below_threshold() {
        let cols = (FACE_INPUT / 32) as usize;
        let n = cols * cols;
        let mut out = Vec::new();
        decode_face_stride(
            32,
            &vec![0.4; n],
            &vec![0.4; n],
            &vec![0.0; n * 4],
            &vec![0.0; n * 10],
            0.5,
            Letterbox { scale: 1.0, width: 640, height: 640 },
            &mut out,
        );
        assert!(out.is_empty(), "score 0.4 must not survive a 0.5 threshold");
    }

    #[test]
    fn a_missing_stride_head_does_not_lose_the_other_strides() {
        let cols8 = (FACE_INPUT / 8) as usize;
        let n8 = cols8 * cols8;
        let cls8 = vec![1.0; n8];
        let obj8 = vec![1.0; n8];
        let bbox8 = vec![0.0; n8 * 4];
        let kps8 = vec![0.0; n8 * 10];

        let faces = decode_faces(
            &|name: &str| match name {
                "cls_8" => Some(cls8.as_slice()),
                "obj_8" => Some(obj8.as_slice()),
                "bbox_8" => Some(bbox8.as_slice()),
                "kps_8" => Some(kps8.as_slice()),
                _ => None, // strides 16 and 32 absent
            },
            0.5,
            0.3,
            10,
            Letterbox { scale: 1.0, width: 640, height: 640 },
        );
        assert!(!faces.is_empty(), "stride 8 detections must survive missing 16/32");
    }

    // -- Head pose --------------------------------------------------------

    fn ry(deg: f32) -> [f32; 9] {
        let (s, c) = deg.to_radians().sin_cos();
        [c, 0.0, s, 0.0, 1.0, 0.0, -s, 0.0, c]
    }
    fn rx(deg: f32) -> [f32; 9] {
        let (s, c) = deg.to_radians().sin_cos();
        [1.0, 0.0, 0.0, 0.0, c, -s, 0.0, s, c]
    }
    fn rz(deg: f32) -> [f32; 9] {
        let (s, c) = deg.to_radians().sin_cos();
        [c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0]
    }

    #[test]
    fn each_axis_maps_to_its_own_angle_with_the_right_sign() {
        let yawed = rotation_matrix_to_euler(&ry(30.0));
        assert!((yawed.yaw_deg - 30.0).abs() < 1e-2, "yaw was {}", yawed.yaw_deg);
        assert!(yawed.pitch_deg.abs() < 1e-2);

        let pitched = rotation_matrix_to_euler(&rx(20.0));
        assert!((pitched.pitch_deg - 20.0).abs() < 1e-2, "pitch was {}", pitched.pitch_deg);

        let rolled = rotation_matrix_to_euler(&rz(15.0));
        assert!((rolled.roll_deg - 15.0).abs() < 1e-2, "roll was {}", rolled.roll_deg);
    }

    #[test]
    fn gimbal_lock_does_not_produce_garbage() {
        let p = rotation_matrix_to_euler(&ry(90.0));
        assert!((p.yaw_deg.abs() - 90.0).abs() < 1e-2, "yaw was {}", p.yaw_deg);
        assert!(p.roll_deg.abs() < 1e-3, "roll should collapse to 0, got {}", p.roll_deg);
        assert!(p.pitch_deg.is_finite());
    }

    // -- Gaze -------------------------------------------------------------

    fn one_hot(bin: usize) -> Vec<f32> {
        let mut v = vec![-30.0; BINS];
        v[bin] = 30.0;
        v
    }

    #[test]
    fn a_single_dominant_bin_decodes_to_its_own_centre() {
        assert!(decode_bins(&one_hot(45)).abs() < 0.5);
        assert!((decode_bins(&one_hot(0)) + 180.0).abs() < 0.5);
        assert!((decode_bins(&one_hot(89)) - 176.0).abs() < 0.5);
    }

    #[test]
    fn the_span_is_plus_minus_180_not_plus_minus_90() {
        // If someone "fixes" the constants to an MPIIGaze-style span, this
        // fails loudly instead of silently halving every angle.
        let full_span = decode_bins(&one_hot(89)) - decode_bins(&one_hot(0));
        assert!(full_span > 300.0, "span was {full_span}, expected ~356 degrees");
    }

    #[test]
    fn eye_in_head_is_the_difference_and_is_absent_without_pose() {
        let head = HeadPose { yaw_deg: 30.0, pitch_deg: 0.0, roll_deg: 0.0 };
        let g = assemble_gaze(30f32.to_radians(), 0.0, Some(head));
        assert!(g.eye_yaw_rad.unwrap().abs() < 1e-5);

        // Without pose there is no eye-in-head to report — `None`, not zero,
        // because zero would read as "eyes centred".
        let g = assemble_gaze(0.3, 0.1, None);
        assert!(g.eye_yaw_rad.is_none() && g.eye_pitch_rad.is_none());
    }

    fn face(score: f32, inter_eye: f32, width: f32) -> FaceDetection {
        FaceDetection {
            bbox: BBox { x: 0.0, y: 0.0, w: width, h: width },
            score,
            keypoints: Some(FaceKeypoints {
                right_eye: (0.0, 0.0),
                left_eye: (inter_eye, 0.0),
                nose: (0.0, 0.0),
                right_mouth: (0.0, 0.0),
                left_mouth: (0.0, 0.0),
            }),
        }
    }

    #[test]
    fn the_reliability_gate_rejects_low_scores_and_collapsed_eyes() {
        assert_eq!(gaze_gate_reason(&face(0.95, 40.0, 100.0), 0.6), None);
        assert_eq!(gaze_gate_reason(&face(0.10, 40.0, 100.0), 0.6), Some(GateReason::LowFaceScore));
        assert_eq!(gaze_gate_reason(&face(0.95, 2.0, 100.0), 0.6), Some(GateReason::EyesTooClose));
        assert_eq!(gaze_gate_reason(&face(0.95, 90.0, 100.0), 0.6), Some(GateReason::EyesTooFar));
    }

    // -- YOLOX ------------------------------------------------------------

    #[test]
    fn the_anchor_count_matches_the_declared_output() {
        let total: usize = STRIDES.iter().map(|s| ((OBJECT_INPUT / s) as usize).pow(2)).sum();
        assert_eq!(total, 3549, "anchor layout disagrees with the inspected shape");
    }

    #[test]
    fn allowlist_resolves_to_the_right_coco_ids() {
        let ids = resolve_allowlist(&["cell phone".into(), "book".into()]);
        assert_eq!(ids, vec![67, 73]);
    }

    #[test]
    fn unknown_allowlist_names_are_dropped_not_guessed() {
        assert!(resolve_allowlist(&["telephone".into()]).is_empty());
    }

    #[test]
    fn object_decode_finds_a_planted_phone_and_respects_the_allowlist() {
        let mut data = vec![0.0f32; 3549 * STRIDE_ELEMS];
        // Anchor 0 sits at stride 8, grid (0, 0).
        data[4] = 0.9; // objectness
        data[5 + 67] = 0.9; // cell phone
        data[2] = 0.0; // log w
        data[3] = 0.0; // log h

        let found = decode_objects(&data, 0.3, 1.0, &[67]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].label, "cell phone");

        // Same tensor, allowlist that excludes phones: nothing survives.
        assert!(decode_objects(&data, 0.3, 1.0, &[73]).is_empty());
    }

    #[test]
    fn object_decode_stops_cleanly_on_a_truncated_tensor() {
        // A short tensor is a model/runtime mismatch, not a reason to panic in
        // the middle of an exam.
        let data = vec![0.5f32; 100];
        let _ = decode_objects(&data, 0.3, 1.0, &[67]);
    }
}
