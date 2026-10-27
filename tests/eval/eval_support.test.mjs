import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { SEARCH_CONFIG } from "../../docs/src/search-config.js";
import { compareBaseline, scoreCalibration, validateIndex } from "./eval_support.mjs";

const baselines = JSON.parse(await readFile(new URL("./baselines.json", import.meta.url), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("captured baseline preserves 43 aligned intentions for each locale", async () => {
  let expected;
  for (const lang of ["en", "fr", "ja"]) {
    const queries = JSON.parse(await readFile(new URL(`./${lang}_queries.json`, import.meta.url), "utf8"));
    const baseline = baselines.locales[lang];
    assert.equal(queries.length, 43);
    assert.equal(baseline.corpus.records, 2467);
    assert.equal(baseline.results.length, 43);
    assert.equal(baseline.offTopic.length, 4);
    assert.ok(baseline.results.every((result) => result.rank >= 1 && Number.isFinite(result.score)));
    assert.ok(baseline.offTopic.every((result) => Number.isFinite(result.score)));
    if (expected) assert.deepEqual(queries.map((query) => query.expected), expected);
    expected = queries.map((query) => query.expected);
    assert.deepEqual(compareBaseline(baseline, queries, baseline.metrics).regressions, []);
  }
});

test("baseline comparison reports regressions without hiding improved metrics", () => {
  const baseline = baselines.locales.en;
  const metrics = { ...baseline.metrics, recall1: 1, recall8: 0.9, mrr: 0.9, visibleRecall8: 0.8, offTopicHits: 2 };
  const comparison = compareBaseline(baseline, baseline.results, metrics);
  assert.ok(comparison.delta.recall1 > 0);
  assert.deepEqual(comparison.regressions, ["recall8", "mrr", "visibleRecall8", "offTopicHits"]);
  const changedQueries = baseline.results.map((result) => ({ ...result }));
  changedQueries[0].query = "Different intention";
  assert.throws(() => compareBaseline(baseline, changedQueries, metrics), /queries changed/);
});

test("index validation rejects stale contracts, metadata and vector bytes", () => {
  const meta = [{ reference: "ACI0103587", summary: "Example" }];
  const bytes = Buffer.alloc(SEARCH_CONFIG.dimensions * 4);
  const manifest = {
    contract: SEARCH_CONFIG, count: meta.length, bytes: bytes.byteLength,
    metadata_sha256: hash(JSON.stringify(meta)), vectors_sha256: hash(bytes),
  };
  assert.doesNotThrow(() => validateIndex(manifest, meta, bytes));
  assert.throws(() => validateIndex({ ...manifest, contract: {} }, meta, bytes), /contract changed/);
  assert.throws(() => validateIndex({ ...manifest, count: 2 }, meta, bytes), /shape/);
  assert.throws(() => validateIndex(manifest, [{ ...meta[0], summary: "Changed" }], bytes), /checksum/);
  assert.throws(() => validateIndex(manifest, meta, Buffer.alloc(bytes.length, 1)), /checksum/);
  assert.throws(() => validateIndex(manifest, meta, bytes.subarray(4)), /checksum/);
});

test("calibration separates scores when possible and reports recall tradeoffs otherwise", () => {
  const results = [{ rank: 1, score: 0.7 }, { rank: 9, score: 0.8 }, { rank: 2, score: 0.9 }];
  const separated = scoreCalibration(results, [{ score: 0.4 }, { score: 0.5 }]);
  assert.equal(separated.recommendation.scores.min, 0.6);
  assert.equal(separated.recommendation.visibleRecall8, 2 / 3);
  assert.equal(separated.recommendation.offTopicHits, 0);
  const overlapping = scoreCalibration(results, [{ score: 0.85 }]);
  assert.equal(overlapping.recommendation.visibleRecall8, 1 / 3);
  assert.equal(overlapping.recommendation.offTopicHits, 0);
  assert.match(overlapping.recommendation.rationale, /overlap/);
  assert.throws(() => scoreCalibration([], [{ score: 0.5 }]), /requires finite/);
});

test("final measured reports pass active-floor gates across all twelve negatives", async () => {
  for (const lang of ["en", "fr", "ja"]) {
    const report = JSON.parse(await readFile(new URL(`./embeddinggemma-${lang}.json`, import.meta.url), "utf8"));
    const { metrics, qualityGates, results } = report;
    const negatives = [...report.offTopic, ...report.supplementalNegatives];
    assert.equal(results.length, 43);
    assert.equal(negatives.length, 12);
    assert.equal(qualityGates.negativeQueries, negatives.length);
    assert.equal(qualityGates.minRecall8, 0.95);
    assert.equal(qualityGates.minVisibleRecall8, 0.95);
    assert.equal(qualityGates.maxOffTopicHits, 0);
    assert.equal(qualityGates.requireBaseline, false);
    assert.equal(qualityGates.passed, true);
    assert.equal(metrics.recall1, results.filter((result) => result.rank === 1).length / results.length);
    assert.equal(metrics.recall8, results.filter((result) => result.rank <= 8).length / results.length);
    assert.equal(metrics.visibleRecall8,
      results.filter((result) => result.rank <= 8 && result.score >= report.scores.min).length / results.length);
    assert.equal(metrics.expandedOffTopicHits, negatives.filter((result) => result.score >= report.scores.min).length);
    assert.ok(metrics.recall8 >= 0.95 && metrics.visibleRecall8 >= 0.95);
    assert.equal(metrics.expandedOffTopicHits, 0);
    assert.deepEqual(report.baseline.regressions,
      compareBaseline(baselines.locales[lang], results, metrics).regressions);
  }
});
