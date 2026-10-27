import { SEARCH_CONFIG } from "./search-config.js";

export const TRANSFORMERS_URL = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${SEARCH_CONFIG.runtime.transformers}/dist/transformers.min.js`;
export const ORT_BASE_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${SEARCH_CONFIG.runtime.onnxruntime}/dist/`;

// Digests of unmodified files in the exact npm packages pinned by the lockfile.
export const RUNTIME_ARTIFACTS = Object.freeze({
  "transformers.min.js": "8d6716d9086f57c30a4bf367dba61b887593573c770c454465e8019b2703e743",
  "ort-wasm-simd-threaded.jsep.mjs": "c2f80e915e9df63289788a99d434d8c4e00e64e9c1f030f4b80b022458dd2c99",
  "ort-wasm-simd-threaded.jsep.wasm": "62ff86b2f2fa3a79eb87a7e4720e8ea9051942bf975f314181bf7dcef2feac06",
  "ort-wasm-simd-threaded.asyncify.mjs": "0966b6105cd936744498aa60df7a22cbd47af3374dbc64a9ab561c08a71e3611",
  "ort-wasm-simd-threaded.asyncify.wasm": "49871f5a4409519797e127440868a6d1923339d9185907f301a5b2a1d90af082",
  "ort-wasm-simd-threaded.jspi.mjs": "6b37a3974dbd96a752fdc1805e1bdc2dca3ead7e380703c092240c2352c71dbf",
  "ort-wasm-simd-threaded.jspi.wasm": "173146c55eb8c7e01f8be3f7b7376fbde14118d91607583ab7caf4feac98e59c",
});

export function runtimeUrl(file) {
  if (!Object.hasOwn(RUNTIME_ARTIFACTS, file)) throw new Error(`Unknown runtime artifact: ${file}`);
  return file === "transformers.min.js" ? TRANSFORMERS_URL : ORT_BASE_URL + file;
}
