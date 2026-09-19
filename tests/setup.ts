/**
 * Instantiate the wasm module for the test run.
 *
 * The package ships one `--target web` build for every host. A browser lets
 * its initializer `fetch` the `.wasm` by URL; Bun and Node cannot rely on
 * `fetch` supporting `file://`, so the bytes are read and passed in directly.
 * Same artifact, same code path, different input type.
 */
import { readFileSync } from 'node:fs';
import { initVigilo } from '../ts/wasm.js';

await initVigilo(readFileSync(new URL('../pkg/vigilo_wasm_bg.wasm', import.meta.url)));
