//! Models helper module: COCO class registry and geometric post-processing.

pub mod objects {
    pub const NUM_CLASSES: usize = 80;

    /// COCO class names in the order YOLOX / YOLO models emit them.
    pub const COCO_CLASSES: [&str; NUM_CLASSES] = [
        "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat",
        "traffic light", "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog",
        "horse", "sheep", "cow", "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella",
        "handbag", "tie", "suitcase", "frisbee", "skis", "snowboard", "sports ball", "kite",
        "baseball bat", "baseball glove", "skateboard", "surfboard", "tennis racket", "bottle",
        "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple", "sandwich",
        "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
        "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote",
        "keyboard", "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book",
        "clock", "vase", "scissors", "teddy bear", "hair drier", "toothbrush",
    ];
}

/// Greedy non-maximum suppression (NMS) within each class or class-agnostic.
pub fn nms<T>(
    mut items: Vec<T>,
    iou_threshold: f32,
    top_k: usize,
    key: impl Fn(&T) -> (u32, crate::types::BBox, f32),
) -> Vec<T> {
    items.sort_by(|a, b| {
        key(b).2.partial_cmp(&key(a).2).unwrap_or(std::cmp::Ordering::Equal)
    });
    items.truncate(top_k);

    let mut kept: Vec<T> = Vec::new();
    for candidate in items {
        let (cls, bbox, _) = key(&candidate);
        let suppressed = kept.iter().any(|k| {
            let (kept_cls, kept_bbox, _) = key(k);
            kept_cls == cls && kept_bbox.iou(&bbox) > iou_threshold
        });
        if !suppressed {
            kept.push(candidate);
        }
    }
    kept
}
