//! Tensor preparation, ported from `vigilo-core`'s model wrappers.
//!
//! This is the half of each `models/*.rs` that never touched ONNX Runtime:
//! letterbox, crop, resize, and pack into NCHW. Inference itself is the
//! browser's job (`onnxruntime-web`), so the split is exactly at the tensor
//! boundary — wasm produces the input tensor, JS runs the graph, wasm decodes
//! the output.
//!
//! The four models disagree with each other on **every** preprocessing
//! decision, and every one of those disagreements is load-bearing:
//!
//! | Model | Input | Channel order | Normalization | Pad |
//! |---|---|---|---|---|
//! | YuNet | 640x640 | BGR | none (raw 0-255) | black |
//! | HeadPose | 224x224 | RGB | /255 then ImageNet mean/std | n/a (crop) |
//! | Gaze | 448x448 | RGB | /255 then ImageNet mean/std | n/a (crop) |
//! | YOLOX | 416x416 | BGR | none (raw 0-255) | 114 |
//!
//! "Making them consistent" would break three of the four silently — the
//! signals keep moving in roughly the right direction, which is what makes it
//! so expensive to find later.

use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};

use crate::error::{DetectError, Result};
use crate::frame::FrameBuf;
use crate::types::BBox;

pub const FACE_INPUT: u32 = 640;
pub const POSE_INPUT: u32 = 224;
pub const GAZE_INPUT: u32 = 448;
pub const OBJECT_INPUT: u32 = 416;

/// ImageNet statistics, used by the pose and gaze models only.
const MEAN: [f32; 3] = [0.485, 0.456, 0.406];
const STD: [f32; 3] = [0.229, 0.224, 0.225];

/// YOLOX pads with neutral grey, not black.
const PAD_VALUE: u8 = 114;

/// What a top-left letterbox did, so the decoder can undo it.
///
/// Top-left placement rather than centred: undoing it is one divide by
/// `scale` with no offset term, which is two fewer things to get wrong.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Letterbox {
    pub scale: f32,
    pub width: u32,
    pub height: u32,
}

fn bilinear() -> ResizeOptions {
    // Bilinear, not Lanczos3: these are downscales feeding detectors, and the
    // extra taps cost more than they buy.
    ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Bilinear))
}

fn source(frame: &FrameBuf) -> Result<ImageRef<'_>> {
    ImageRef::new(frame.width, frame.height, &frame.rgb, PixelType::U8x3)
        .map_err(|e| DetectError::Config(format!("source image: {e}")))
}

/// Expanded, squared, frame-clamped crop around a face, in source pixels.
///
/// Squared before expansion so the aspect ratio the model sees does not depend
/// on how tall the detector happened to make the box.
pub fn square_crop(bbox: &BBox, frame_w: u32, frame_h: u32, expand: f32) -> (f64, f64, f64, f64) {
    let (cx, cy) = bbox.center();
    let side = bbox.w.max(bbox.h) * (1.0 + 2.0 * expand);
    let half = side * 0.5;

    let x0 = (cx - half).max(0.0);
    let y0 = (cy - half).max(0.0);
    let x1 = (cx + half).min(frame_w as f32);
    let y1 = (cy + half).min(frame_h as f32);

    let w = (x1 - x0).max(1.0);
    let h = (y1 - y0).max(1.0);
    (x0 as f64, y0 as f64, w as f64, h as f64)
}

/// Face box clamped to the frame, with no expansion — what the gaze reference
/// feeds its model, unlike the pose model which wants a wider crop.
fn tight_crop(bbox: &BBox, frame_w: u32, frame_h: u32) -> (f64, f64, f64, f64) {
    let x0 = bbox.x.max(0.0);
    let y0 = bbox.y.max(0.0);
    let x1 = (bbox.x + bbox.w).min(frame_w as f32);
    let y1 = (bbox.y + bbox.h).min(frame_h as f32);
    let w = (x1 - x0).max(1.0);
    let h = (y1 - y0).max(1.0);
    (x0 as f64, y0 as f64, w as f64, h as f64)
}

/// Write a scaled RGB image into the top-left of a planar NCHW tensor.
fn pack_planar(tensor: &mut [f32], side: usize, px: &[u8], w: usize, h: usize, bgr: bool) {
    let plane = side * side;
    for y in 0..h {
        let src_row = y * w * 3;
        let dst_row = y * side;
        for x in 0..w {
            let s = src_row + x * 3;
            let d = dst_row + x;
            let (r, g, b) = (px[s] as f32, px[s + 1] as f32, px[s + 2] as f32);
            if bgr {
                tensor[d] = b;
                tensor[plane + d] = g;
                tensor[2 * plane + d] = r;
            } else {
                tensor[d] = r;
                tensor[plane + d] = g;
                tensor[2 * plane + d] = b;
            }
        }
    }
}

/// Planar RGB with `/255` then ImageNet mean/std, over a full square crop.
fn pack_imagenet(tensor: &mut [f32], side: usize, px: &[u8]) {
    let plane = side * side;
    for i in 0..plane {
        let s = i * 3;
        for c in 0..3 {
            tensor[c * plane + i] = ((px[s + c] as f32 / 255.0) - MEAN[c]) / STD[c];
        }
    }
}

/// Shared scratch: one resizer and one scaled-image buffer per model, because
/// allocating either per frame is pure hot-loop pressure.
struct Scratch {
    resizer: Resizer,
    scaled: Image<'static>,
    tensor: Vec<f32>,
}

impl Scratch {
    fn new(side: u32) -> Self {
        let s = side as usize;
        Self {
            resizer: Resizer::new(),
            scaled: Image::new(side, side, PixelType::U8x3),
            tensor: vec![0.0; 3 * s * s],
        }
    }
}

/// YuNet: letterbox to 640x640, planar **BGR**, no normalization.
///
/// YuNet was trained through OpenCV, whose `blobFromImage` hands over BGR with
/// no scaling and no mean subtraction. Flip that and detection degrades rather
/// than vanishes — exactly the kind of bug that survives a smoke test.
pub struct FacePre {
    scratch: Scratch,
    pub letterbox: Letterbox,
}

impl Default for FacePre {
    fn default() -> Self {
        Self { scratch: Scratch::new(FACE_INPUT), letterbox: Letterbox::default() }
    }
}

impl FacePre {
    pub fn prepare(&mut self, frame: &FrameBuf) -> Result<&[f32]> {
        frame.check_ready()?;
        let side = FACE_INPUT;

        let scale = (side as f32 / frame.width as f32).min(side as f32 / frame.height as f32);
        let new_w = ((frame.width as f32 * scale).round() as u32).clamp(1, side);
        let new_h = ((frame.height as f32 * scale).round() as u32).clamp(1, side);
        self.letterbox = Letterbox { scale, width: new_w, height: new_h };

        let src = source(frame)?;
        if self.scratch.scaled.width() != new_w || self.scratch.scaled.height() != new_h {
            self.scratch.scaled = Image::new(new_w, new_h, PixelType::U8x3);
        }
        self.scratch
            .resizer
            .resize(&src, &mut self.scratch.scaled, &bilinear())
            .map_err(|e| DetectError::Config(format!("face resize: {e}")))?;

        self.scratch.tensor.fill(0.0);
        pack_planar(
            &mut self.scratch.tensor,
            side as usize,
            self.scratch.scaled.buffer(),
            new_w as usize,
            new_h as usize,
            true,
        );
        Ok(&self.scratch.tensor)
    }
}

/// Head pose: square expanded crop to 224x224, planar **RGB**, ImageNet norm.
///
/// Head-pose models are sensitive to how the head sits in the frame: a tight
/// face box crops the skull and jaw the model was trained to see, and accuracy
/// degrades quietly rather than obviously.
pub struct PosePre {
    scratch: Scratch,
}

impl Default for PosePre {
    fn default() -> Self {
        Self { scratch: Scratch::new(POSE_INPUT) }
    }
}

impl PosePre {
    pub fn prepare(&mut self, frame: &FrameBuf, bbox: &BBox, crop_expand: f32) -> Result<&[f32]> {
        frame.check_ready()?;
        let (left, top, width, height) = square_crop(bbox, frame.width, frame.height, crop_expand);
        let src = source(frame)?;

        // Crop and resize in one pass — no intermediate buffer for the crop.
        self.scratch
            .resizer
            .resize(&src, &mut self.scratch.scaled, &bilinear().crop(left, top, width, height))
            .map_err(|e| DetectError::Config(format!("pose crop/resize: {e}")))?;

        pack_imagenet(&mut self.scratch.tensor, POSE_INPUT as usize, self.scratch.scaled.buffer());
        Ok(&self.scratch.tensor)
    }
}

/// Gaze: tight face crop to 448x448, planar **RGB**, ImageNet norm.
pub struct GazePre {
    scratch: Scratch,
}

impl Default for GazePre {
    fn default() -> Self {
        Self { scratch: Scratch::new(GAZE_INPUT) }
    }
}

impl GazePre {
    pub fn prepare(&mut self, frame: &FrameBuf, bbox: &BBox) -> Result<&[f32]> {
        frame.check_ready()?;
        let (left, top, width, height) = tight_crop(bbox, frame.width, frame.height);
        let src = source(frame)?;

        self.scratch
            .resizer
            .resize(&src, &mut self.scratch.scaled, &bilinear().crop(left, top, width, height))
            .map_err(|e| DetectError::Config(format!("gaze crop/resize: {e}")))?;

        pack_imagenet(&mut self.scratch.tensor, GAZE_INPUT as usize, self.scratch.scaled.buffer());
        Ok(&self.scratch.tensor)
    }
}

/// YOLOX: letterbox to 416x416 padded with 114, planar **BGR**, no normalization.
///
/// YOLOX removed mean/std subtraction; the input is raw 0-255 as float.
/// Dividing by 255 "for consistency" with the pose and gaze models breaks it
/// quietly.
pub struct ObjectPre {
    scratch: Scratch,
    pub letterbox: Letterbox,
}

impl Default for ObjectPre {
    fn default() -> Self {
        Self { scratch: Scratch::new(OBJECT_INPUT), letterbox: Letterbox::default() }
    }
}

impl ObjectPre {
    pub fn prepare(&mut self, frame: &FrameBuf) -> Result<&[f32]> {
        frame.check_ready()?;
        let side = OBJECT_INPUT;

        let scale = (side as f32 / frame.width as f32).min(side as f32 / frame.height as f32);
        // Truncated, not rounded — YOLOX's own `preproc` truncates, and a
        // one-pixel disagreement here shifts every decoded box by a subpixel.
        let new_w = ((frame.width as f32 * scale) as u32).clamp(1, side);
        let new_h = ((frame.height as f32 * scale) as u32).clamp(1, side);
        self.letterbox = Letterbox { scale, width: new_w, height: new_h };

        let src = source(frame)?;
        if self.scratch.scaled.width() != new_w || self.scratch.scaled.height() != new_h {
            self.scratch.scaled = Image::new(new_w, new_h, PixelType::U8x3);
        }
        self.scratch
            .resizer
            .resize(&src, &mut self.scratch.scaled, &bilinear())
            .map_err(|e| DetectError::Config(format!("object resize: {e}")))?;

        self.scratch.tensor.fill(PAD_VALUE as f32);
        pack_planar(
            &mut self.scratch.tensor,
            side as usize,
            self.scratch.scaled.buffer(),
            new_w as usize,
            new_h as usize,
            true,
        );
        Ok(&self.scratch.tensor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_is_square_expanded_and_clamped() {
        let bbox = BBox { x: 400.0, y: 200.0, w: 100.0, h: 140.0 };
        let (x, y, w, h) = square_crop(&bbox, 1280, 720, 0.25);
        assert!((w - 210.0).abs() < 1.0, "w was {w}");
        assert!((h - 210.0).abs() < 1.0, "h was {h}");
        assert!((x + w / 2.0 - 450.0).abs() < 1.0);
        assert!((y + h / 2.0 - 270.0).abs() < 1.0);
    }

    #[test]
    fn a_face_at_the_frame_edge_still_yields_a_valid_crop() {
        let bbox = BBox { x: 0.0, y: 0.0, w: 80.0, h: 80.0 };
        let (x, y, w, h) = square_crop(&bbox, 1280, 720, 0.25);
        assert!(x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0);
        assert!(x + w <= 1280.0 && y + h <= 720.0);
    }

    fn gradient_frame(w: u32, h: u32) -> FrameBuf {
        let mut f = FrameBuf::default();
        // A gradient, not a constant: a constant image cannot catch a
        // transposed or mis-strided pack.
        let mut rgba = vec![255u8; (w * h * 4) as usize];
        for i in 0..(w * h) as usize {
            rgba[i * 4] = (i % 256) as u8;
            rgba[i * 4 + 1] = ((i / 7) % 256) as u8;
            rgba[i * 4 + 2] = ((i / 13) % 256) as u8;
        }
        f.set_rgba(&rgba, w, h).unwrap();
        f
    }

    #[test]
    fn face_tensor_is_letterboxed_bgr_with_black_padding() {
        let frame = gradient_frame(640, 360);
        let mut pre = FacePre::default();
        let tensor = pre.prepare(&frame).unwrap().to_vec();

        assert_eq!(tensor.len(), 3 * 640 * 640);
        assert_eq!(pre.letterbox.height, 360, "16:9 at 640 wide must not be padded sideways");
        // Row 400 is below the image and must still be the black pad.
        let plane = 640 * 640;
        let below = 400 * 640 + 10;
        assert_eq!(tensor[below], 0.0);
        assert_eq!(tensor[plane + below], 0.0);
    }

    #[test]
    fn face_tensor_carries_blue_in_plane_zero() {
        // A flat colour, so resampling cannot be blamed for a channel mismatch.
        let mut frame = FrameBuf::default();
        let rgba: Vec<u8> = (0..640 * 360).flat_map(|_| [200u8, 100, 50, 255]).collect();
        frame.set_rgba(&rgba, 640, 360).unwrap();

        let mut pre = FacePre::default();
        let tensor = pre.prepare(&frame).unwrap();
        let plane = 640 * 640;
        let d = 100 * 640 + 100;
        assert!((tensor[d] - 50.0).abs() < 1.0, "plane 0 must be blue, got {}", tensor[d]);
        assert!((tensor[plane + d] - 100.0).abs() < 1.0, "plane 1 must be green");
        assert!((tensor[2 * plane + d] - 200.0).abs() < 1.0, "plane 2 must be red");
    }

    #[test]
    fn object_tensor_pads_with_114_not_black() {
        let frame = gradient_frame(640, 360);
        let mut pre = ObjectPre::default();
        let tensor = pre.prepare(&frame).unwrap();

        assert_eq!(tensor.len(), 3 * 416 * 416);
        let below = 400 * 416 + 10;
        assert_eq!(tensor[below], 114.0, "YOLOX pads with neutral grey");
    }

    #[test]
    fn imagenet_normalized_tensors_leave_the_raw_range() {
        let frame = gradient_frame(640, 360);
        let bbox = BBox { x: 100.0, y: 50.0, w: 120.0, h: 120.0 };

        let mut pose = PosePre::default();
        let t = pose.prepare(&frame, &bbox, 0.25).unwrap();
        assert_eq!(t.len(), 3 * 224 * 224);
        assert!(t.iter().all(|v| v.abs() < 5.0), "normalized values must be small");
        assert!(t.iter().any(|v| *v < 0.0), "mean subtraction must produce negatives");

        let mut gaze = GazePre::default();
        let t = gaze.prepare(&frame, &bbox).unwrap();
        assert_eq!(t.len(), 3 * 448 * 448);
        assert!(t.iter().all(|v| v.abs() < 5.0));
    }

    #[test]
    fn preprocessing_without_a_frame_is_an_error_not_a_black_image() {
        // A black frame would decode to "no face", which fusion would read as
        // the candidate having left — a false positive manufactured by a bug.
        let empty = FrameBuf::default();
        assert!(FacePre::default().prepare(&empty).is_err());
    }
}
