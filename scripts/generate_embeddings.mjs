#!/usr/bin/env node
/**
 * Offline precompute step for client-side semantic search.
 *
 * Reads data/all_bugs_enriched.json (summary + linked commands per bug) and
 * data/all_bugs_context.json (versions per bug), joins them by `reference`,
 * embeds a markdown-stripped version of each summary with the same model
 * (Xenova/all-MiniLM-L6-v2, 384-dim, mean-pooled, L2-normalized) that the
 * browser page loads at query time, and writes:
 *   - docs/data/embeddings.bin  raw Float32Array, row-major [N x 384]
 *   - docs/data/meta.json       array aligned 1:1 with the embedding rows:
 *                               { reference, summary, commands, versions }
 *
 * Run from scripts/: `npm install && node generate_embeddings.mjs`
 */
import { pipeline } from "@xenova/transformers";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;

const ENRICHED_PATH = path.join(REPO_ROOT, "data", "all_bugs_enriched.json");
const CONTEXT_PATH = path.join(REPO_ROOT, "data", "all_bugs_context.json");
const OUT_DIR = path.join(REPO_ROOT, "docs", "data");
const OUT_BIN = path.join(OUT_DIR, "embeddings.bin");
const OUT_META = path.join(OUT_DIR, "meta.json");

/** Strip markdown link syntax `[text](url)` down to just `text`, so the
 * embedding model sees clean prose instead of URLs/markdown noise. */
function stripMarkdownLinks(text) {
  return text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

async function main() {
  console.log("Loading dataset...");
  const enriched = JSON.parse(await readFile(ENRICHED_PATH, "utf8"));
  const context = JSON.parse(await readFile(CONTEXT_PATH, "utf8"));

  const versionsByRef = new Map(
    context.map((c) => [c.reference, c.versions ?? []])
  );

  const records = enriched.map((bug) => ({
    reference: bug.reference,
    summary: bug.summary,
    commands: bug.commands ?? [],
    versions: versionsByRef.get(bug.reference) ?? [],
  }));

  console.log(`Loaded ${records.length} bugs. Loading embedding model ${MODEL_ID}...`);
  const embedder = await pipeline("feature-extraction", MODEL_ID, {
    quantized: true,
  });

  console.log("Embedding summaries...");
  const floatArray = new Float32Array(records.length * EMBED_DIM);
  const BATCH_SIZE = 32;
  for (let start = 0; start < records.length; start += BATCH_SIZE) {
    const batch = records.slice(start, start + BATCH_SIZE);
    const texts = batch.map((r) => stripMarkdownLinks(r.summary));
    const output = await embedder(texts, { pooling: "mean", normalize: true });
    // output.dims = [batch.length, EMBED_DIM]; output.data is a flat Float32Array
    floatArray.set(output.data, start * EMBED_DIM);
    process.stdout.write(
      `\r  ${Math.min(start + BATCH_SIZE, records.length)}/${records.length}`
    );
  }
  console.log("\nDone embedding.");

  await writeFile(OUT_BIN, Buffer.from(floatArray.buffer));
  await writeFile(OUT_META, JSON.stringify(records));

  console.log(`Wrote ${OUT_BIN} (${floatArray.byteLength} bytes)`);
  console.log(`Wrote ${OUT_META} (${records.length} records)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
