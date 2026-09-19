/**
 * Webcam capture — the browser's replacement for `vigilo-core`'s `capture/`.
 *
 * The native crate opens DirectShow devices and shells out to ffmpeg for
 * files. None of that survives the port, and none of it needs to: a browser
 * already has a capture stack, and `getUserMedia` hands over a stream that is
 * already decoded, already the right pixel format, and already permissioned.
 *
 * What does survive is the rule the frame bus existed to enforce — **a slow
 * consumer drops frames rather than queueing them**. There is no buffer here
 * at all: `grab()` samples whatever the camera is showing right now. A
 * detection loop that falls behind sees a newer frame next time, never a
 * backlog of stale ones, which is the property that keeps latency bounded when
 * inference is slower than the camera.
 */

export interface CameraOptions {
  /** Requested capture width. The browser may hand back something else. */
  width?: number;
  /** Requested capture height. */
  height?: number;
  frameRate?: number;
  /** Pick a specific camera, from `navigator.mediaDevices.enumerateDevices()`. */
  deviceId?: string;
  /** `'user'` for the selfie camera, which is what proctoring wants. */
  facingMode?: 'user' | 'environment';
  /**
   * Render into this element. Supply the one already in your page if you are
   * drawing an overlay over it; otherwise a detached element is created and
   * played muted, which is enough to keep frames flowing.
   */
  video?: HTMLVideoElement;
}

const DEFAULTS = {
  // Matches `CaptureConfig::default()` in the native crate, so a crop fed to
  // the pose and gaze models carries the same detail it does on the desktop.
  // If preprocessing shows up hot in the latency HUD, this is the first knob:
  // 640x480 roughly halves the per-frame pixel cost.
  width: 1280,
  height: 720,
  frameRate: 30,
  facingMode: 'user' as const,
};

/** A live camera, sampled on demand. */
export class CameraSource {
  readonly video: HTMLVideoElement;
  readonly stream: MediaStream;

  private canvas: OffscreenCanvas | HTMLCanvasElement;
  private ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  private ownsVideo: boolean;
  private closed = false;

  private constructor(
    video: HTMLVideoElement,
    stream: MediaStream,
    ownsVideo: boolean,
    width: number,
    height: number
  ) {
    this.video = video;
    this.stream = stream;
    this.ownsVideo = ownsVideo;

    const canvas = makeCanvas(width, height);
    // `willReadFrequently` is not a micro-optimization here. Without it the
    // browser keeps the canvas on the GPU and every `getImageData` becomes a
    // synchronous readback — tens of milliseconds, every frame, which is more
    // than the face model costs.
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      throw new Error('could not get a 2d context for frame capture');
    }
    this.canvas = canvas;
    this.ctx = ctx as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
  }

  /** Request camera access and wait until frames are actually flowing. */
  static async open(options: CameraOptions = {}): Promise<CameraSource> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'getUserMedia is unavailable — a camera needs a secure context (https:// or localhost)'
      );
    }

    const width = options.width ?? DEFAULTS.width;
    const height = options.height ?? DEFAULTS.height;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        // `ideal`, not `exact`: a camera that cannot do 1280x720 should give
        // its closest mode, not throw `OverconstrainedError` and leave the
        // session with no video at all.
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: options.frameRate ?? DEFAULTS.frameRate },
        ...(options.deviceId
          ? { deviceId: { exact: options.deviceId } }
          : { facingMode: options.facingMode ?? DEFAULTS.facingMode }),
      },
    });

    const ownsVideo = !options.video;
    const video = options.video ?? document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await frameReady(video);

    return new CameraSource(
      video,
      stream,
      ownsVideo,
      video.videoWidth || width,
      video.videoHeight || height
    );
  }

  get width(): number {
    return this.canvas.width;
  }

  get height(): number {
    return this.canvas.height;
  }

  /**
   * Sample the current frame as RGBA.
   *
   * The returned `ImageData` wraps a buffer this object reuses — copy it if
   * you intend to keep it past the next `grab()`.
   */
  grab(): ImageData {
    if (this.closed) {
      throw new Error('camera is closed');
    }
    // The camera can change resolution mid-stream (a driver renegotiating, a
    // tab moving to a different display). Following it keeps the frame
    // dimensions honest rather than silently scaling.
    if (
      this.video.videoWidth &&
      (this.canvas.width !== this.video.videoWidth ||
        this.canvas.height !== this.video.videoHeight)
    ) {
      this.canvas.width = this.video.videoWidth;
      this.canvas.height = this.video.videoHeight;
    }
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    return this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
  }

  /** Stop the camera. The browser's in-use indicator goes out here. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const track of this.stream.getTracks()) {
      track.stop();
    }
    if (this.ownsVideo) {
      this.video.srcObject = null;
    }
  }
}

function makeCanvas(width: number, height: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Wait for a frame that actually has pixels.
 *
 * `play()` resolving is not the same as the first frame having arrived —
 * `videoWidth` is still 0 for a moment afterwards, and a capture taken then is
 * a 0x0 image that fails deep inside preprocessing.
 */
function frameReady(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= 2 && video.videoWidth > 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('camera produced no frames within 10s'));
    }, 10_000);

    const done = () => {
      if (video.videoWidth > 0) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      video.removeEventListener('loadeddata', done);
      video.removeEventListener('playing', done);
    };

    video.addEventListener('loadeddata', done);
    video.addEventListener('playing', done);
  });
}
