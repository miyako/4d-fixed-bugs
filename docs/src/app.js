import { renderSummary, renderVersions } from "./render.js";
import { parseVersionIntent, bugMatchesIntent, describeIntent } from "./version.js";

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
const WEBLLM_CDN_URL = "https://esm.run/@mlc-ai/web-llm@0.2.79";
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const CHAT_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const EMBED_DIM = 384;
const TOP_K = 15;
const TABLE_TOP_N = 8;

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
  const [metaRes, binRes] = await Promise.all([
    fetch("data/meta.json"),
    fetch("data/embeddings.bin"),
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
  const webllm = await import(WEBLLM_CDN_URL);
  engine = await webllm.CreateMLCEngine(CHAT_MODEL_ID, {
    initProgressCallback: (progress) => {
      setBootStatus(progress.text || "Loading local AI model…");
    },
  });
}

/** Automatic retrieval for a user message: parse any version reference,
 * filter by it if present, then rank by semantic similarity. */
async function retrieve(query) {
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
  return { results, intent, usedFallback };
}

function buildSystemMessage(retrieval) {
  const { results, intent, usedFallback } = retrieval;
  const intentDesc = describeIntent(intent);
  const context = results
    .map((h) => `[${h.reference}] (versions: ${(h.versions || []).join(", ") || "unknown"}) ${stripLinks(h.summary)}`)
    .join("\n\n");

  let versionNote = "";
  if (intentDesc) {
    versionNote = usedFallback
      ? `\n\nThe user's message referenced ${intentDesc}, but no bugs matched that exact filter, so the reports below are the best overall semantic matches instead. Mention this to the user.`
      : `\n\nThe user's message referenced ${intentDesc}. The bug reports below have already been filtered to that version scope and ranked by relevance.`;
  }

  return {
    role: "system",
    content:
      "You are an assistant for a database of fixed 4D software bugs (bugs.4d.com). " +
      "The database ONLY contains fixed 4D bug reports — nothing else. If the user asks " +
      "about anything outside that scope (general programming help, other software, small " +
      "talk, etc.), politely and professionally decline and explain you can only discuss " +
      "the 4D fixed-bugs database.\n\n" +
      "IMPORTANT: the app has ALREADY searched the database for this exact message and " +
      "the results are listed below under \"Retrieved bug reports\" — these ARE the search " +
      "results, already found for you. Never say you have no information, can't search, or " +
      "don't have access to the database: if the list below is non-empty, you already have " +
      "real results in front of you and must use them. Only say the database has nothing " +
      "relevant if the list below is genuinely unrelated to the question after you've " +
      "actually read it.\n\n" +
      "For every user message, the app automatically searches this database: it detects " +
      "any 4D version mentioned in the message and applies these filter rules before " +
      "ranking by semantic relevance:\n" +
      "- A specific version like \"v20\", \"20\", or \"20.1\" -> that major version and all " +
      "its releases/hotfixes (20, 20.*).\n" +
      "- An R-release like \"v19 R8\" or \"19r8\" -> exactly that R-release plus the entire " +
      "next major version, since R-releases are effectively previews of the next major.\n" +
      "- An approximate version like \"around v18\" or \"18 or thereabouts\" -> one major " +
      "version below and one above (17, 18, 19).\n" +
      "- An open-ended range like \"before 17\" or \"after 20\" -> all matching versions in " +
      "that direction that exist in the database.\n\n" +
      "Write a short, focused prose summary (2-4 sentences) of what these reports have in " +
      "common and which are most relevant to the question, citing ACI reference codes " +
      "(e.g. ACI0092218) for the claims you make. Do NOT restate every report in full or " +
      "produce a table/list yourself — the app will automatically display a table with the " +
      "full details (references, versions, and commands) of the top matches right below " +
      "your reply, so keep your prose short and complementary to that table rather than " +
      "duplicating it." +
      versionNote +
      "\n\nRetrieved bug reports:\n\n" +
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

function appendBubble(role, text, bugs) {
  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role}`;
  const proseHtml = renderSummary(text);
  if (role === "assistant") {
    const tableHtml = renderHitsTable(bugs);
    bubble.innerHTML = highlightCitations(proseHtml, bugs) + tableHtml;
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
    appendBubble(turn.role, turn.content, turn.bugsContext || []);
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
    const reply = await engine.chat.completions.create({ messages });
    note.remove();

    const text = reply.choices[0].message.content;
    conversation.push({ role: "assistant", content: text, bugsContext: retrieval.results });
    appendBubble("assistant", text, retrieval.results);
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
