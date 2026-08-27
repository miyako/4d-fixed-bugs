import { renderSummary, renderVersions } from "./render.js";
import { parseVersionIntent, bugMatchesIntent, describeIntent } from "./version.js";
import * as webllmEngine from "./engines/webllm-engine.js";
import * as lfm25Engine from "./engines/lfm25-engine.js";

/**
 * Single-interface chat app: semantic search over the 4D fixed-bugs
 * dataset is performed automatically, behind the scenes, on every user
 * message (no separate search bar/results list/selection UI) and used to
 * ground a fully local WebLLM chat model's answer.
 *
 * Design note: rather than relying on the (small, 1B-parameter) local
 * model to itself decide when/how to "call" a search tool — which is
 * unreliable for a model this size — retrieval is deterministic and
 * always runs in this file for every user turn: it parses the message
 * for a version reference (see version.js for the exact rules), filters
 * the dataset accordingly if one is found, then ranks by semantic
 * similarity. The system prompt sent to the model explains this process
 * (including the version rules verbatim) and provides the retrieved bug
 * reports as grounding context, so the model's job is just to answer
 * from that context and decline anything out of scope — not to run the
 * retrieval itself.
 */

// Pinned CDN versions for reproducibility.
const TRANSFORMERS_CDN_URL =
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;
const TOP_K = 15;
const TABLE_TOP_N = 8;

/**
 * Chat engine selection. Both engines implement the same minimal interface
 * (`init(onProgress)`, `chat(messages) -> {text, thinking}`, `reset()`), so
 * everything else in this file — retrieval, system-prompt construction,
 * conversation state, chat UI — is engine-agnostic. See
 * docs/src/engines/webllm-engine.js and docs/src/engines/lfm25-engine.js,
 * and SESSION_NOTES_LFM25_COMPARISON.md for why this flag exists and how
 * the two engines compare.
 *
 * Flip this constant to "lfm25" to try LiquidAI's LFM2.5-1.2B-Thinking
 * (ONNX/WebGPU) instead of WebLLM's Llama-3.2-1B-Instruct. A `?engine=lfm25`
 * (or `?engine=webllm`) URL query param overrides this constant, purely as
 * a convenience for side-by-side testing/comparison without editing source.
 */
const DEFAULT_CHAT_ENGINE = "webllm"; // "webllm" | "lfm25"
const CHAT_ENGINE =
  new URLSearchParams(location.search).get("engine") ||
  document.body.dataset.engine ||
  DEFAULT_CHAT_ENGINE;

function createChatEngine() {
  return CHAT_ENGINE === "lfm25" ? lfm25Engine.createEngine() : webllmEngine.createEngine();
}

const bootStatusEl = document.getElementById("boot-status");
const chatEl = document.getElementById("chat");
const chatForm = document.getElementById("chat-form");
const chatInput = document.getElementById("chat-input");
const chatSubmitBtn = chatForm.querySelector("button[type=submit]");
const clearBtn = document.getElementById("clear-btn");
const copyBtn = document.getElementById("copy-btn");

/** @type {{reference: string, summary: string, commands: string[], versions: string[]}[]} */
let meta = [];
/** @type {Float32Array | null} */
let embeddings = null;
let embedder = null;
let engine = null;
let minMajor = Infinity;
let maxMajor = -Infinity;

/** Persisted conversation turns: [{role: 'user'|'assistant', content, bugsContext}] */
let conversation = [];

function setBootStatus(msg) {
  bootStatusEl.textContent = msg;
}

function setReady(ready) {
  chatInput.disabled = !ready;
  chatSubmitBtn.disabled = !ready;
  if (ready) chatInput.focus();
}

function stripLinks(text) {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function dot(a, aOffset, b) {
  let sum = 0;
  for (let i = 0; i < EMBED_DIM; i++) sum += a[aOffset + i] * b[i];
  return sum;
}

async function loadDataset() {
  setBootStatus("Loading bug database…");
  // Resolve relative to this module's own URL (not the page URL), so this
  // works whether app.js is loaded from docs/index.html or from a
  // subdirectory page such as docs/lfm25/index.html.
  const dataUrl = (name) => new URL(`../data/${name}`, import.meta.url);
  const [metaRes, binRes] = await Promise.all([
    fetch(dataUrl("meta.json")),
    fetch(dataUrl("embeddings.bin")),
  ]);
  meta = await metaRes.json();
  const buf = await binRes.arrayBuffer();
  embeddings = new Float32Array(buf);
  for (const bug of meta) {
    for (const v of bug.versions || []) {
      const m = v.match(/^(\d+)/);
      if (!m) continue;
      const major = parseInt(m[1], 10);
      if (major < minMajor) minMajor = major;
      if (major > maxMajor) maxMajor = major;
    }
  }
}

async function loadEmbedder() {
  setBootStatus("Loading semantic search model…");
  const { pipeline, env } = await import(TRANSFORMERS_CDN_URL);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  embedder = await pipeline("feature-extraction", EMBED_MODEL_ID, { quantized: true });
}

async function loadChatEngine() {
  setBootStatus("Downloading local AI model… this can take a while the first time.");
  engine = createChatEngine();
  await engine.init((text) => setBootStatus(text || "Loading local AI model…"));
}

/** Extract explicit ACI bug reference IDs mentioned in a message (e.g.
 * "ACI0101931", "aci101931", "ACI 101931") and normalize them to the
 * dataset's exact format: "ACI" + 7 zero-padded digits. */
function extractExplicitRefs(text) {
  const refs = new Set();
  for (const m of text.matchAll(/\bACI\s*0*(\d{1,7})\b/gi)) {
    refs.add("ACI" + m[1].padStart(7, "0"));
  }
  return [...refs];
}

/** Automatic retrieval for a user message: if the message explicitly
 * names one or more ACI bug reference IDs, look those up directly
 * (exact match, no semantic search needed). Otherwise parse any version
 * reference, filter by it if present, then rank by semantic similarity. */
async function retrieve(query) {
  const explicitRefs = extractExplicitRefs(query);
  if (explicitRefs.length > 0) {
    const found = explicitRefs
      .map((ref) => meta.find((b) => b.reference === ref))
      .filter(Boolean);
    const notFound = explicitRefs.filter((ref) => !found.some((b) => b.reference === ref));
    if (found.length > 0) {
      const results = found.map((b) => ({ ...b, score: 1 }));
      return { results, intent: null, usedFallback: false, explicitRefs, notFoundRefs: notFound };
    }
    // None of the mentioned IDs exist in the dataset — fall through to
    // semantic search, but remember which IDs were unrecognized so the
    // system prompt can tell the model to mention that.
  }

  const intent = parseVersionIntent(query, minMajor, maxMajor);
  let pool = meta.map((_, i) => i);
  let usedFallback = false;
  if (intent) {
    const filtered = pool.filter((i) => bugMatchesIntent(meta[i], intent));
    if (filtered.length > 0) {
      pool = filtered;
    } else {
      usedFallback = true;
    }
  }

  const output = await embedder(query, { pooling: "mean", normalize: true });
  const queryVec = output.data;
  const scored = pool.map((i) => ({ index: i, score: dot(embeddings, i * EMBED_DIM, queryVec) }));
  scored.sort((a, b) => b.score - a.score);
  const results = scored.slice(0, TOP_K).map((s) => ({ ...meta[s.index], score: s.score }));
  return {
    results,
    intent,
    usedFallback,
    explicitRefs: explicitRefs.length > 0 ? explicitRefs : undefined,
    notFoundRefs: explicitRefs.length > 0 ? explicitRefs : [],
  };
}

function buildSystemMessage(retrieval) {
  const { results, intent, usedFallback, explicitRefs, notFoundRefs } = retrieval;
  const intentDesc = describeIntent(intent);
  const context = results
    .map((h) => `[${h.reference}] (versions: ${(h.versions || []).join(", ") || "unknown"}) ${stripLinks(h.summary)}`)
    .join("\n\n");

  let versionNote = "";
  if (intentDesc && usedFallback) {
    versionNote = ` (note: no bugs matched ${intentDesc} specifically, so these are the closest overall matches instead)`;
  }

  let lookupNote = "";
  if (explicitRefs && explicitRefs.length > 0) {
    if (results.length > 0 && (!notFoundRefs || notFoundRefs.length === 0)) {
      lookupNote =
        ` The user asked about a specific bug reference by ID (${explicitRefs.join(", ")}), so the report ` +
        `below is an exact lookup, not a search — just describe it directly.`;
    } else if (notFoundRefs && notFoundRefs.length > 0) {
      lookupNote =
        ` The user mentioned bug reference ID(s) ${notFoundRefs.join(", ")} which do not exist in the ` +
        `database — mention that plainly instead of guessing what they might be.`;
    }
  }

  return {
    role: "system",
    content:
      "You help people find and understand fixed 4D software bugs (bugs.4d.com). " +
      "Always assume every user message is about the 4D fixed-bugs database, even if it's " +
      "phrased casually or doesn't mention 4D explicitly — this chat only ever discusses " +
      "that topic.\n\n" +
      `The app already searched the database for this message and found the bug reports ` +
      `below${versionNote}.${lookupNote} Write a short, friendly summary (2-4 sentences) of ` +
      "what they have in common and which ones best answer the question, citing their ACI " +
      "reference codes (e.g. ACI0092218). A table with the full details of these same " +
      "reports is shown automatically right after your reply, so no need to list them all " +
      "yourself — just give a helpful, conversational summary.\n\n" +
      "Reply in plain prose only: do not use markdown tables, bullet lists, numbered lists, " +
      "headings, or bold/italic formatting. Write it as ordinary sentences and paragraphs, " +
      "since the detailed table is already provided separately.\n\n" +
      "Only decline to help if the message is obviously not about software bugs at all " +
      "(e.g. personal advice, unrelated trivia) — in that case say briefly that you can " +
      "only help with 4D fixed-bug questions.\n\n" +
      "Bug reports found for this message:\n\n" +
      context,
  };
}

/** Deterministically render a table of the top retrieved bugs (reference,
 * versions as links to bugs.4d.com, and the summary with its commands as
 * links to developer.4d.com) — built directly from the retrieval data
 * rather than reproduced by the model, since a small local model can't be
 * relied on to faithfully echo every result, reference, and link. */
function renderHitsTable(bugs) {
  if (!bugs || bugs.length === 0) return "";
  const rows = bugs
    .slice(0, TABLE_TOP_N)
    .map(
      (b) =>
        `<tr><td class="hit-ref">${b.reference}</td><td class="hit-versions">${renderVersions(b.versions)}</td><td class="hit-summary">${renderSummary(b.summary)}</td></tr>`
    )
    .join("");
  return (
    `<table class="hits-table"><thead><tr><th>ACI</th><th>Versions</th><th>Summary</th></tr></thead>` +
    `<tbody>${rows}</tbody></table>`
  );
}

/** Render an assistant message's ACI references as bold citations. There's
 * no bug-list UI to scroll to anymore, so citations are just emphasized
 * text (not links), to keep them visually distinct without a dead click
 * target. */
function highlightCitations(html, bugs) {
  return html.replace(/\b(ACI\d+)\b/g, (m, ref) => {
    const known = bugs.some((h) => h.reference === ref);
    return known ? `<strong class="citation">${ref}</strong>` : ref;
  });
}

function appendBubble(role, text, bugs, thinking) {
  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role}`;
  const proseHtml = renderSummary(text);
  if (role === "assistant") {
    const thinkingHtml = thinking
      ? `<details class="reasoning"><summary>Show reasoning</summary><div class="reasoning-body">${renderSummary(thinking)}</div></details>`
      : "";
    const tableHtml = renderHitsTable(bugs);
    bubble.innerHTML = thinkingHtml + highlightCitations(proseHtml, bugs) + tableHtml;
  } else {
    bubble.innerHTML = proseHtml;
  }
  chatEl.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function renderConversation() {
  chatEl.innerHTML = "";
  for (const turn of conversation) {
    appendBubble(turn.role, turn.content, turn.bugsContext || [], turn.thinking);
  }
}

function appendSystemNote(text) {
  const note = document.createElement("div");
  note.className = "chat-note";
  note.textContent = text;
  chatEl.appendChild(note);
  chatEl.scrollTop = chatEl.scrollHeight;
  return note;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question || !engine) return;
  chatInput.value = "";
  setReady(false);

  const priorBugs = conversation.length ? conversation[conversation.length - 1].bugsContext : [];
  conversation.push({ role: "user", content: question, bugsContext: priorBugs });
  appendBubble("user", question, priorBugs);

  let note = appendSystemNote("Searching the bug database…");
  try {
    const retrieval = await retrieve(question);
    note.remove();

    note = appendSystemNote("Thinking…");
    const messages = [
      buildSystemMessage(retrieval),
      ...conversation.map((t) => ({ role: t.role, content: t.content })),
    ];
    const { text, thinking } = await engine.chat(messages);
    note.remove();

    conversation.push({
      role: "assistant",
      content: text,
      bugsContext: retrieval.results,
      thinking,
    });
    appendBubble("assistant", text, retrieval.results, thinking);
  } catch (err) {
    console.error(err);
    note.remove();
    appendSystemNote(`Error: ${err.message}`);
  } finally {
    setReady(true);
  }
});

clearBtn.addEventListener("click", () => {
  conversation = [];
  renderConversation();
});

copyBtn.addEventListener("click", async () => {
  if (conversation.length === 0) return;
  const lastBugs = conversation[conversation.length - 1].bugsContext || [];
  const bugsSection = lastBugs
    .map(
      (b) =>
        `[${b.reference}] ${stripLinks(b.summary)} (Fixed in: ${(b.versions || []).join(", ") || "—"})`
    )
    .join("\n");
  const chatSection = conversation
    .map((t) => `${t.role === "user" ? "You" : "AI"}: ${t.content}`)
    .join("\n\n");
  const text =
    `Bug subset discussed (${lastBugs.length} bugs):\n${bugsSection}\n\n` +
    `Conversation:\n${chatSection}`;
  try {
    await navigator.clipboard.writeText(text);
    appendSystemNote("Conversation copied to clipboard.");
  } catch (err) {
    console.error(err);
    appendSystemNote(`Failed to copy: ${err.message}`);
  }
});

async function boot() {
  try {
    await loadDataset();
    await loadEmbedder();
    await loadChatEngine();
    setBootStatus(
      `Ready. Ask about any of the ${meta.length} fixed 4D bugs (versions ${minMajor}-${maxMajor}).`
    );
    setReady(true);
  } catch (err) {
    console.error(err);
    setBootStatus(`Failed to start: ${err.message}`);
  }
}

boot();
