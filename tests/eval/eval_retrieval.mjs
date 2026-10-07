#!/usr/bin/env node
/**
 * Retrieval-quality check for the Japanese site.
 *
 * Embeds every query in ja_queries.json exactly as the browser does (same
 * model, options and query prefix, read from docs/src/i18n.js), ranks the
 * built corpus in docs/data/ja/ by cosine similarity (semantic ranking only,
 * no command/version filters), and reports recall@1/@8 and MRR. It also prints
 * the score distribution of correct hits versus off-topic queries, which is
 * what the `scores` thresholds in i18n.js are calibrated against.
 *
 *   cd scripts && node ../tests/eval/eval_retrieval.mjs [--min-recall8 0.8]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { LOCALES } from "../../docs/src/i18n.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(ROOT, "scripts", "package.json"));

const locale = LOCALES.ja;
const TOP_N = 8; // rows shown in the results table
const OFF_TOPIC = ["今日の東京の天気は？", "おすすめのラーメン屋を教えて", "猫の飼い方", "株価の予想をして"];

const minArg = process.argv.indexOf("--min-recall8");
const MIN_RECALL8 = minArg >= 0 ? parseFloat(process.argv[minArg + 1]) : 0;

const meta = JSON.parse(await readFile(path.join(ROOT, "docs/data/ja/meta.json"), "utf8"));
const bin = await readFile(path.join(ROOT, "docs/data/ja/embeddings.bin"));
const dim = locale.embedding.dim;
const emb = new Float32Array(bin.buffer, bin.byteOffset, meta.length * dim);
const queries = JSON.parse(await readFile(path.join(HERE, "ja_queries.json"), "utf8"));

const transformers = await import(pathToFileURL(require.resolve("@huggingface/transformers")).href);
const { pipeline } = transformers.pipeline ? transformers : transformers.default;
const embedder = await pipeline("feature-extraction", locale.embedding.model, locale.embedding.options);

async function rank(query) {
  const out = await embedder(locale.embedding.queryPrefix + query, { pooling: "mean", normalize: true });
  const q = out.data;
  const scored = meta.map((b, i) => {
    let s = 0;
    for (let k = 0; k < dim; k++) s += emb[i * dim + k] * q[k];
    return { ref: b.reference, score: s };
  });
  return scored.sort((a, b) => b.score - a.score);
}

let hit1 = 0, hit8 = 0, mrr = 0;
const correctScores = [];
for (const { query, expected } of queries) {
  const ranked = await rank(query);
  const pos = ranked.findIndex((r) => expected.includes(r.ref));
  if (pos === 0) hit1++;
  if (pos >= 0 && pos < TOP_N) hit8++;
  if (pos >= 0) mrr += 1 / (pos + 1);
  if (pos >= 0) correctScores.push(ranked[pos].score);
  const mark = pos === 0 ? "✓" : pos < TOP_N ? "~" : "✗";
  console.log(`${mark} rank ${String(pos + 1).padStart(4)}  score ${ranked[pos]?.score.toFixed(3)}  ${query}`);
}

const offTop = [];
for (const q of OFF_TOPIC) offTop.push((await rank(q))[0].score);

const n = queries.length;
const pct = (x) => `${((100 * x) / n).toFixed(1)}%`;
const sorted = [...correctScores].sort((a, b) => a - b);
console.log(`\n${n} queries: recall@1 ${pct(hit1)}, recall@${TOP_N} ${pct(hit8)}, MRR ${(mrr / n).toFixed(3)}`);
console.log(`correct-hit scores: min ${sorted[0].toFixed(3)}, p10 ${sorted[Math.floor(n / 10)].toFixed(3)}, median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)}`);
console.log(`off-topic top scores: ${offTop.map((s) => s.toFixed(3)).join(", ")}`);
console.log(`thresholds in i18n.js: min ${locale.scores.min}, medium ${locale.scores.medium}, high ${locale.scores.high}`);

if (hit8 / n < MIN_RECALL8) {
  console.error(`recall@${TOP_N} below ${MIN_RECALL8}`);
  process.exit(1);
}
