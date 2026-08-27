import { renderSummary } from "./render.js";

// Pin the exact transformers.js version to match the one used to
// precompute embeddings in scripts/generate_embeddings.mjs.
const TRANSFORMERS_CDN_URL =
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";
const MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;

const form = document.getElementById("search-form");
const input = document.getElementById("search-input");
const topKSelect = document.getElementById("top-k");
const statusEl = document.getElementById("search-status");
const resultsEl = document.getElementById("results");

/** @type {{reference: string, summary: string, commands: string[], versions: string[]}[]} */
let meta = [];
/** @type {Float32Array | null} */
let embeddings = null;
let embedder = null;
let lastResults = [];

function setStatus(msg) {
  statusEl.textContent = msg;
}

async function loadData() {
  setStatus("Loading bug database…");
  const [metaRes, binRes] = await Promise.all([
    fetch("data/meta.json"),
    fetch("data/embeddings.bin"),
  ]);
  meta = await metaRes.json();
  const buf = await binRes.arrayBuffer();
  embeddings = new Float32Array(buf);
  setStatus(`Loaded ${meta.length} bug records. Type a query and search.`);
}

async function getEmbedder() {
  if (embedder) return embedder;
  setStatus("Loading embedding model (first search only, cached after)…");
  const { pipeline, env } = await import(TRANSFORMERS_CDN_URL);
  // Fetch model weights from the Hugging Face Hub CDN (not a local
  // /models/ path) and let the browser Cache Storage API cache them.
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  embedder = await pipeline("feature-extraction", MODEL_ID, {
    quantized: true,
  });
  return embedder;
}

function dot(a, aOffset, b) {
  let sum = 0;
  for (let i = 0; i < EMBED_DIM; i++) sum += a[aOffset + i] * b[i];
  return sum;
}

async function search(query, topK) {
  const model = await getEmbedder();
  setStatus("Embedding query…");
  const output = await model(query, { pooling: "mean", normalize: true });
  const queryVec = output.data; // Float32Array length EMBED_DIM

  const scored = new Array(meta.length);
  for (let i = 0; i < meta.length; i++) {
    scored[i] = { index: i, score: dot(embeddings, i * EMBED_DIM, queryVec) };
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((s) => ({ ...meta[s.index], score: s.score }));
}

function renderResults(results) {
  resultsEl.innerHTML = "";
  if (results.length === 0) {
    resultsEl.innerHTML = "<p>No results.</p>";
    return;
  }
  for (const r of results) {
    const card = document.createElement("article");
    card.className = "result-card";
    card.id = `result-${r.reference}`;
    const versions = r.versions?.length ? r.versions.join(", ") : "—";
    card.innerHTML = `
      <div class="ref-row">
        <span class="ref">${r.reference}</span>
        <span class="score">similarity: ${r.score.toFixed(3)}</span>
      </div>
      <div class="summary">${renderSummary(r.summary)}</div>
      <div class="versions">Fixed in: ${versions}</div>
    `;
    resultsEl.appendChild(card);
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const query = input.value.trim();
  if (!query) return;
  const topK = parseInt(topKSelect.value, 10);
  try {
    lastResults = await search(query, topK);
    renderResults(lastResults);
    setStatus(`Showing top ${lastResults.length} results for "${query}".`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
});

export function getLastResults() {
  return lastResults;
}

loadData().catch((err) => {
  console.error(err);
  setStatus(`Failed to load bug database: ${err.message}`);
});

// Expose a hook for rag.js to trigger the same search + reuse results
// without duplicating the ranking logic.
window.__bugSearch = { search, getLastResults: () => lastResults };
