import { test } from "node:test";
import assert from "node:assert/strict";
import { SEARCH_CONFIG, documentText, queryText, normalizedVector, assertIndexContract, textOnlyConfig } from "../../docs/src/search-config.js";

test("shared contract pins text-only q4 runtime, query task, and all model artifacts", () => {
  assert.equal(SEARCH_CONFIG.model, "onnx-community/embeddinggemma-2-ONNX");
  assert.equal(SEARCH_CONFIG.revision, "daa72c51243991dfcaf9f9137d2c573d8f7790c0");
  assert.equal(SEARCH_CONFIG.dimensions, 768);
  assert.equal(SEARCH_CONFIG.precision, "q4");
  assert.equal(SEARCH_CONFIG.runtime.transformers, "4.3.1");
  assert.equal(queryText("日本語で検索"), "task: search result | query: 日本語で検索");
  assert.equal(Object.keys(SEARCH_CONFIG.artifacts).length, 5);
  for (const digest of Object.values(SEARCH_CONFIG.artifacts)) assert.match(digest, /^[a-f0-9]{64}$/);
});

test("document format preserves localized prose, identifiers and canonical commands", () => {
  assert.equal(documentText({
    reference: "ACI0092218",
    summary: "印刷時に [Print form](https://developer.4d.com/docs/ja/commands/print-form) で問題が発生しました。",
    commands: ["Print form"],
  }), "title: ACI0092218 | text: 印刷時に Print form で問題が発生しました。\nPrint form");
  assert.equal(documentText({ reference: "ACI0000001", summary: "Un bug corrigé." }),
    "title: ACI0000001 | text: Un bug corrigé.\n");
});

test("both runtimes disable non-text encoders without modifying the text configuration", () => {
  const textConfig = { model_type: "gemma", hidden_size: 768 };
  const config = { text_config: textConfig, vision_config: { enabled: true }, audio_config: { enabled: true } };
  assert.equal(textOnlyConfig(config), config);
  assert.equal(config.vision_config, null);
  assert.equal(config.audio_config, null);
  assert.equal(config.text_config, textConfig);
});

test("vectors must be exported, finite, full-dimensional, nonempty and normalized", () => {
  const vector = normalizedVector(Float32Array.from({ length: 768 }, () => 2));
  assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-6);
  assert.throws(() => normalizedVector(new Float32Array(256)), /dimensions/);
  assert.throws(() => normalizedVector(new Float32Array(768)), /Empty/);
  const invalid = new Float32Array(768).fill(1);
  invalid[0] = NaN;
  assert.throws(() => normalizedVector(invalid), /nonfinite/);
  assert.throws(() => normalizedVector(undefined), /dimensions/);
});

test("cache contract rejects same-dimensional model, revision, runtime or format changes", () => {
  const manifest = { contract: structuredClone(SEARCH_CONFIG), count: 2, bytes: 2 * 768 * 4 };
  assert.doesNotThrow(() => assertIndexContract(manifest, 2));
  for (const field of ["model", "revision", "precision", "queryPrefix", "documentFormat", "pooling", "normalization"]) {
    const changed = structuredClone(manifest);
    changed.contract[field] += "-changed";
    assert.throws(() => assertIndexContract(changed, 2), /contract/);
  }
  const changedRuntime = structuredClone(manifest);
  changedRuntime.contract.runtime.transformers = "0.0.0";
  assert.throws(() => assertIndexContract(changedRuntime, 2), /contract/);
  const changedArtifact = structuredClone(manifest);
  changedArtifact.contract.artifacts["config.json"] = "0".repeat(64);
  assert.throws(() => assertIndexContract(changedArtifact, 2), /contract/);
  assert.throws(() => assertIndexContract(manifest, 3), /shape/);
  assert.throws(() => assertIndexContract(null, 2), /contract/);
});
