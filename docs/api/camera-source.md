# CameraSource

Manages webcam capture via `navigator.mediaDevices.getUserMedia` and renders frames into an unbuffered 2D canvas context with `willReadFrequently: true`.

```ts
import { CameraSource } from 'vigilo-wasm';
```

---

## Static Methods

### `CameraSource.open(options?: CameraOptions): Promise<CameraSource>`
Requests webcam access from the browser, plays the stream into an internal or provided `<video>` element, and waits until the first frame is ready.

```ts
const camera = await CameraSource.open({
  width: 1280,
  height: 720,
  frameRate: 30,
  facingMode: 'user',
});
```

#### `CameraOptions`

| Field | Type | Default | Description |
|---|---|---|---|
| `width` | `number` | `1280` | Ideal capture width. |
| `height` | `number` | `720` | Ideal capture height. |
| `frameRate` | `number` | `30` | Ideal frames per second. |
| `facingMode` | `'user' \| 'environment'` | `'user'` | Camera facing mode (`'user'` = front-facing selfie). |
| `deviceId` | `string` | `undefined` | Specific device ID from `navigator.mediaDevices.enumerateDevices()`. |
| `video` | `HTMLVideoElement` | `undefined` | Existing `<video>` element to render into. If omitted, a detached video element is created. |

---

## Instance Methods

### `grab(): ImageData`
Samples the latest frame from the video stream without buffering or queuing. Returns a standard browser `ImageData` object containing raw RGBA 8-bit pixels.

```ts
const image = camera.grab();
console.log(image.width, image.height, image.data.byteLength);
```

### `close(): void`
Stops all tracks on the underlying `MediaStream`, pauses the video element, and releases the webcam hardware.

---

## Properties

### `video: HTMLVideoElement`
The HTML `<video>` element playing the live webcam stream.

### `stream: MediaStream`
The active `MediaStream` returned by `getUserMedia`.
