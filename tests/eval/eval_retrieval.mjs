#!/usr/bin/env node
/**
 * Retrieval-quality check for the English, Japanese and French sites.
 *
 * Embeds every query in <lang>_queries.json exactly as the browser does (same
 * shared encoder and query prefix from docs/src/search-config.js), ranks the
 * built corpus in docs/data/<lang>/ by cosine similarity (semantic ranking only,
 * no command/version filters), and reports recall@1/@8 and MRR. It also prints
 * the score distribution of correct hits versus off-topic queries, which is
 * what the `scores` thresholds in i18n.js are calibrated against.
 * Supplemental greetings/general questions inform calibration separately;
 * the original four off-topic queries remain the comparable baseline metric.
 * --max-off-topic-hits gates all twelve original and supplemental negatives.
 * Calibration recommendations are diagnostic only and never change gates.
 *
 *   cd scripts && node ../tests/eval/eval_retrieval.mjs [--lang fr] [--min-recall8 0.8]
 *     [--min-visible-recall8 0.8] [--max-off-topic-hits 0]
 *     [--report path/to/report.json]
 *     [--require-baseline] (fail if any captured baseline metric regresses)
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES } from "../../docs/src/i18n.js";
import { SEARCH_CONFIG, queryText } from "../../docs/src/search-config.js";
import { loadEncoder } from "../../scripts/update/search-encoder.mjs";
import { compareBaseline, scoreCalibration, validateIndex } from "./eval_support.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

const langArg = process.argv.indexOf("--lang");
const lang = langArg >= 0 ? process.argv[langArg + 1] : "ja";
if (!["en", "ja", "fr"].includes(lang)) throw new Error("Expected --lang en, ja or fr");
const locale = LOCALES[lang];
const TOP_N = 8; // rows shown in the results table
const OFF_TOPIC = {
  en: ["What will the weather be like in London tomorrow?", "An apple pie recipe", "How should I feed my cat?", "Who won the latest football match?"],
  ja: ["今日の東京の天気は？", "おすすめのラーメン屋を教えて", "猫の飼い方", "株価の予想をして"],
  fr: ["Quel temps fera-t-il demain à Paris ?", "Une recette de tarte aux pommes", "Comment nourrir mon chat ?", "Qui a gagné le dernier match de football ?"],
}[lang];
const calibrationNegatives = JSON.parse(await readFile(path.join(HERE, "calibration_negatives.json"), "utf8"))[lang];
const negativeCount = OFF_TOPIC.length + calibrationNegatives.length;

const minArg = process.argv.indexOf("--min-recall8");
const MIN_RECALL8 = minArg >= 0 ? parseFloat(process.argv[minArg + 1]) : 0;
const visibleArg = process.argv.indexOf("--min-visible-recall8");
const MIN_VISIBLE_RECALL8 = visibleArg >= 0 ? parseFloat(process.argv[visibleArg + 1]) : 0;
const offTopicArg = process.argv.indexOf("--max-off-topic-hits");
const MAX_OFF_TOPIC_HITS = offTopicArg >= 0 ? Number(process.argv[offTopicArg + 1]) : OFF_TOPIC.length;
if (!Number.isInteger(MAX_OFF_TOPIC_HITS) || MAX_OFF_TOPIC_HITS < 0 || MAX_OFF_TOPIC_HITS > negativeCount) {
  throw new Error(`Off-topic hit limit must be an integer between 0 and ${negativeCount}`);
}
for (const value of [MIN_RECALL8, MIN_VISIBLE_RECALL8]) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Recall thresholds must be between 0 and 1");
}

const dataDir = path.resolve(ROOT, "docs/en", locale.dataDir);
const meta = JSON.parse(await readFile(path.join(dataDir, "meta.json"), "utf8"));
const bin = await readFile(path.join(dataDir, "embeddings.bin"));
const dim = SEARCH_CONFIG.dimensions;
const manifest = JSON.parse(await readFile(path.join(dataDir, "search-index.json"), "utf8"));
validateIndex(manifest, meta, bin);
if (bin.byteLength !== meta.length * dim * 4) throw new Error("Corpus vector dimensions do not match metadata");
const emb = new Float32Array(bin.buffer, bin.byteOffset, meta.length * dim);
const queries = JSON.parse(await readFile(path.join(HERE, `${lang}_queries.json`), "utf8"));
if (!queries.length) throw new Error("No evaluation queries");
const known = new Set(meta.map((b) => b.reference));
for (const { query, expected } of queries) {
  if (!query || !expected?.length || expected.some((ref) => !known.has(ref))) {
    throw new Error(`Invalid evaluation query or unknown reference: ${query}`);
  }
}

const baselines = JSON.parse(await readFile(path.join(HERE, "baselines.json"), "utf8"));
const baseline = baselines.locales[lang];
compareBaseline(baseline, queries, baseline.metrics);
const encoder = await loadEncoder();

async function rank(query) {
  const q = await encoder.encode(queryText(query));
  if (q.length !== dim || !q.every(Number.isFinite)) throw new Error("Invalid query vector");
  const scored = meta.map((b, i) => {
    let s = 0;
    for (let k = 0; k < dim; k++) s += emb[i * dim + k] * q[k];
    return { ref: b.reference, score: s };
  });
  return scored.sort((a, b) => b.score - a.score);
}

let hit1 = 0, hit8 = 0, visibleHit8 = 0, mrr = 0;
const correctScores = [];
const results = [];
const offTop = [];
const offTopicResults = [];
const supplementalNegatives = [];
try {
  for (const { query, expected } of queries) {
    const ranked = await rank(query);
    const pos = ranked.findIndex((r) => expected.includes(r.ref));
    if (pos === 0) hit1++;
    if (pos >= 0 && pos < TOP_N) hit8++;
    if (pos >= 0 && pos < TOP_N && ranked[pos].score >= locale.scores.min) visibleHit8++;
    if (pos >= 0) mrr += 1 / (pos + 1);
    if (pos >= 0) correctScores.push(ranked[pos].score);
    results.push({
      query, expected, rank: pos >= 0 ? pos + 1 : null,
      reference: ranked[pos]?.ref ?? null, score: ranked[pos]?.score ?? null,
      visible: pos >= 0 && pos < TOP_N && ranked[pos].score >= locale.scores.min,
      top: ranked.slice(0, TOP_N),
    });
    const mark = pos === 0 ? "✓" : pos >= 0 && pos < TOP_N ? "~" : "✗";
    console.log(`${mark} rank ${String(pos + 1).padStart(4)}  score ${ranked[pos]?.score.toFixed(3)}  ${query}`);
  }

  for (const query of OFF_TOPIC) {
    const top = (await rank(query))[0];
    offTop.push(top.score);
    offTopicResults.push({ query, ...top, passesFloor: top.score >= locale.scores.min });
  }
  for (const query of calibrationNegatives) {
    const top = (await rank(query))[0];
    supplementalNegatives.push({ query, ...top, passesFloor: top.score >= locale.scores.min });
  }
} finally {
  await encoder.dispose();
}
const offTopicHits = offTop.filter((score) => score >= locale.scores.min).length;
const expandedOffTopicHits = [...offTopicResults, ...supplementalNegatives]
  .filter((result) => result.passesFloor).length;

const n = queries.length;
const pct = (x) => `${((100 * x) / n).toFixed(1)}%`;
const sorted = [...correctScores].sort((a, b) => a - b);
console.log(`\n${n} queries: recall@1 ${pct(hit1)}, recall@${TOP_N} ${pct(hit8)}, MRR ${(mrr / n).toFixed(3)}`);
console.log(`visible recall@${TOP_N} (after score floor): ${pct(visibleHit8)}`);
console.log(`correct-hit scores: min ${sorted[0].toFixed(3)}, p10 ${sorted[Math.floor(n / 10)].toFixed(3)}, median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)}`);
console.log(`off-topic top scores: ${offTop.map((s) => s.toFixed(3)).join(", ")}`);
console.log(`off-topic queries passing score floor: ${offTopicHits}/${OFF_TOPIC.length}`);
console.log(`expanded off-topic queries passing score floor: ${expandedOffTopicHits}/${OFF_TOPIC.length + calibrationNegatives.length}`);
console.log(`thresholds in i18n.js: min ${locale.scores.min}, medium ${locale.scores.medium}, high ${locale.scores.high}`);

const metrics = { queries: n, recall1: hit1 / n, recall8: hit8 / n, mrr: mrr / n,
  visibleRecall8: visibleHit8 / n, offTopicHits, expandedOffTopicHits };
const comparison = compareBaseline(baseline, queries, metrics);
console.log(`\nActual old-model baseline (${baseline.embedding.model}):`);
for (const key of ["recall1", "recall8", "mrr"]) {
  const delta = comparison.delta[key];
  console.log(`${key}: ${baseline.metrics[key].toFixed(6)} -> ${metrics[key].toFixed(6)} (${delta >= 0 ? "+" : ""}${delta.toFixed(6)})`);
}
console.log(`Baseline regressions: ${comparison.regressions.join(", ") || "none"}`);
console.log(`Correct/off-topic score separation: ${(sorted[0] - Math.max(...offTop)).toFixed(6)}`);
const calibration = scoreCalibration(results, [...offTopicResults, ...supplementalNegatives]);
console.log(`Expanded negative scores: ${supplementalNegatives.map((result) => result.score.toFixed(3)).join(", ")}`);
console.log(`Measured calibration: ${JSON.stringify(calibration)}`);

const reportArg = process.argv.indexOf("--report");
if (reportArg >= 0) {
  if (!process.argv[reportArg + 1]) throw new Error("Expected a path after --report");
  await writeFile(process.argv[reportArg + 1], JSON.stringify({
    lang, capturedAt: new Date().toISOString(), library: "@huggingface/transformers",
    embedding: SEARCH_CONFIG, scores: locale.scores,
    corpus: { records: meta.length, dim, sha256: createHash("sha256").update(bin).digest("hex") },
    metrics, baseline: { sourceCommit: baselines.sourceCommit, ...comparison },
    qualityGates: {
      minRecall8: MIN_RECALL8, minVisibleRecall8: MIN_VISIBLE_RECALL8,
      maxOffTopicHits: MAX_OFF_TOPIC_HITS, negativeQueries: negativeCount,
      requireBaseline: process.argv.includes("--require-baseline"),
      passed: metrics.recall8 >= MIN_RECALL8 && metrics.visibleRecall8 >= MIN_VISIBLE_RECALL8 &&
        expandedOffTopicHits <= MAX_OFF_TOPIC_HITS &&
        (!process.argv.includes("--require-baseline") || comparison.regressions.length === 0),
    },
    correctScores: { min: sorted[0], p10: sorted[Math.floor(n / 10)], median: sorted[Math.floor(sorted.length / 2)] },
    results, offTopic: offTopicResults, supplementalNegatives, calibration,
  }, null, 2) + "\n");
}

if (hit8 / n < MIN_RECALL8 || visibleHit8 / n < MIN_VISIBLE_RECALL8) {
  console.error(`Recall below required minimum (ranked ${MIN_RECALL8}, visible ${MIN_VISIBLE_RECALL8})`);
  process.exit(1);
}
if (expandedOffTopicHits > MAX_OFF_TOPIC_HITS) {
  console.error(`Original and supplemental off-topic queries passing score floor exceed ${MAX_OFF_TOPIC_HITS}`);
  process.exit(1);
}
if (process.argv.includes("--require-baseline") && comparison.regressions.length) {
  console.error(`Quality below actual baseline: ${comparison.regressions.join(", ")}`);
  process.exit(1);
}
