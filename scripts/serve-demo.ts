/**
 * Static server for the demo, with the two headers the demo actually needs.
 *
 * `python -m http.server` will not do here, for two reasons:
 *
 * 1. **COOP + COEP.** `SharedArrayBuffer` — and therefore multi-threaded
 *    inference in `onnxruntime-web` — is only available on a cross-origin
 *    isolated page. Without these headers ORT silently falls back to one
 *    thread and the gaze model roughly triples in latency.
 * 2. **`application/wasm`.** `WebAssembly.instantiateStreaming` rejects any
 *    other content type, and the error it gives names the MIME type rather
 *    than the server that sent it.
 *
 * `localhost` counts as a secure context, so `getUserMedia` works over plain
 * http here. Anywhere else needs real TLS.
 */
import { existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(import.meta.url), '..', '..');
// Not 5173: that is Vite's default and the Vigilo desktop app's dev server
// already lives there. Override with PORT.
const port = Number(process.env.PORT ?? 5321);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.map': 'application/json',
};

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/demo/index.html';

    // Contain the served tree to this package. `normalize` collapses `..`
    // segments first, so a path that climbs out is rejected rather than
    // resolved against the filesystem root.
    const target = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ''));
    if (!target.startsWith(root) || !existsSync(target) || statSync(target).isDirectory()) {
      return new Response('Not found', { status: 404 });
    }

    return new Response(Bun.file(target), {
      headers: {
        'Content-Type': MIME[extname(target)] ?? 'application/octet-stream',
        // Cross-origin isolation, for multi-threaded wasm.
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'same-origin',
        'Cache-Control': 'no-cache',
      },
    });
  },
});

console.log(`vigilo demo   http://localhost:${server.port}/`);
console.log(`serving       ${root}`);
console.log('cross-origin isolated: yes (multi-threaded wasm available)');
