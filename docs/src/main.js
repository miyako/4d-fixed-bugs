import { renderSummary, renderVersions } from "./render.js";

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
const subsetStatusEl = document.getElementById("subset-status");
const createSubsetBtn = document.getElementById("create-subset-btn");
const resetSubsetBtn = document.getElementById("reset-subset-btn");
const selectAllBtn = document.getElementById("select-all-btn");
const selectNoneBtn = document.getElementById("select-none-btn");

/** @type {{reference: string, summary: string, commands: string[], versions: string[]}[]} */
let meta = [];
/** @type {Float32Array | null} */
let embeddings = null;
let embedder = null;

/** Full ranked results from the last search. */
let lastResults = [];
/** What's currently rendered: either `lastResults` or a user-picked subset of it. */
let displayedResults = [];
/** Whether `displayedResults` is a subset (vs. the full `lastResults`). */
let subsetActive = false;
/** References checked via the per-card checkboxes in the current view. */
let selectedRefs = new Set();

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

function updateSubsetControls() {
  createSubsetBtn.disabled = selectedRefs.size === 0;
  resetSubsetBtn.disabled = !subsetActive;
  if (subsetActive) {
    subsetStatusEl.textContent = `Showing a subset of ${displayedResults.length} of ${lastResults.length} matching bugs. This subset is what the AI chat below will use as context.`;
  } else if (lastResults.length > 0) {
    subsetStatusEl.textContent = `Showing all ${displayedResults.length} matching bugs. Select some and click "Use selection as subset" to narrow the AI chat's context.`;
  } else {
    subsetStatusEl.textContent = "";
  }
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
    // Cosine similarity of two normalized vectors is in [-1, 1]; for real
    // text matches it's practically always positive, but clamp defensively
    // before turning it into a bar width.
    const pct = Math.max(0, Math.min(1, r.score)) * 100;
    card.innerHTML = `
      <div class="ref-row">
        <label class="select-label">
          <input type="checkbox" class="select-checkbox" data-ref="${r.reference}" ${selectedRefs.has(r.reference) ? "checked" : ""} />
          <span class="ref">${r.reference}</span>
        </label>
        <div class="score-bar" title="cosine similarity: ${r.score.toFixed(3)}">
          <div class="score-bar-fill" style="width: ${pct.toFixed(1)}%"></div>
          <span class="score-label">${r.score.toFixed(3)}</span>
        </div>
      </div>
      <div class="summary">${renderSummary(r.summary)}</div>
      <div class="versions">Fixed in: ${renderVersions(r.versions)}</div>
    `;
    card.querySelector(".select-checkbox").addEventListener("change", (e) => {
      if (e.target.checked) selectedRefs.add(r.reference);
      else selectedRefs.delete(r.reference);
      updateSubsetControls();
    });
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
    displayedResults = lastResults;
    subsetActive = false;
    selectedRefs = new Set();
    renderResults(displayedResults);
    updateSubsetControls();
    setStatus(`Showing top ${lastResults.length} results for "${query}".`);
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
});

selectAllBtn.addEventListener("click", () => {
  for (const r of displayedResults) selectedRefs.add(r.reference);
  renderResults(displayedResults);
  updateSubsetControls();
});

selectNoneBtn.addEventListener("click", () => {
  selectedRefs.clear();
  renderResults(displayedResults);
  updateSubsetControls();
});

createSubsetBtn.addEventListener("click", () => {
  if (selectedRefs.size === 0) return;
  displayedResults = lastResults.filter((r) => selectedRefs.has(r.reference));
  subsetActive = true;
  renderResults(displayedResults);
  updateSubsetControls();
});

resetSubsetBtn.addEventListener("click", () => {
  displayedResults = lastResults;
  subsetActive = false;
  selectedRefs = new Set();
  renderResults(displayedResults);
  updateSubsetControls();
});

loadData().catch((err) => {
  console.error(err);
  setStatus(`Failed to load bug database: ${err.message}`);
});

// Expose hooks for rag.js: the same search/ranking logic, plus the set of
// bugs currently shown (subset if the user made one, otherwise the full
// result list) so the chat can ground its answers in exactly what the
// user is looking at.
window.__bugSearch = {
  search,
  getActiveBugs: () => displayedResults,
  isSubsetActive: () => subsetActive,
};
