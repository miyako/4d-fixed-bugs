#!/usr/bin/env node
/**
 * Retrieval-quality check for the Japanese and French sites.
 *
 * Embeds every query in <lang>_queries.json exactly as the browser does (same
 * model, options and query prefix, read from docs/src/i18n.js), ranks the
 * built corpus in docs/data/<lang>/ by cosine similarity (semantic ranking only,
 * no command/version filters), and reports recall@1/@8 and MRR. It also prints
 * the score distribution of correct hits versus off-topic queries, which is
 * what the `scores` thresholds in i18n.js are calibrated against.
 *
 *   cd scripts && node ../tests/eval/eval_retrieval.mjs [--lang fr] [--min-recall8 0.8]
 *     [--min-visible-recall8 0.8] [--max-off-topic-hits 0]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { LOCALES } from "../../docs/src/i18n.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const require = createRequire(path.join(ROOT, "scripts", "package.json"));

const langArg = process.argv.indexOf("--lang");
const lang = langArg >= 0 ? process.argv[langArg + 1] : "ja";
if (!["ja", "fr"].includes(lang)) throw new Error("Expected --lang ja or --lang fr");
const locale = LOCALES[lang];
const TOP_N = 8; // rows shown in the results table
const OFF_TOPIC = {
  ja: ["今日の東京の天気は？", "おすすめのラーメン屋を教えて", "猫の飼い方", "株価の予想をして"],
  fr: ["Quel temps fera-t-il demain à Paris ?", "Une recette de tarte aux pommes", "Comment nourrir mon chat ?", "Qui a gagné le dernier match de football ?"],
}[lang];

const minArg = process.argv.indexOf("--min-recall8");
const MIN_RECALL8 = minArg >= 0 ? parseFloat(process.argv[minArg + 1]) : 0;
const visibleArg = process.argv.indexOf("--min-visible-recall8");
const MIN_VISIBLE_RECALL8 = visibleArg >= 0 ? parseFloat(process.argv[visibleArg + 1]) : 0;
const offTopicArg = process.argv.indexOf("--max-off-topic-hits");
const MAX_OFF_TOPIC_HITS = offTopicArg >= 0 ? Number(process.argv[offTopicArg + 1]) : OFF_TOPIC.length;
if (!Number.isInteger(MAX_OFF_TOPIC_HITS) || MAX_OFF_TOPIC_HITS < 0 || MAX_OFF_TOPIC_HITS > OFF_TOPIC.length) {
  throw new Error(`Off-topic hit limit must be an integer between 0 and ${OFF_TOPIC.length}`);
}
for (const value of [MIN_RECALL8, MIN_VISIBLE_RECALL8]) {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error("Recall thresholds must be between 0 and 1");
}

const meta = JSON.parse(await readFile(path.join(ROOT, `docs/data/${lang}/meta.json`), "utf8"));
const bin = await readFile(path.join(ROOT, `docs/data/${lang}/embeddings.bin`));
const dim = locale.embedding.dim;
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

const library = lang === "ja" ? "@huggingface/transformers" : "@xenova/transformers";
const transformers = await import(pathToFileURL(require.resolve(library)).href);
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

let hit1 = 0, hit8 = 0, visibleHit8 = 0, mrr = 0;
const correctScores = [];
for (const { query, expected } of queries) {
  const ranked = await rank(query);
  const pos = ranked.findIndex((r) => expected.includes(r.ref));
  if (pos === 0) hit1++;
  if (pos >= 0 && pos < TOP_N) hit8++;
  if (pos >= 0 && pos < TOP_N && ranked[pos].score >= locale.scores.min) visibleHit8++;
  if (pos >= 0) mrr += 1 / (pos + 1);
  if (pos >= 0) correctScores.push(ranked[pos].score);
  const mark = pos === 0 ? "✓" : pos >= 0 && pos < TOP_N ? "~" : "✗";
  console.log(`${mark} rank ${String(pos + 1).padStart(4)}  score ${ranked[pos]?.score.toFixed(3)}  ${query}`);
}

const offTop = [];
for (const q of OFF_TOPIC) offTop.push((await rank(q))[0].score);
const offTopicHits = offTop.filter((score) => score >= locale.scores.min).length;

const n = queries.length;
const pct = (x) => `${((100 * x) / n).toFixed(1)}%`;
const sorted = [...correctScores].sort((a, b) => a - b);
console.log(`\n${n} queries: recall@1 ${pct(hit1)}, recall@${TOP_N} ${pct(hit8)}, MRR ${(mrr / n).toFixed(3)}`);
console.log(`visible recall@${TOP_N} (after score floor): ${pct(visibleHit8)}`);
console.log(`correct-hit scores: min ${sorted[0].toFixed(3)}, p10 ${sorted[Math.floor(n / 10)].toFixed(3)}, median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)}`);
console.log(`off-topic top scores: ${offTop.map((s) => s.toFixed(3)).join(", ")}`);
console.log(`off-topic queries passing score floor: ${offTopicHits}/${OFF_TOPIC.length}`);
console.log(`thresholds in i18n.js: min ${locale.scores.min}, medium ${locale.scores.medium}, high ${locale.scores.high}`);

if (hit8 / n < MIN_RECALL8 || visibleHit8 / n < MIN_VISIBLE_RECALL8) {
  console.error(`Recall below required minimum (ranked ${MIN_RECALL8}, visible ${MIN_VISIBLE_RECALL8})`);
  process.exit(1);
}
if (offTopicHits > MAX_OFF_TOPIC_HITS) {
  console.error(`Off-topic queries passing score floor exceed ${MAX_OFF_TOPIC_HITS}`);
  process.exit(1);
}
