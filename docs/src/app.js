import { renderSummary, renderVersions } from "./render.js";
import { parseVersionIntent, bugMatchesIntent, describeIntent } from "./version.js";
import { buildCommandIndex, extractCommandMentions } from "./commands.js";
import * as webllmEngine from "./engines/webllm-engine.js";
import * as lfm25Engine from "./engines/lfm25-engine.js";

/**
 * Single-interface chat app: semantic search over the 4D fixed-bugs
 * dataset is performed automatically, behind the scenes, on every user
 * message (no separate search bar/results list/selection UI). By
 * default this is a fully deterministic tool: retrieval alone (ACI
 * lookup, classic version/command matching, semantic ranking) drives a
 * templated reply plus the results table below it — no LLM involved,
 * so it's instant and always factually exact. A local LLM chat layer
 * (WebLLM or LFM2.5-1.2B-Thinking) is still available behind a flag for
 * anyone who wants an actual conversational summary on top of the same
 * retrieval; see CHAT_ENGINE below and docs/lfm25/index.html.
 *
 * Design note: retrieval never depends on a model to decide when/how to
 * "call" a search tool. It always runs in this file for every user
 * turn: it looks for an explicit ACI reference first, then an exact
 * (case-sensitive) command-name mention and/or a version reference (see
 * commands.js / version.js for the exact rules), filters the dataset
 * accordingly, then ranks by semantic similarity. When an LLM engine is
 * enabled, the system prompt explains this process and provides the
 * retrieved bug reports as grounding context so the model only has to
 * summarize, not search.
 */

// Pinned CDN versions for reproducibility.
const TRANSFORMERS_CDN_URL =
  "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;
const TOP_K = 15;
const TABLE_TOP_N = 8;

/**
 * Chat engine selection. "deterministic" (the default) means no LLM at
 * all: replies are a plain templated summary of what was searched and
 * found. "webllm" and "lfm25" both implement the same minimal interface
 * (`init(onProgress)`, `chat(messages) -> {text, thinking}`, `reset()`),
 * so everything else in this file — retrieval, system-prompt
 * construction, conversation state, chat UI — is engine-agnostic. See
 * docs/src/engines/webllm-engine.js and docs/src/engines/lfm25-engine.js,
 * and SESSION_NOTES_LFM25_COMPARISON.md for why the LLM engines exist
 * and how they compare.
 *
 * A `?engine=webllm` / `?engine=lfm25` / `?engine=deterministic` URL
 * query param (or a `data-engine` attribute on <body>, as used by
 * docs/lfm25/index.html) overrides this constant, purely as a
 * convenience for side-by-side testing/comparison without editing
 * source.
 */
const DEFAULT_CHAT_ENGINE = "deterministic"; // "deterministic" | "webllm" | "lfm25"
const CHAT_ENGINE =
  new URLSearchParams(location.search).get("engine") ||
  document.body.dataset.engine ||
  DEFAULT_CHAT_ENGINE;

function createChatEngine() {
  if (CHAT_ENGINE === "lfm25") return lfm25Engine.createEngine();
  if (CHAT_ENGINE === "webllm") return webllmEngine.createEngine();
  return null; // deterministic mode: no LLM engine at all.
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
/** @type {string[]} Longest-first list of distinct command names present
 * in the dataset, for classic (exact) command-mention matching. */
let commandIndex = [];

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
  commandIndex = buildCommandIndex(meta);
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

/** Automatic retrieval for a user message:
 *  1. If the message explicitly names one or more ACI bug reference
 *     IDs, look those up directly (exact match, no search needed).
 *  2. Otherwise, run "classic" (exact, not semantic) matching: an
 *     exact-cased command-name mention (see commands.js) and/or a
 *     parsed version reference (see version.js) each narrow the
 *     candidate pool if present.
 *  3. Rank whatever's left by semantic similarity and take the top K.
 * Each classic filter falls back to "no narrowing" (with a flag the
 * caller can surface) if it would otherwise eliminate every bug. */
async function retrieve(query) {
  const explicitRefs = extractExplicitRefs(query);
  if (explicitRefs.length > 0) {
    const found = explicitRefs
      .map((ref) => meta.find((b) => b.reference === ref))
      .filter(Boolean);
    const notFound = explicitRefs.filter((ref) => !found.some((b) => b.reference === ref));
    if (found.length > 0) {
      const results = found.map((b) => ({ ...b, score: 1 }));
      return {
        results,
        intent: null,
        usedFallback: false,
        commandMentions: [],
        usedCommandFallback: false,
        explicitRefs,
        notFoundRefs: notFound,
      };
    }
    // None of the mentioned IDs exist in the dataset — fall through to
    // semantic search, but remember which IDs were unrecognized so the
    // reply/system prompt can mention that.
  }

  const intent = parseVersionIntent(query, minMajor, maxMajor);
  const commandMentions = extractCommandMentions(query, commandIndex);

  let pool = meta.map((_, i) => i);
  let usedCommandFallback = false;
  if (commandMentions.length > 0) {
    const filtered = pool.filter((i) => meta[i].commands?.some((c) => commandMentions.includes(c)));
    if (filtered.length > 0) {
      pool = filtered;
    } else {
      usedCommandFallback = true;
    }
  }

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
    commandMentions,
    usedCommandFallback,
    explicitRefs: explicitRefs.length > 0 ? explicitRefs : undefined,
    notFoundRefs: explicitRefs.length > 0 ? explicitRefs : [],
  };
}

function buildSystemMessage(retrieval) {
  const { results, intent, usedFallback, commandMentions, usedCommandFallback, explicitRefs, notFoundRefs } =
    retrieval;
  const intentDesc = describeIntent(intent);
  const context = results
    .map((h) => `[${h.reference}] (versions: ${(h.versions || []).join(", ") || "unknown"}) ${stripLinks(h.summary)}`)
    .join("\n\n");

  let versionNote = "";
  if (intentDesc && usedFallback) {
    versionNote = ` (note: no bugs matched ${intentDesc} specifically, so these are the closest overall matches instead)`;
  }

  let commandNote = "";
  if (commandMentions.length > 0 && usedCommandFallback) {
    commandNote = ` (note: no bugs specifically mention ${commandMentions.join(", ")}, so these are the closest overall matches instead)`;
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
      "Before ranking by semantic similarity, the app also does classic (exact, not semantic) " +
      "matching: an exact-cased 4D command name mentioned in the message (e.g. GOTO OBJECT, " +
      "Print form) narrows results to bugs whose commands include it, and a version reference " +
      "narrows results using the version rules below — so retrieval is deterministic, not left " +
      "to the model.\n\n" +
      `The app already searched the database for this message and found the bug reports ` +
      `below${versionNote}${commandNote}.${lookupNote} Write a short, friendly summary (2-4 ` +
      "sentences) of what they have in common and which ones best answer the question, citing " +
      "their ACI reference codes (e.g. ACI0092218). A table with the full details of these " +
      "same reports is shown automatically right after your reply, so no need to list them all " +
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

/** Build a plain-text templated reply describing what was searched and
 * found, used instead of calling an LLM in the default deterministic
 * mode (CHAT_ENGINE === "deterministic"). No model involved: this is
 * generated purely from the retrieval() result. */
function buildDeterministicReply(retrieval) {
  const { results, intent, usedFallback, commandMentions, usedCommandFallback, explicitRefs, notFoundRefs } =
    retrieval;
  const intentDesc = describeIntent(intent);

  if (explicitRefs && explicitRefs.length > 0) {
    if (results.length > 0 && (!notFoundRefs || notFoundRefs.length === 0)) {
      return explicitRefs.length === 1
        ? `Found ${explicitRefs[0]} directly — see the details below.`
        : `Found ${explicitRefs.join(", ")} directly — see the details below.`;
    }
    if (notFoundRefs && notFoundRefs.length > 0) {
      return results.length > 0
        ? `${notFoundRefs.join(", ")} doesn't exist in the database. Here are the closest matches by search instead:`
        : `${notFoundRefs.join(", ")} doesn't exist in the database, and no similar bugs were found either.`;
    }
  }

  if (results.length === 0) {
    return "No bugs matched that search.";
  }

  const criteria = [];
  if (commandMentions.length > 0 && !usedCommandFallback) criteria.push(`mentioning ${commandMentions.join(", ")}`);
  if (intentDesc && !usedFallback) criteria.push(`fixed in ${intentDesc}`);

  let lead = `Found ${results.length} bug${results.length === 1 ? "" : "s"}`;
  if (criteria.length > 0) lead += " " + criteria.join(" and ");
  lead += ".";

  const fallbackNotes = [];
  if (usedCommandFallback) fallbackNotes.push(`no exact match for ${commandMentions.join(", ")}`);
  if (usedFallback) fallbackNotes.push(`no exact match for ${intentDesc}`);
  if (fallbackNotes.length > 0) {
    lead += ` No exact match for that${fallbackNotes.length > 1 ? " (" + fallbackNotes.join("; ") + ")" : ""} — showing the closest overall matches instead.`;
  }

  return lead + " Top matches below.";
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

function appendSystemNote(text, { spinner = false } = {}) {
  const note = document.createElement("div");
  note.className = "chat-note";
  if (spinner) {
    const dots = document.createElement("span");
    dots.className = "typing-indicator";
    dots.innerHTML = "<span></span><span></span><span></span>";
    const label = document.createElement("span");
    label.textContent = text;
    note.append(dots, label);
  } else {
    note.textContent = text;
  }
  chatEl.appendChild(note);
  chatEl.scrollTop = chatEl.scrollHeight;
  return note;
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = chatInput.value.trim();
  if (!question) return;
  if (CHAT_ENGINE !== "deterministic" && !engine) return;
  chatInput.value = "";
  setReady(false);

  const priorBugs = conversation.length ? conversation[conversation.length - 1].bugsContext : [];
  conversation.push({ role: "user", content: question, bugsContext: priorBugs });
  appendBubble("user", question, priorBugs);

  let note = appendSystemNote("Searching the bug database…", { spinner: true });
  try {
    const retrieval = await retrieve(question);
    note.remove();
    note = null;

    let text, thinking;
    if (CHAT_ENGINE === "deterministic") {
      // No LLM call at all: the reply is a plain template generated
      // directly from the retrieval result.
      text = buildDeterministicReply(retrieval);
      thinking = null;
    } else {
      note = appendSystemNote("Thinking…", { spinner: true });
      const messages = [
        buildSystemMessage(retrieval),
        ...conversation.map((t) => ({ role: t.role, content: t.content })),
      ];
      ({ text, thinking } = await engine.chat(messages));
      note.remove();
      note = null;
    }

    conversation.push({
      role: "assistant",
      content: text,
      bugsContext: retrieval.results,
      thinking,
    });
    appendBubble("assistant", text, retrieval.results, thinking);
  } catch (err) {
    console.error(err);
    if (note) note.remove();
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
    if (CHAT_ENGINE !== "deterministic") {
      await loadChatEngine();
    }
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
