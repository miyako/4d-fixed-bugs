import { renderSummary, renderVersions } from "./render.js";
import { parseVersionIntent, bugMatchesIntent, describeIntent } from "./version.js";
import { buildCommandIndex, extractCommandMentions } from "./commands.js";
import * as webllmEngine from "./engines/webllm-engine.js";
import { getLocale } from "./i18n.js";

/**
 * Single-interface chat app: semantic search over the 4D fixed-bugs
 * dataset is performed automatically, behind the scenes, on every user
 * message (no separate search bar/results list/selection UI). By
 * default this is a fully deterministic tool: retrieval alone (ACI
 * lookup, classic version/command matching, semantic ranking) drives a
 * templated reply plus the results table below it — no LLM involved,
 * so it's instant and always factually exact. A local WebLLM chat layer
 * is still available behind a flag for anyone who wants an actual
 * conversational summary on top of the same retrieval; see CHAT_ENGINE
 * below.
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

// The page's <html lang> selects the dataset, embedding model and UI
// strings (see i18n.js). CDN versions are pinned there for reproducibility.
const LOCALE = getLocale(document.documentElement.lang);
const T = LOCALE.t;
const EMBED_DIM = LOCALE.embedding.dim;
const TOP_K = 15;
const TABLE_TOP_N = 8;
// Cosine-similarity floor below which a semantic match is considered
// irrelevant and dropped entirely, rather than always padding the
// results out to TOP_K regardless of how weak the match is.
const MIN_SCORE = LOCALE.scores.min;
// Finer bands (all >= MIN_SCORE, since anything below it is already
// excluded) used purely to color-code the "Match" badge in the UI.
const SCORE_TIER_HIGH = LOCALE.scores.high;
const SCORE_TIER_MEDIUM = LOCALE.scores.medium;

/** Bucket a cosine-similarity score into a confidence tier for display. */
function scoreTier(score) {
  if (score >= SCORE_TIER_HIGH) return "high";
  if (score >= SCORE_TIER_MEDIUM) return "medium";
  return "low";
}

/**
 * Chat engine selection. "deterministic" (the default) means no LLM at
 * all: replies are a plain templated summary of what was searched and
 * found. "webllm" implements a minimal interface (`init(onProgress)`,
 * `chat(messages) -> {text, thinking}`, `reset()`), so everything else
 * in this file — retrieval, system-prompt construction, conversation
 * state, chat UI — is engine-agnostic. See
 * docs/src/engines/webllm-engine.js.
 *
 * (A second engine, LFM2.5-1.2B-Thinking via onnxruntime-web/WebGPU, was
 * tried as a comparison build and removed — its WebGPU backend could
 * not be reliably loaded from a CDN/static-hosting setup; see
 * SESSION_NOTES_LFM25_COMPARISON.md for the full writeup.)
 *
 * A `?engine=webllm` / `?engine=deterministic` URL query param overrides
 * this constant, purely as a convenience for side-by-side
 * testing/comparison without editing source.
 */
const DEFAULT_CHAT_ENGINE = "deterministic"; // "deterministic" | "webllm"
const CHAT_ENGINE =
  new URLSearchParams(location.search).get("engine") ||
  document.body.dataset.engine ||
  DEFAULT_CHAT_ENGINE;

function createChatEngine() {
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
  setBootStatus(T.loadingData);
  // Resolve relative to this module's own URL (not the page URL), so
  // this works regardless of which page loads app.js.
  const dataUrl = (name) => new URL(`${LOCALE.dataDir}${name}`, import.meta.url);
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
  setBootStatus(T.loadingModel);
  const { pipeline, env } = await import(LOCALE.embedding.library);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  embedder = await pipeline("feature-extraction", LOCALE.embedding.model, LOCALE.embedding.options);
}

async function loadChatEngine() {
  setBootStatus(T.loadingChat);
  engine = createChatEngine();
  await engine.init((text) => setBootStatus(text || T.loadingChatShort));
}

/** Extract explicit ACI bug reference IDs mentioned in a message (e.g.
 * "ACI0101931", "aci101931", "ACI 101931") and normalize them to the
 * dataset's exact format: "ACI" + 7 zero-padded digits. */
function extractExplicitRefs(text) {
  const refs = new Set();
  for (const m of text.normalize("NFKC").matchAll(/\bACI\s*0*(\d{1,7})\b/gi)) {
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
  // NFKC so full-width input ("ＧＯＴＯ　ＯＢＪＥＣＴ") still matches.
  const commandMentions = extractCommandMentions(query.normalize("NFKC"), commandIndex);

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

  const output = await embedder(LOCALE.embedding.queryPrefix + query, { pooling: "mean", normalize: true });
  const queryVec = output.data;
  const scored = pool.map((i) => ({ index: i, score: dot(embeddings, i * EMBED_DIM, queryVec) }));
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter((s) => s.score >= MIN_SCORE);
  const noRelevantResults = scored.length > 0 && relevant.length === 0;
  const results = relevant.slice(0, TOP_K).map((s) => ({ ...meta[s.index], score: s.score }));
  return {
    results,
    intent,
    usedFallback,
    commandMentions,
    usedCommandFallback,
    explicitRefs: explicitRefs.length > 0 ? explicitRefs : undefined,
    notFoundRefs: explicitRefs.length > 0 ? explicitRefs : [],
    noRelevantResults,
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
      T.replyLanguage +
      "Bug reports found for this message:\n\n" +
      context,
  };
}

/** Build a plain-text templated reply describing what was searched and
 * found, used instead of calling an LLM in the default deterministic
 * mode (CHAT_ENGINE === "deterministic"). No model involved: this is
 * generated purely from the retrieval() result. */
function buildDeterministicReply(retrieval) {
  const { results, intent, usedFallback, commandMentions, usedCommandFallback, explicitRefs, notFoundRefs, noRelevantResults } =
    retrieval;
  const intentDesc = describeIntent(intent, LOCALE.lang);

  if (explicitRefs && explicitRefs.length > 0) {
    if (results.length > 0 && (!notFoundRefs || notFoundRefs.length === 0)) {
      return T.foundDirect(explicitRefs);
    }
    if (notFoundRefs && notFoundRefs.length > 0) {
      return results.length > 0 ? T.notFoundWithResults(notFoundRefs) : T.notFoundNoResults(notFoundRefs);
    }
  }

  if (results.length === 0) {
    return noRelevantResults ? T.noRelevant : T.noResults;
  }

  const criteria = [];
  if (commandMentions.length > 0 && !usedCommandFallback) criteria.push(T.mentioning(commandMentions));
  if (intentDesc && !usedFallback) criteria.push(T.fixedIn(intentDesc));

  const fallbackNotes = [];
  if (usedCommandFallback) fallbackNotes.push(T.noExactMatchFor(commandMentions.join(", ")));
  if (usedFallback) fallbackNotes.push(T.noExactMatchFor(intentDesc));

  if (criteria.length === 0 && fallbackNotes.length === 0) {
    // Nothing extra to say beyond what the results table (with its match
    // scores) already shows — skip the generic "Found N bugs" preamble.
    return "";
  }

  let lead = T.found(results.length, criteria);
  if (fallbackNotes.length > 0) lead += T.fallback(fallbackNotes);

  return lead;
}

/** Deterministically render a table of the top retrieved bugs (reference,
 * versions as links to bugs.4d.com, and the summary with its commands as
 * links to developer.4d.com) — built directly from the retrieval data
 * rather than reproduced by the model, since a small local model can't be
 * relied on to faithfully echo every result, reference, and link. */
function renderMatchBadge(score) {
  if (score === undefined) return "";
  // An explicit ACI-reference lookup (score === 1) is an exact match, not
  // a semantic ranking — label it distinctly rather than showing "100%".
  if (score === 1) return `<span class="match-badge exact">${T.exact}</span>`;
  const pct = Math.round(score * 100);
  return `<span class="match-badge ${scoreTier(score)}">${pct}%</span>`;
}

function renderHitsTable(bugs) {
  if (!bugs || bugs.length === 0) return "";
  const rows = bugs
    .slice(0, TABLE_TOP_N)
    .map(
      (b) =>
        `<tr><td class="hit-ref">${b.reference}</td><td class="hit-match">${renderMatchBadge(b.score)}</td><td class="hit-versions">${renderVersions(b.versions)}</td><td class="hit-summary">${renderSummary(b.summary)}</td></tr>`
    )
    .join("");
  return (
    `<table class="hits-table"><thead><tr>${T.headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
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
      ? `<details class="reasoning"><summary>${T.showReasoning}</summary><div class="reasoning-body">${renderSummary(thinking)}</div></details>`
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

  let note = appendSystemNote(T.searching, { spinner: true });
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
      note = appendSystemNote(T.thinking, { spinner: true });
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
    appendSystemNote(T.error(err.message));
  } finally {
    setReady(true);
  }
});

clearBtn.addEventListener("click", () => {
  conversation = [];
  renderConversation();
});

/** Copy text to the clipboard, preferring the async Clipboard API but
 * falling back to the legacy execCommand("copy") approach if it's
 * rejected. Some browsers (notably Firefox) can spuriously reject
 * navigator.clipboard.writeText on the very same click that also blurs
 * a focused text input — even though it's a genuine user gesture — and
 * only succeed on a second click. The execCommand fallback runs
 * synchronously within the same gesture, so it succeeds immediately
 * instead of requiring that extra click. */
async function copyTextToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the legacy fallback below.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.top = "-1000px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error(T.copyRejected);
    }
  } finally {
    document.body.removeChild(textarea);
  }
}

/** Escape a value for use inside a markdown table cell: collapse
 * newlines (which would otherwise break the row) and escape pipe
 * characters (which would otherwise split into extra columns). */
function escapeMdCell(text) {
  return text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}

/** Build the same match label shown in the on-screen badge ("Exact" for
 * a direct ACI lookup, otherwise a rounded percentage), as plain text
 * for the markdown table. */
function matchLabel(score) {
  if (score === undefined) return "";
  if (score === 1) return T.exact;
  return `${Math.round(score * 100)}%`;
}

/** Build a markdown table of the retrieved bugs, mirroring the columns
 * and row count of the on-screen results table (ACI reference, match
 * confidence, versions, plain-text summary) so "Copy" reproduces
 * exactly what's visible, not a conversational transcript. */
function buildResultsMarkdownTable(bugs) {
  const rows = bugs.slice(0, TABLE_TOP_N);
  const header = `| ${T.headers.join(" | ")} |\n| --- | --- | --- | --- |`;
  const body = rows
    .map(
      (b) =>
        `| ${b.reference} | ${matchLabel(b.score)} | ${escapeMdCell((b.versions || []).join(", ") || "—")} | ${escapeMdCell(stripLinks(b.summary))} |`
    )
    .join("\n");
  return `${header}\n${body}`;
}

copyBtn.addEventListener("click", async () => {
  if (conversation.length === 0) return;
  // Release focus from the search input first: on some browsers, a
  // click that both blurs a focused input and triggers a clipboard
  // write in the same event can confuse the browser's user-activation
  // check for the async Clipboard API.
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const lastBugs = conversation[conversation.length - 1].bugsContext || [];
  if (lastBugs.length === 0) {
    appendSystemNote(T.nothingToCopy);
    return;
  }
  const text = buildResultsMarkdownTable(lastBugs);
  try {
    await copyTextToClipboard(text);
    appendSystemNote(T.copied);
  } catch (err) {
    console.error(err);
    appendSystemNote(T.copyFailed(err.message));
  }
});



async function boot() {
  try {
    await loadDataset();
    await loadEmbedder();
    if (CHAT_ENGINE !== "deterministic") {
      await loadChatEngine();
    }
    setBootStatus(T.ready(meta.length, minMajor, maxMajor));
    setReady(true);
  } catch (err) {
    console.error(err);
    setBootStatus(T.failed(err.message));
  }
}

boot();
