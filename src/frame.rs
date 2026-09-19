//! The one frame the pipeline is currently looking at.
//!
//! Browsers hand out pixels as **RGBA** — `CanvasRenderingContext2D.getImageData`
//! and `VideoFrame.copyTo` both do. Every model here wants tightly packed
//! **RGB8**, which is what `vigilo-core`'s `Frame` carries. The conversion is
//! one pass over the buffer and it happens exactly once per frame, here,
//! rather than once per model.

use crate::error::{DetectError, Result};

/// A decoded camera frame in tightly packed RGB8.
///
/// Reused across frames: `set_rgba` and `set_rgb` write into the existing
/// allocation whenever the dimensions have not changed, because a per-frame
/// 2.7 MB allocation at 15 Hz is pure GC pressure on the wasm heap.
#[derive(Default)]
pub struct FrameBuf {
    pub rgb: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub seq: u64,
}

impl FrameBuf {
    pub fn is_empty(&self) -> bool {
        self.width == 0 || self.height == 0 || self.rgb.is_empty()
    }

    pub fn expected_len(&self) -> usize {
        self.width as usize * self.height as usize * 3
    }

    /// Ingest RGBA as produced by `getImageData` / `VideoFrame.copyTo`.
    ///
    /// Alpha is dropped rather than composited: a camera frame is opaque, and
    /// premultiplying against an imaginary background would only introduce a
    /// difference between this path and the native one.
    pub fn set_rgba(&mut self, data: &[u8], width: u32, height: u32) -> Result<()> {
        let pixels = width as usize * height as usize;
        if data.len() < pixels * 4 {
            return Err(DetectError::Config(format!(
                "RGBA buffer is {} bytes, expected {} for {width}x{height}",
                data.len(),
                pixels * 4
            )));
        }
        self.resize_to(width, height);
        for i in 0..pixels {
            let (s, d) = (i * 4, i * 3);
            self.rgb[d] = data[s];
            self.rgb[d + 1] = data[s + 1];
            self.rgb[d + 2] = data[s + 2];
        }
        self.seq = self.seq.wrapping_add(1);
        Ok(())
    }

    /// Ingest frames that are already tightly packed RGB8.
    pub fn set_rgb(&mut self, data: &[u8], width: u32, height: u32) -> Result<()> {
        let expected = width as usize * height as usize * 3;
        if data.len() < expected {
            return Err(DetectError::Config(format!(
                "RGB buffer is {} bytes, expected {expected} for {width}x{height}",
                data.len()
            )));
        }
        self.resize_to(width, height);
        self.rgb.copy_from_slice(&data[..expected]);
        self.seq = self.seq.wrapping_add(1);
        Ok(())
    }

    fn resize_to(&mut self, width: u32, height: u32) {
        let needed = width as usize * height as usize * 3;
        if self.width != width || self.height != height || self.rgb.len() != needed {
            self.rgb = vec![0; needed];
            self.width = width;
            self.height = height;
        }
    }

    /// Guard every preprocessor shares: a model must never be handed a frame
    /// that was never set, because the resulting detections would be of a
    /// black image and would look like a perfectly good "candidate absent".
    pub fn check_ready(&self) -> Result<()> {
        if self.is_empty() {
            return Err(DetectError::Config(
                "no frame set — call set_frame_rgba() before preprocessing".into(),
            ));
        }
        Ok(())
    }
}
