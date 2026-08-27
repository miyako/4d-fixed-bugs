# 4D Fixed Bugs — Semantic Search Chat

A fully static, client-side web app that lets a user ask natural-language
questions about a dataset of 2,420 fixed 4D software bugs and get back
relevant bug reports, ranked by semantic similarity, with an optional
local-LLM conversational layer on top. There is no backend and no server
of any kind at request time: everything (dataset, embeddings, embedding
model, optional chat model) is fetched by and executed entirely inside
the visiting browser. This document describes the current, final
implementation in enough detail to recreate it from scratch.

## 1. Hosting & deployment

- Hosted as a static site via **GitHub Pages**, configured to serve from
  the `main` branch's `/docs` folder (repo Settings → Pages → source
  `main` / `/docs`). No build step, no GitHub Action — Pages serves the
  committed files as-is.
- Live URL: `https://miyako.github.io/4d-fixed-bugs/`.
- Every deployed HTML page references its CSS/JS with a manual
  cache-busting query string (`style.css?v=N`, `src/app.js?v=N`),
  bumped by one on every commit that changes JS/CSS content. This is
  necessary because GitHub Pages serves static assets with
  `Cache-Control: max-age=600` (10 minutes) and gives no way to set
  custom response headers, so without a version bump a browser tab
  opened just before a deploy can keep running stale JS for up to 10
  minutes after.
- No custom domain / CNAME. HTTPS enforced (GitHub Pages default).

## 2. Directory layout

```
docs/                      # GitHub Pages root (served as /)
  index.html                # the single page
  style.css                 # all styling (light + dark)
  assets/
    banner.png               # 128x128 app-bar logo/icon
  data/
    meta.json                 # array of {reference, summary, commands, versions}, one per bug, index-aligned with embeddings.bin
    embeddings.bin             # raw Float32Array, row-major, N rows x 384 cols, L2-normalized
  src/
    app.js                     # entry point: boot, retrieval, chat UI, deterministic reply builder
    render.js                  # safe minimal-markdown renderer for summaries + version links
    version.js                 # natural-language version-reference parsing/matching
    commands.js                # exact command-name mention matching
    engines/
      webllm-engine.js           # optional local-LLM engine (WebLLM / Llama-3.2-1B)

data/                       # source dataset + offline precompute inputs (NOT served by Pages;
                             # docs/data/* is the built output copied/generated from these)
  all_bugs_enriched.json      # [{reference, summary (markdown w/ dev.4d.com links), commands}]
  all_bugs_context.json       # [{reference, raw_summary, versions, jp_notes, matched_commands}]
  command_index.json          # {commandName: {title, url}} — reference data, not consumed by the client at runtime
  bugs_raw.json, jp_notes.json, pilot_bugs.json, pilot_report.md  # earlier crawl/pipeline artifacts, not used by the deployed app

scripts/
  generate_embeddings.mjs     # offline Node precompute: builds docs/data/{meta.json,embeddings.bin} from data/*.json
  package.json                 # scripts-only deps: @xenova/transformers@2.17.2
  crawl_4d_bugs.sh             # original dataset-crawling script (unrelated to the web app itself)
```

## 3. Data model

Each bug record (as embedded 1:1 in `docs/data/meta.json`, aligned by
array index with the corresponding row of `docs/data/embeddings.bin`)
has this shape:

```json
{
  "reference": "ACI0092218",
  "summary": "On Mac only, printing a form containing a PDF or PICT picture placed as a static object, using [Print form](https://developer.4d.com/docs/commands/print-form) together with the Page Setup dialog, could crash the application inside [PAGE BREAK](https://developer.4d.com/docs/commands/page-break) processing. ...",
  "commands": ["Print form", "PAGE BREAK"],
  "versions": ["15", "19.5_hf1", "19.6", "19_r7"]
}
```

- `reference`: ACI bug-tracker ID, always `"ACI"` + exactly 7 zero-padded
  digits (e.g. `ACI0092218`).
- `summary`: English prose, a small fixed markdown subset only —
  `[text](url)` links (always to `https://developer.4d.com/...` command
  docs), `` `code` `` inline spans, and `*italic*` spans. No bold, no
  fenced code blocks, no headings, no tables appear anywhere in the
  dataset.
- `commands`: array of 4D command names (exact casing as documented on
  developer.4d.com) mentioned in the summary, e.g. `"GOTO OBJECT"`,
  `"Print form"`.
- `versions`: array of 4D version strings the bug was fixed in, formats
  seen: plain major (`"15"`), major.minor (`"19.6"`), hotfix
  (`"19.5_hf1"`), and R-release (`"19_r7"`, optionally with its own
  hotfix suffix like `"20_r10_hf2"`).

Dataset size: 2,420 bugs. Embedding: 384-dim (`all-MiniLM-L6-v2`),
Float32, L2-normalized. `embeddings.bin` is therefore exactly
`2420 * 384 * 4` bytes = 3,717,120 bytes, row `i` (0-indexed) being the
embedding for `meta.json[i]`.

### Source data (`data/`, not served — precompute inputs only)

- `data/all_bugs_enriched.json`: array of `{reference, summary, commands}`
  — the final English summary text with command doc-links already
  embedded as markdown, plus the parsed `commands` list. This is the
  primary source for `summary` and `commands`.
- `data/all_bugs_context.json`: array of `{reference, raw_summary,
  versions, jp_notes, matched_commands}` — this is the source of the
  `versions` array (joined into the final record by `reference`). Other
  fields (`raw_summary`, `jp_notes`, `matched_commands`) are earlier
  pipeline artifacts not used by `generate_embeddings.mjs` or the web
  app.
- `data/command_index.json`: `{commandName: {title, url}}` map of every
  known 4D command to its developer.4d.com doc URL — a reference
  artifact from the crawl pipeline; the deployed client does **not**
  read this file (it builds its own runtime command list, see §6.3,
  directly from `meta.json`'s per-bug `commands` arrays).

## 4. Offline precompute (`scripts/generate_embeddings.mjs`)

Run manually, once (or whenever the dataset changes), from `scripts/`:

```
cd scripts
npm install         # installs @xenova/transformers@2.17.2 only
node generate_embeddings.mjs
```

Steps:
1. Load `data/all_bugs_enriched.json` and `data/all_bugs_context.json`.
2. Join them by `reference`: for each enriched bug, look up its
   `versions` array from the context file (defaulting to `[]` if
   missing).
3. Build the final `records` array: `{reference, summary, commands,
   versions}` — this becomes `docs/data/meta.json` verbatim
   (`JSON.stringify(records)`, no pretty-printing).
4. Load the `Xenova/all-MiniLM-L6-v2` feature-extraction pipeline via
   `@xenova/transformers`, quantized (`{ quantized: true }`).
5. For each bug, strip markdown links down to plain link text (`[text
   ](url)` → `text`) via the same regex used for stripping links at
   query time in the client (`app.js`'s `stripLinks`), so the model
   embeds clean prose rather than URL noise.
6. Embed in batches of 32 with `pooling: "mean", normalize: true`
   (mean-pooled, L2-normalized 384-dim vectors) and pack every batch's
   flat `Float32Array` output directly into one big pre-allocated
   `Float32Array(records.length * 384)` at the correct row offset.
7. Write `docs/data/embeddings.bin` as the raw bytes of that
   `Float32Array` (`Buffer.from(floatArray.buffer)`) and
   `docs/data/meta.json` as the records array.

This script is the **only** place embeddings are ever computed — the
browser never re-embeds the dataset, only the user's query at search
time, using the identical model/pooling/normalization settings so query
and corpus vectors are directly comparable via dot product.

## 5. Page structure (`docs/index.html`)

Single HTML page, no separate results page, no client-side router.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <title>4D Fixed Bugs — Search</title>
  <link rel="stylesheet" href="style.css?v=N" />
</head>
<body>
  <header class="app-bar">                     <!-- fixed/sticky top bar -->
    <div class="app-bar-inner">
      <img class="app-bar-logo" src="assets/banner.png" alt="4D Fixed Bugs" />
      <form id="chat-form" class="app-bar-form">
        <input id="chat-input" type="text" placeholder="Ask about a 4D bug fix…" autocomplete="off" disabled />
        <button type="submit" class="icon-btn icon-btn-primary" disabled title="Query">
          <svg><!-- magnifying-glass icon --></svg><span>Query</span>
        </button>
        <button id="clear-btn" type="button" class="icon-btn" title="Clear conversation">
          <svg><!-- trash icon --></svg><span>Clear</span>
        </button>
        <button id="copy-btn" type="button" class="icon-btn" title="Copy conversation">
          <svg><!-- clipboard icon --></svg><span>Copy</span>
        </button>
      </form>
    </div>
  </header>

  <main>
    <p class="subtitle">Ask about 4D bug fixes in natural language, by version (e.g. "v20",
      "around v18", "before 17"), by exact command name (e.g. GOTO OBJECT), or by ACI
      reference ID. Runs entirely in your browser — no server, no data leaves your
      machine, no LLM required.</p>
    <div id="boot-status" class="status" role="status">Starting up…</div>
    <div id="chat" class="chat-container"></div>
  </main>

  <footer>
    <p>Data crawled from <a href="https://bugs.4d.com">bugs.4d.com</a>. Embeddings:
       all-MiniLM-L6-v2 via <a href="https://huggingface.co/docs/transformers.js">transformers.js</a>.</p>
  </footer>

  <script type="module" src="src/app.js?v=N"></script>
</body>
</html>
```

Key structural points:
- The input + 3 buttons live inside `<header class="app-bar">`, `position:
  fixed` to the viewport top, so it stays visible regardless of how far
  the chat transcript below is scrolled. `<main>` has matching
  `padding-top` so content isn't hidden behind the fixed bar.
- All three buttons carry an inline SVG icon (no icon font/library) plus
  a text label (`<span>Query</span>` etc.) — Query uses a
  magnifying-glass path, Clear a trash-can path, Copy a clipboard path.
- The input and submit button start `disabled` and are only enabled once
  `boot()` (in `app.js`) finishes loading the dataset + embedder (+
  optional chat engine).
- There is no separate "results list" UI — everything (both the
  conversational reply and the ranked-hits table) renders as chat
  bubbles inside `#chat`.
- `<meta name="color-scheme" content="light dark" />` plus pure-CSS
  `@media (prefers-color-scheme: dark)` gives automatic dark mode with
  no JS toggle.

## 6. Client application logic (`docs/src/app.js`)

### 6.1 Constants & configuration

```js
const TRANSFORMERS_CDN_URL = "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js";
const EMBED_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
const EMBED_DIM = 384;
const TOP_K = 15;          // candidates ranked/returned by retrieve()
const TABLE_TOP_N = 8;     // how many of those are actually rendered in the hits table
const DEFAULT_CHAT_ENGINE = "deterministic"; // "deterministic" | "webllm"
```

`CHAT_ENGINE` is resolved once at load time as: `?engine=` URL query
param → `document.body.dataset.engine` → `DEFAULT_CHAT_ENGINE`. This
lets you force WebLLM mode for testing via
`index.html?engine=webllm` without touching source.

### 6.2 Boot sequence (`boot()`)

1. `loadDataset()` — fetch `../data/meta.json` and
   `../data/embeddings.bin` in parallel (URLs resolved relative to
   `import.meta.url`, i.e. relative to `app.js` itself, not the page,
   so the same script works from any page depth). Parse JSON into
   `meta`, wrap the binary `ArrayBuffer` in a `Float32Array` as
   `embeddings`. Build `commandIndex` (see §6.3) and scan every bug's
   `versions` to compute `minMajor`/`maxMajor` (the actual major-version
   range present in the dataset, used later to sanity-check
   version-intent parsing).
2. `loadEmbedder()` — dynamically `import()` the transformers.js CDN
   URL, set `env.allowLocalModels = false` (never look for local model
   files) and `env.useBrowserCache = true` (cache the downloaded model
   in the browser's Cache Storage across visits), then
   `pipeline("feature-extraction", EMBED_MODEL_ID, { quantized: true })`.
3. If `CHAT_ENGINE !== "deterministic"`, also `loadChatEngine()` (see
   §7) — otherwise skipped entirely, so the deterministic default never
   downloads any LLM.
4. On success: status becomes `Ready. Ask about any of the ${N} fixed 4D
   bugs (versions ${min}-${max}).` and the input/button are enabled. On
   any failure: status becomes `Failed to start: ${err.message}` and the
   UI stays disabled.

### 6.3 Retrieval pipeline (`retrieve(query)`)

Runs on every submitted user message, always in this file — never
delegated to an LLM "tool call". Order of precedence:

1. **Explicit ACI lookup** (`extractExplicitRefs`): regex
   `/\bACI\s*0*(\d{1,7})\b/gi` finds every mention of an ACI ID in any
   casing/spacing (`ACI0101931`, `aci101931`, `ACI 101931`), normalizes
   each to `"ACI" + 7-digit zero-padded`, and dedupes via a `Set`. If
   any normalized ID matches a `meta[].reference` exactly, return those
   bug(s) directly with `score: 1`, no embedding call at all, and skip
   straight to reply-building. IDs mentioned but not found in the
   dataset are tracked separately (`notFoundRefs`) so the reply can
   say so; if *none* of the mentioned IDs exist, retrieval falls through
   to normal search instead of returning empty-handed.
2. **Classic command-name filter** (`extractCommandMentions`, from
   `commands.js`): build a longest-name-first list of every distinct
   command name across the dataset (`buildCommandIndex`, length ≥ 3
   chars only, to drop scraping-artifact 1-2 char entries), then scan
   the query for any of those names as an exact, **case-sensitive**,
   whole-word match (`\bNAME\b`), removing/blanking each match from a
   working copy of the query as it's found so a shorter name can't
   double-match inside an already-matched longer one (e.g. "OBJECT"
   inside "GOTO OBJECT"). Case-sensitivity is deliberate: many command
   names are ordinary English words when lowercased (`Date`, `Choose`,
   `QUERY`), so only an exactly-cased mention counts as a deliberate
   command reference. If any command names are found, filter the
   candidate pool to bugs whose `commands` array includes at least one
   of them — unless that filter would eliminate every candidate, in
   which case it's dropped (`usedCommandFallback = true`) and all bugs
   remain eligible.
3. **Classic version filter** (`parseVersionIntent`, from
   `version.js`): parses the query for one of these patterns (checked
   in this order, each gated to only match if the extracted major
   version actually falls within `[minMajor, maxMajor]`, to avoid
   treating unrelated numbers as version refs):
   - R-release: `/\bv?(\d{2})[\s_]?r\s*(\d+)\b/` → `{type:"r-release",
     major, rNum}` — matches "19 R8", "19r8", "v19_r8".
   - Approximate: `/\b(?:around|about|approx(?:imately)?|roughly)\s+v?(\d{2})\b/`
     or `/\bv?(\d{2})\b\s*(?:or\s+thereabouts|ish)\b/` → `{type:"approx",
     major}` — "around v18", "18ish".
   - Open-ended: `/\bbefore\s+v?(\d{2})\b/` → `{type:"before", major}`;
     `/\bafter\s+v?(\d{2})\b/` → `{type:"after", major}`.
   - Exact: `/\bv(?:ersion)?\.?\s*(\d{2})\b/` ("v20", "version 20"), or
     `/\b(\d{2})\.\d+\b/` ("20.1"), or as a last resort a bare
     `/\b(\d{2})\b/` → `{type:"exact", major}`.
   `bugMatchesIntent(bug, intent)` then checks each of the bug's
   `versions` strings (parsed via `parseVersionString`, which extracts
   `{major, rNum}` handling the `NN_rM` R-release format) against the
   intent type: `exact` → same major; `approx` → major within ±1;
   `before`/`after` → strictly less/greater; `r-release` → same major
   *and* same rNum, OR major is exactly `intent.major + 1` (an
   R-release is treated as a preview of the next major version, so all
   of the next major's bugs also match). Same empty-pool-fallback rule
   as the command filter (`usedFallback`).
4. **Semantic ranking**: embed the raw query (`embedder(query, {
   pooling: "mean", normalize: true })`), then for every index still in
   the (possibly filtered) pool compute a plain dot product against
   that bug's 384-float row in `embeddings` (`dot(embeddings, i*384,
   queryVec)` — since both vectors are L2-normalized, dot product =
   cosine similarity, computed as a manual `for` loop, no external math
   library). Sort descending by score, take the top `TOP_K` (15),
   return `{results, intent, usedFallback, commandMentions,
   usedCommandFallback, explicitRefs, notFoundRefs}`.

This is brute-force (linear scan over ≤2,420 384-dim vectors per query)
— no vector index/ANN library, deliberately, since the corpus is small
enough that this runs in a few milliseconds.

### 6.4 Reply generation

Two mutually exclusive modes, chosen once by `CHAT_ENGINE`:

- **`"deterministic"` (the default, no LLM at all)**:
  `buildDeterministicReply(retrieval)` returns a plain hand-templated
  sentence built purely from the `retrieval` object — e.g. `"Found 8
  bugs mentioning GOTO OBJECT and fixed in version 20 (and its
  releases/hotfixes). Top matches below."`, or for an explicit ACI hit:
  `"Found ACI0101931 directly — see the details below."`, or if the
  user cited an ID that doesn't exist: `"ACI9999999 doesn't exist in
  the database. Here are the closest matches by search instead:"`. No
  network call, no model — this path is instant and always factually
  exact by construction.
- **`"webllm"` (opt-in via `?engine=webllm`)**: `buildSystemMessage
  (retrieval)` constructs a system prompt (see §6.5) embedding the
  retrieved bugs' `[reference] (versions: ...) summary` (summary with
  markdown links stripped via `stripLinks`) as grounding context, then
  the full running `conversation` (mapped to plain `{role, content}`)
  is sent to `engine.chat(messages)`. The returned `{text, thinking}`
  becomes the assistant turn.

In both modes, after the reply text is produced, a **separate,
always-deterministic hits table** (`renderHitsTable`, §6.6) is appended
to the same chat bubble, built directly from `retrieval.results` — the
model (when used) is only ever asked to write 2-4 sentences of prose,
never to reproduce the table/links/references itself, since a small
local model can't be trusted to echo every result faithfully.

### 6.5 System prompt (WebLLM mode only — `buildSystemMessage`)

Built fresh every turn (not appended to incrementally) from the current
turn's `retrieval` result. Content, verbatim structure:

1. Fixed preamble: tells the model it only ever discusses the 4D
   fixed-bugs database, to assume every message is about that topic
   even if phrased casually, and explains that classic
   command-name/version matching already ran *before* semantic
   ranking (i.e. retrieval is deterministic, not the model's job).
2. A line noting the app already searched and found the reports below,
   with optional inline notes:
   - if a version filter was requested but had to fall back
     (`usedFallback`): "(note: no bugs matched version 20 ... specifically, so
     these are the closest overall matches instead)".
   - if a command filter fell back similarly (`usedCommandFallback`):
     analogous note naming the mentioned command(s).
   - if the user cited explicit ACI ID(s): either "The user asked about
     a specific bug reference by ID (...), so the report below is an
     exact lookup, not a search — just describe it directly." or, if
     the ID doesn't exist, "The user mentioned bug reference ID(s) ...
     which do not exist in the database — mention that plainly instead
     of guessing what they might be."
3. Explicit reply-format constraints: 2-4 sentences, cite ACI codes,
   **plain prose only — no markdown tables, bullet/numbered lists,
   headings, or bold/italic** (since local models reliably mangle
   markdown tables; the separate deterministic table already covers
   structured detail).
4. Instruction to only decline if the message is obviously unrelated to
   software bugs (personal advice, trivia), in which case reply briefly
   that it can only help with 4D fixed-bug questions.
5. `"Bug reports found for this message:\n\n"` followed by every result
   as `[REF] (versions: v1, v2, ...) <link-stripped summary>`, blank-line
   separated.

### 6.6 Rendering

- `renderHitsTable(bugs)` (`app.js`): builds an HTML `<table
  class="hits-table">` with columns **ACI** (plain reference text),
  **Versions** (`renderVersions`, from `render.js` — each version
  string linked to `https://bugs.4d.com/fixedbugslist?version=<v>`),
  **Summary** (`renderSummary`, from `render.js`). Only the first
  `TABLE_TOP_N` (8) of the `TOP_K` (15) retrieved results are shown.
- `renderSummary(text)` (`render.js`): a small, deliberately
  non-general-purpose, safe markdown-subset renderer (not a full
  markdown library) —
  1. HTML-escape the entire raw string first (`&`, `<`, `>`, `"`, `'`),
     so no HTML/JS from the source data can ever execute.
  2. Single-pass regex over three alternations, in priority order:
     `\[([^\]]+)\]\(([^)]+)\)` (link) `|` `` `([^`]+)` `` (inline code)
     `|` `\*([^*\n]+)\*` (italic).
  3. For a link match: un-escape `&amp;` back to `&` inside the href
     (the only entity `escapeHtml` could have introduced into a URL);
     if the link *text* itself is exactly wrapped in backticks (e.g.
     `` [`GOTO OBJECT`](url) ``), render its inner text as `<code>...
     </code>` instead of literal backtick characters; then, only if the
     href starts with the allowlisted prefix `"https://developer.4d.com/"`,
     wrap in `<a href="..." target="_blank" rel="noopener
     noreferrer">` — otherwise render as plain (non-linked) text, as
     defense-in-depth against any unexpected href in the data.
  4. Inline code / italic matches become `<code>`/`<em>` directly.
- `renderVersions(versions)` (`render.js`): comma-joined list of
  `<a href="https://bugs.4d.com/fixedbugslist?version=<url-encoded v>">v</a>`,
  or an em-dash `"—"` if empty.
- `highlightCitations(html, bugs)` (`app.js`): post-processes an
  assistant reply's rendered HTML, wrapping any `ACI\d+` substring that
  matches one of the current turn's retrieved bugs in `<strong
  class="citation">`. (No click-to-scroll target exists anymore — this
  is purely visual emphasis.)

### 6.7 Chat UI mechanics

- `conversation` is an in-memory array of `{role: "user"|"assistant",
  content, bugsContext, thinking}`; there is no persistence (reload
  loses history). Every user turn is stamped with the **previous**
  turn's `bugsContext` (so a user bubble also "remembers" what was
  being discussed) and every assistant turn is stamped with its own
  turn's `retrieval.results`.
- `appendBubble(role, text, bugs, thinking)` renders one chat bubble:
  user bubbles are just `renderSummary(text)`; assistant bubbles are
  `[optional <details class="reasoning"> block if `thinking` is
  present] + highlightCitations(renderSummary(text), bugs) +
  renderHitsTable(bugs)`.
- `appendSystemNote(text, {spinner})` renders a small centered
  `.chat-note` line (e.g. "Searching the bug database…", "Thinking…"),
  optionally with an animated 3-dot `.typing-indicator` instead of/along
  with the text, used to signal in-progress work; removed once that
  step resolves.
- Submit handler (`chatForm` `"submit"`): disable input → push/render
  user bubble → show "Searching…" note+spinner → `await retrieve(...)`
  → remove note → (deterministic: build templated reply immediately) or
  (webllm: show "Thinking…" note+spinner → `await engine.chat(...)` →
  remove note) → push/render assistant bubble → re-enable input. Errors
  are caught, logged, and shown as a `chat-note` (`Error: ...`).
- **Clear** button: empties `conversation` and re-renders (empty) chat.
- **Copy** button: builds a plain-text transcript — a "Bug subset
  discussed" section (the last turn's `bugsContext`, each as `[REF]
  link-stripped-summary (Fixed in: v1, v2, ...)`) followed by a
  "Conversation" section (`You: ...` / `AI: ...` per turn) — and writes
  it to the clipboard via `navigator.clipboard.writeText`, confirming
  or reporting failure via a system note.

## 7. Optional local-LLM chat engine

### 7.1 Engine interface (implicit contract, not a formal TS interface)

Any chat engine module exports `createEngine()` returning an object:

```js
{
  label: string,
  async init(onProgress: (text: string) => void): Promise<void>,
  async chat(messages: {role: string, content: string}[]): Promise<{text: string, thinking: string|null}>,
  reset(): void,
}
```

`app.js` is entirely engine-agnostic beyond this shape — retrieval,
system-prompt construction, conversation state, and chat UI never
change based on which engine (if any) is active.

### 7.2 WebLLM engine (`docs/src/engines/webllm-engine.js`) — the only
LLM engine currently wired up

- Loads `@mlc-ai/web-llm@0.2.79` via `import("https://esm.run/@mlc-ai/web-llm@0.2.79")`
  (dynamic import, no bundler, no import map needed — `esm.run` handles
  dependency resolution itself).
- Model: `"Llama-3.2-1B-Instruct-q4f16_1-MLC"`, loaded via
  `webllm.CreateMLCEngine(CHAT_MODEL_ID, { initProgressCallback })`,
  runs entirely client-side over WebGPU.
- `chat(messages)`: single call to
  `engine.chat.completions.create({ messages })`, returns `{ text:
  reply.choices[0].message.content, thinking: null }` (WebLLM never
  emits a separate reasoning block). Stateless per call — the full
  `messages` array (system + entire conversation) is resent every turn,
  so `reset()` is a no-op.
- Enabling this in production requires visiting with `?engine=webllm`
  (or setting `DEFAULT_CHAT_ENGINE = "webllm"` in source) — the shipped
  default is `"deterministic"`, so most visitors never download this
  model.

(A second engine — LFM2.5-1.2B-Thinking via `@huggingface/transformers`
+ onnxruntime-web/WebGPU — was built and then removed after its WebGPU
backend proved unreliable to load from a CDN/static-hosting setup
without a real bundler; see `SESSION_NOTES_LFM25_COMPARISON.md` for
that history. It is not part of the current app.)

## 8. Styling (`docs/style.css`)

- CSS custom properties on `:root` for both themes (`--border`,
  `--muted`, `--accent`, `--bg-card`, `--bg`, `--fg`, `--surface`,
  `--shadow`, `--hairline`, `--hairline-strong`), overridden inside
  `@media (prefers-color-scheme: dark)` — no JS-driven theme toggle.
  Light accent `#2b5fb8`, dark accent `#5b8def`.
- Layout: `body` is a `max-width: 900px`, centered, full-height flex
  column. `.app-bar` is `position: fixed` (top/left/right: 0, z-index:
  20) containing `.app-bar-inner` (same 900px max-width, centered,
  flex row: logo + form). `main` has `padding-top: 4.25rem` to clear
  the fixed bar's height.
- `.chat-container`: flex column, `max-height: 75vh`, `overflow-y:
  auto`, bordered/rounded panel.
- `.chat-message`: rounded bubble, `max-width: 80%` (96% for
  `.assistant`, since it also carries the hits table), `align-self:
  flex-end`/`flex-start` + accent/neutral background for user/assistant
  respectively, each with one "sharp" corner (`border-bottom-*-radius:
  4px`) facing its side.
- `.hits-table`: bordered, collapsed-border table, header row background
  `var(--hairline)`.
- `.icon-btn` / `.icon-btn-primary`: outlined-accent vs filled-accent
  button variants, inline `<svg>` sized 16x16 via `fill: currentColor`.
- `.typing-indicator`: three `span`s, each a small circular dot,
  `@keyframes typing-bounce` (translateY bounce + opacity pulse),
  staggered via `animation-delay` (0s/0.15s/0.3s).
- `.reasoning` / `.reasoning summary` / `.reasoning-body`: dashed-border
  collapsible `<details>` block for any engine that returns a non-null
  `thinking` string (currently unused since WebLLM never sets one, but
  kept generic).

## 9. Security notes

- All summary/version text rendered via `renderSummary`/`renderVersions`
  is HTML-escaped before any markup substitution, and every link href
  is allowlist-checked (`https://developer.4d.com/` for command links)
  before being placed in an `href` attribute — so no data from the
  (crawled, third-party-sourced) dataset can inject arbitrary HTML/JS
  or link to an arbitrary domain.
- All external links (`target="_blank"`) use `rel="noopener noreferrer"`.
- No API keys, no user data collection, no analytics, no cookies. The
  only network requests at runtime are: the app's own static assets,
  the dataset (`meta.json`/`embeddings.bin`), the transformers.js
  library + `all-MiniLM-L6-v2` model files (from Hugging Face's CDN via
  `@xenova/transformers`), and — only in opt-in `?engine=webllm` mode —
  the WebLLM library + Llama-3.2-1B-Instruct model weights.

## 10. Reproducing this app from scratch

1. Produce the three source JSON files under `data/` (or equivalent):
   an enriched-summary file (`reference`, markdown `summary` with
   command doc-links, `commands`) and a context file (`reference`,
   `versions`) to join by `reference`.
2. Write and run `scripts/generate_embeddings.mjs` (§4) to produce
   `docs/data/meta.json` + `docs/data/embeddings.bin`.
3. Build `docs/index.html` + `docs/style.css` per §5/§8.
4. Implement `docs/src/version.js`, `docs/src/commands.js`,
   `docs/src/render.js` per §6.3/§6.6 (pure functions, no DOM/network
   dependencies — easy to unit-test standalone).
5. Implement `docs/src/app.js` per §6 (boot, retrieve, deterministic
   reply, chat UI) — deterministic mode requires no LLM engine module
   at all.
6. Optionally implement `docs/src/engines/webllm-engine.js` per §7.2 for
   the opt-in conversational layer.
7. Commit `docs/` to `main` and enable GitHub Pages for `main` /
   `/docs` in repo settings. Remember the cache-busting `?v=N`
   convention on every future asset-changing deploy.
