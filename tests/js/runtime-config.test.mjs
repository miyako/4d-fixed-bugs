import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SEARCH_CONFIG } from "../../docs/src/search-config.js";
import { TRANSFORMERS_URL, ORT_BASE_URL, RUNTIME_ARTIFACTS, runtimeUrl } from "../../docs/src/runtime-config.js";

test("official browser distribution and ORT assets are pinned to compatible package versions", () => {
  assert.equal(TRANSFORMERS_URL, "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js");
  assert.equal(ORT_BASE_URL, "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/");
  assert.equal(runtimeUrl("transformers.min.js"), TRANSFORMERS_URL);
  assert.equal(runtimeUrl("ort-wasm-simd-threaded.jsep.wasm"), ORT_BASE_URL + "ort-wasm-simd-threaded.jsep.wasm");
  assert.throws(() => runtimeUrl("../untrusted.js"), /Unknown runtime artifact/);
});

test("all upstream runtime artifacts have reproducible checksums and retained license metadata", async () => {
  assert.equal(Object.keys(RUNTIME_ARTIFACTS).length, 7);
  for (const digest of Object.values(RUNTIME_ARTIFACTS)) assert.match(digest, /^[a-f0-9]{64}$/);
  const directory = new URL("../../docs/search-runtime/4.3.1/", import.meta.url);
  assert.deepEqual(JSON.parse(await readFile(new URL("versions.json", directory), "utf8")), SEARCH_CONFIG.runtime);
  for (const name of ["LICENSE-transformers.txt", "LICENSE-onnxruntime.txt", "LICENSE-tokenizers.txt", "LICENSE-jinja.txt"]) {
    assert.ok((await readFile(new URL(name, directory), "utf8")).length > 500, name);
  }
});
