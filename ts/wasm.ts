/**
 * Loading the wasm module, in a browser or anywhere else.
 *
 * The package ships a single `--target web` build rather than one per host.
 * That output's initializer takes *either* a URL it will `fetch`, *or* raw
 * bytes — which is what makes one artifact enough:
 *
 * - **Browser:** `await initVigilo()` and the default `new URL(..., import.meta.url)`
 *   resolves the `.wasm` next to the JS. No bundler plugin, no `--target bundler`.
 * - **Bun / Node:** `await initVigilo(await readFile(wasmPath))`, because
 *   `fetch` of a `file://` URL is not universally supported.
 *
 * The previous layout used `--target bundler` and a top-level
 * `import * as wasm`, which is exactly the combination a browser cannot load:
 * bundler output imports the `.wasm` as an ES module (a webpack/vite feature,
 * not a web platform one), and a static import gives no point at which to
 * await instantiation.
 */

import initWasm, * as bindings from '../pkg/vigilo_wasm.js';

export type VigiloWasm = typeof bindings;

/** Anything the generated initializer accepts. */
export type WasmInput =
  | string
  | URL
  | Request
  | Response
  | BufferSource
  | WebAssembly.Module;

let pending: Promise<VigiloWasm> | null = null;

/**
 * Instantiate the wasm module. Idempotent: concurrent callers share one
 * instantiation, and later calls resolve immediately.
 *
 * Idempotent rather than guarded-by-a-boolean because in a browser the natural
 * call sites — a React effect that fires twice in StrictMode, two components
 * mounting at once — race each other by default, and a second
 * `WebAssembly.instantiate` of a 1.5 MB module is a visible stall.
 */
export function initVigilo(input?: WasmInput): Promise<VigiloWasm> {
  if (!pending) {
    // The single-object form. Passing the input positionally still works but
    // is deprecated, and wasm-bindgen warns about it on every start-up.
    const arg = input === undefined ? undefined : ({ module_or_path: input } as never);
    pending = initWasm(arg)
      .then(() => bindings)
      .catch((e) => {
        // Clear the cache so a failure is retryable. A rejected promise left
        // in place would make every later call fail with the first call's
        // error — typically a 404 for the `.wasm`, long after the path was
        // fixed.
        pending = null;
        throw e;
      });
  }
  return pending;
}

/**
 * The bindings, for code that already knows initialization finished.
 *
 * Throws rather than returning `undefined`: calling into an uninstantiated
 * module produces a null-pointer trap from deep inside generated glue, and the
 * stack it leaves behind names none of the code that caused it.
 */
export function vigilo(): VigiloWasm {
  if (!pending) {
    throw new Error('vigilo-wasm is not initialized — await initVigilo() first');
  }
  return bindings;
}

/** Whether `initVigilo` has been called (it may still be in flight). */
export function isInitializing(): boolean {
  return pending !== null;
}
