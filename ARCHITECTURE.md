# 4D Fixed Bugs — Semantic Search Chat

A fully static, client-side web app that lets a user ask natural-language
questions about a dataset of 2,467 fixed 4D software bugs and get back
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
  index.html                # the English page
  ja/
    index.html               # the Japanese page (same JS/CSS, <html lang="ja">; see §11)
  fr/
    index.html               # the French page (same JS/CSS, <html lang="fr">; see §12)
  style.css                 # all styling (light + dark)
  assets/
    banner.png               # 128x128 app-bar logo/icon
  data/
    meta.json                 # array of {reference, summary, commands, versions}, one per bug, index-aligned with embeddings.bin
    embeddings.bin             # raw Float32Array, row-major, N rows x 768 cols, L2-normalized
    search-index.json          # full encoder contract, shape and metadata/vector SHA-256
    ja/
      meta.json                 # same records with Japanese summaries
      embeddings.bin            # N rows x 768 cols, same text-only EmbeddingGemma 2
      search-index.json         # Japanese index contract and integrity manifest
    fr/
      meta.json                 # same records with French summaries
      embeddings.bin            # N rows x 768 cols, same text-only EmbeddingGemma 2
      search-index.json         # French index contract and integrity manifest
  search-runtime/4.3.1/      # committed runtime licenses and versions.json only, no executables
  src/
    app.js                     # entry point: boot, retrieval, chat UI, deterministic reply builder
    i18n.js                    # per-language dataset dir, score calibration, UI/fallback strings
    search-config.js           # shared pinned model/runtime/format/normalization contract
    runtime-config.js          # exact official CDN URLs and upstream runtime-file SHA-256
    keyword-search.js          # metadata-only fallback, not semantic confidence
    render.js                  # safe minimal-markdown renderer for summaries + version links
    beta-versions.js           # GENERATED: Set of versions that only exist as a bugs.4d.com beta branch
    version.js                 # natural-language version-reference parsing/matching
    commands.js                # exact command-name mention matching
    engines/
      webllm-engine.js           # optional local-LLM engine (WebLLM / Llama-3.2-1B)

data/                       # source dataset + offline precompute inputs (NOT served by Pages;
                             # docs/data/* is the built output copied/generated from these)
  all_bugs_enriched.json      # [{reference, summary (markdown w/ dev.4d.com links), commands}]
  all_bugs_context.json       # [{reference, raw_summary, versions, jp_notes, matched_commands}]
  command_index.json          # {commandName: {title, url}} — reference data, not consumed by the client at runtime
  bugs_raw.json               # parser output: [{reference, raw_summary, raw_summary_variants, versions}]
  jp_notes.json               # Japanese cross-reference notes keyed by ACI reference
  all_bugs_ja.json            # [{reference, summary (Japanese), source_fingerprint}] — see §11
  pending_translation.json    # bugs whose Japanese summary still needs writing
  all_bugs_fr.json            # [{reference, summary (French), source_fingerprint}] — see §12
  pending_translation_fr.json # bugs whose French summary still needs writing
  translation_fr/            # French input/output chunks (Japanese: translation/)
  update_state.json           # incremental-update memory: page hashes, enrichment fingerprints, JP repo SHAs, link checks
  version_sources.json        # {version: ["version"|"branch"]} — which bugs.4d.com listing serves each version
  pending_enrichment.json     # bugs whose English summary still needs writing (empty after a completed update)
  pilot_bugs.json, pilot_report.md  # the 40-bug hand-reviewed pilot that set the prose style bar

scripts/
  update.sh                   # end-to-end dataset refresh (see UPDATING.md)
  update/
    common.py                  # shared paths, version scheme, update_state.json handling
    crawl.py                   # probes ?version= and ?branch= listings, hashes each page
    parse.py                   # both HTML layouts -> data/bugs_raw.json
    sync_jp.py                 # shallow-clones the 4D-JP repos -> data/jp_notes.json
    match_commands.py          # candidate command detection in English + Japanese text
    build_context.py           # context bundle + the pending-enrichment delta
    split_pending.py           # splits pending work into per-worker chunks
    merge_enrichment.py        # validates and merges written summaries back in
    check_links.py             # re-verifies every developer.4d.com URL still resolves
    build_translation.py       # translation delta (default ja; --lang fr for French)
    merge_translation.py       # validates and merges written Japanese/French summaries
    ja_common.py               # Japanese fingerprint/validator + shared structural checks
    fr_common.py               # English-only French fingerprint + prose validation
    translation_common.py      # language-specific paths and helpers
    TRANSLATION_PROMPT.md      # instructions handed to each translation worker
    TRANSLATION_PROMPT_FR.md   # French writing contract; canonical English commands/links
    generate_embeddings.mjs    # incremental build of docs/data/ (--lang ja/fr: docs/data/ja/ or fr/)
    search-encoder.mjs         # checksum-verified pinned text-only CPU encoder
    bump_cache_bust.py         # bumps shared ?v=N on all three pages' asset URLs
    ENRICHMENT_PROMPT.md       # the prose-writing instructions handed to each worker
  package.json                 # @huggingface/transformers@4.3.1 and playwright tooling

tests/
  js/                         # node:test unit tests for docs/src (version/command parsing, rendering, i18n)
  python/                     # unittest for the translation validator
  eval/                       # aligned English/Japanese/French retrieval-quality query sets
  browser/smoke.mjs           # headless-browser smoke test of both pages
  generate_embeddings.mjs      # compatibility entry point for the shared index generator
  crawl_4d_bugs.sh             # original crawler, kept for reference (superseded by update/crawl.py)
  parse_phase1.py              # original parser, kept for reference (superseded by update/parse.py)

html/                       # gitignored: raw crawled HTML, reproducible via scripts/update/crawl.py
vendor/                     # gitignored: shallow clones of the 4D-JP cross-reference repos
.cache/search-model/        # gitignored: checksummed model artifacts under the pinned revision
.cache/search-runtime/      # gitignored: verified official CDN runtime files under 4.3.1/
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
- `summary`: localized prose (English at the root, Japanese under `ja/`,
  French under `fr/`), a small fixed markdown subset only —
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

Dataset size: 2,467 bugs per language. Embedding: 768-dimensional text-only
EmbeddingGemma 2, Float32, L2-normalized. Each `embeddings.bin` is therefore
`2467 * 768 * 4` bytes = 7,578,624 bytes, row `i` (0-indexed) being the
embedding for `meta.json[i]`. (The dataset grows as 4D ships fixes — see
`UPDATING.md`; the invariant is `byteLength === meta.length * 768 * 4`.)
Each corpus also carries `search-index.json`: `contract`, `count`, `bytes`,
`metadata_sha256` and `vectors_sha256`. Shape alone never establishes that an
index belongs to the current model or text format.

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

## 4. Offline precompute (`scripts/update/generate_embeddings.mjs`)

Run whenever the dataset changes, from `scripts/`:

```
cd scripts
npm ci
npm run build:search-runtime
node update/generate_embeddings.mjs
node update/generate_embeddings.mjs --lang ja
node update/generate_embeddings.mjs --lang fr
```

It is the last stage of the dataset-refresh pipeline described in
`UPDATING.md`, and `./scripts/update.sh` runs it for you.

Steps:
1. Load `data/all_bugs_enriched.json` and `data/all_bugs_context.json`.
2. Join them by `reference`: for each enriched bug, look up its
   `versions` array from the context file (defaulting to `[]` if
   missing).
3. Build the final `records` array: `{reference, summary, commands,
   versions}` — this becomes `docs/data/meta.json` verbatim
   (`JSON.stringify(records)`, no pretty-printing).
4. Load the pinned text-only CPU encoder from `search-encoder.mjs`, using
   `@huggingface/transformers@4.3.1`. Its shared contract is
   `docs/src/search-config.js`: model `onnx-community/embeddinggemma-2-ONNX`,
   revision `daa72c51243991dfcaf9f9137d2c573d8f7790c0`, precision `q4`,
   512-token maximum, 768-dimensional output. Clear `vision_config` and
   `audio_config`; no image/audio path is loaded.
5. Use the shared `documentText(record)` helper, not a language-specific
   summary prefix. It preserves the reference and canonical command names:

   ```text
   title: {reference} | text: {Markdown-links-stripped localized summary}
   {commands joined with " · "}
   ```

6. Embed batches through the exported `sentence_embedding`, then explicitly
   L2-normalize and validate each vector. Do not substitute generic
   `feature-extraction` mean pooling. Pack rows into
   `Float32Array(records.length * 768)`.
7. Write `docs/data/embeddings.bin` as the raw bytes of that
   `Float32Array` (`Buffer.from(floatArray.buffer)`) and
   `docs/data/meta.json` as the records array. Write `search-index.json`
   with the complete shared contract, record count, binary byte length and
   SHA-256 hashes of the serialized metadata and vector bytes.
8. Write `docs/src/beta-versions.js`, exporting a `Set` of the versions
   bugs.4d.com only publishes as a beta branch (taken from
   `data/update_state.json`'s `beta_only_versions`). `render.js` imports
   it to decide whether a version link should point at
   `?version=<v>` or `?branch=<v>` — for a version still in beta the
   former returns the site's error page.

The step is **incremental only after validation**: the prior manifest's full
contract must match, shape/count/bytes must agree, and metadata/vector hashes
must verify. A missing or mismatched contract or failed integrity check causes
automatic full recomputation, even when vector dimensions happen to match.
Once verified, a row is reused only when its `documentText(record)` is
unchanged. A reference, summary or command change can therefore invalidate a
row; a version-only update can reuse it. `--force` skips all row reuse.

The CPU encoder downloads only pinned, SHA-256-verified artifacts into
`.cache/search-model/<revision>/`. `SEARCH_MODEL_PATH` can point at a local
model directory, but those files must pass the same checksums; it is not an
escape hatch for unversioned weights.

`docs/src/runtime-config.js` pins the official immutable CDN module
`https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js`
and ONNX Runtime `wasmPaths` base
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/`.
It also records SHA-256 hashes for each unmodified upstream file, including
`.mjs`/`.wasm` assets for all three ORT flavors.

The compatible command `npm run build:search-runtime --prefix scripts` is now
a **verification stage**, not a bundler: it checks installed locked npm
versions and file hashes, downloads official CDN files into gitignored
`.cache/search-runtime/4.3.1/`, and verifies matching digests. A cache entry
never bypasses hash validation. A valid cache can satisfy verification without
a CDN download; without it, unavailable CDN files fail the verification stage.
Only licenses/notices and `versions.json` remain
committed under `docs/search-runtime/4.3.1/`; no runtime executables are
committed. Pages still serves `main` / `docs` directly, with no new deployment
workflow. Browser workers import the exact-version CDN module and use its
matching ORT paths, rather than mixing independently selected runtime versions.
If the CDN is unavailable to the browser, explicitly labeled metadata keyword
search remains available; no alternate unpinned runtime is substituted.

Corpus embeddings are computed offline by this step — the browser never
re-embeds the dataset, only the user's query at search time, using the
same model/exported-output/normalization contract so query
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
    <div id="search-status" class="status" role="status"><!-- localized progress/fallback state --></div>
    <!-- A manual retry control is shown for semantic-search recovery. -->
    <div id="chat" class="chat-container"></div>
  </main>

  <footer>
    <p>Data crawled from <a href="https://bugs.4d.com">bugs.4d.com</a>. Embeddings:
       text-only EmbeddingGemma 2 via the pinned official Transformers.js CDN runtime.</p>
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
- The input and submit button start `disabled` but become usable once
  metadata keyword search is ready; model download does not block them.
  `#search-status` and a manual retry control make semantic loading,
  failure and recovery explicit rather than silently pretending to be semantic.
- There is no separate "results list" UI — everything (both the
  conversational reply and the ranked-hits table) renders as chat
  bubbles inside `#chat`.
- `<meta name="color-scheme" content="light dark" />` plus pure-CSS
  `@media (prefers-color-scheme: dark)` gives automatic dark mode with
  no JS toggle.

## 6. Client application logic (`docs/src/app.js`)

### 6.1 Constants & configuration

```js
const LOCALE = getLocale(document.documentElement.lang); // from i18n.js, see §11
const EMBED_DIM = SEARCH_CONFIG.dimensions;               // 768 for en / ja / fr
const TOP_K = 15;          // candidates ranked/returned by retrieve()
const TABLE_TOP_N = 8;     // how many of those are actually rendered in the hits table
const MIN_SCORE = LOCALE.scores.min;                      // calibrated semantic similarity floor
const DEFAULT_CHAT_ENGINE = "deterministic"; // "deterministic" | "webllm"
```

All languages use the same `SEARCH_CONFIG` model contract (§4). Query encoding
uses `queryText(query)`, which prepends exactly `"task: search result | query: "`.
The model's exported `sentence_embedding` is normalized to 768 dimensions,
not inferred by a generic feature-extraction pipeline. Locale-specific UI and
semantic score calibration remain in `i18n.js`; the active cutoffs were measured
independently for each language (§13), not inherited from MiniLM/E5/ruri.

`CHAT_ENGINE` is resolved once at load time as: `?engine=` URL query
param → `document.body.dataset.engine` → `DEFAULT_CHAT_ENGINE`. This
lets you force WebLLM mode for testing via
`index.html?engine=webllm` without touching source.

### 6.2 Boot sequence (`boot()`)

1. Load the selected locale's `meta.json` and build its command/version
   metadata. Make keyword search usable without waiting for model download.
2. Load `search-index.json` and `embeddings.bin`; verify the model contract,
   count/byte shape and metadata/vector checksums before semantic use.
3. Automatically start semantic model loading in a WebGPU worker using
   the official exact-version CDN runtime and shared pinned contract.
   The worker uses the text-only `q4` model and exported sentence embedding.
4. `#search-status` gives localized loading/progress or fallback information;
   a manual retry button allows another semantic-load attempt. Keyword search
   remains available while downloading and if WebGPU is unsupported, model
   or CDN loading fails or an individual query fails. There is deliberately no
   generic quantized feature-extraction/WASM fallback.
5. If `CHAT_ENGINE !== "deterministic"`, separately load the opt-in chat
   engine (§7). That engine does not replace the search encoder or index.

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
4. **Pure exact filters**: if the query consists only of recognized command
   and/or version criteria (for example `v20`), return the exact filtered pool
   without semantic encoding or score floors. Use a localized
   `Filter` / `Filtre` / `条件一致` badge, not a semantic percentage or the ACI
   `Exact` badge. This path is identical with WebGPU ready, loading or absent.
   Do not discard unknown descriptive terms: `weather after v20` is not a
   pure-filter query and still needs semantic or keyword matching.
5. **Semantic ranking, when available**: encode `queryText(query)` in the
   WebGPU worker under the verified shared contract, then for every index
   still in the (possibly filtered) pool compute a plain dot product against
   that bug's 768-float row in `embeddings` — since both vectors are
   L2-normalized, dot product =
   cosine similarity, computed as a manual `for` loop, no external math
   library). Sort descending by score, take the top `TOP_K` (15),
   return `{results, intent, usedFallback, commandMentions,
   usedCommandFallback, explicitRefs, notFoundRefs}`.

6. **Explicit keyword fallback**: while loading or on unsupported WebGPU,
   model-load failure, index incompatibility or query-encoding failure, rank
   against localized metadata instead. ACI lookup, case-sensitive command
   matching and version filtering remain available. The UI labels this mode
   and uses lexical badges, not misleading semantic percentages.

This is brute-force (linear scan over ≤2,467 768-dimensional vectors per query)
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
  the dataset (`meta.json`, `embeddings.bin`, `search-index.json`), the
  official exact-version runtime files from jsDelivr, the pinned text-only EmbeddingGemma 2
  model files (downloaded from Hugging Face), and — only in opt-in
  `?engine=webllm` mode —
  the WebLLM library + Llama-3.2-1B-Instruct model weights.

## 10. Reproducing this app from scratch

1. Produce the three source JSON files under `data/` (or equivalent):
   an enriched-summary file (`reference`, markdown `summary` with
   command doc-links, `commands`) and a context file (`reference`,
   `versions`) to join by `reference`.
2. Restore the locked dependencies, verify the official CDN runtime and run
   `scripts/update/generate_embeddings.mjs` (§4) for all three languages to
   produce each locale's `meta.json`, `embeddings.bin`, `search-index.json`
   and the shared `docs/src/beta-versions.js`.
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

To refresh the dataset afterwards rather than rebuild it, use
`./scripts/update.sh`; `UPDATING.md` documents that pipeline and the
delta-tracking state it keeps in `data/update_state.json`.

## 11. Japanese version (`docs/ja/`)

The Japanese page is the same app: `docs/ja/index.html` is a translated copy of
`index.html` (`<html lang="ja">`, asset paths prefixed `../`, a language switch
linking back), loading the same `src/app.js`. `app.js` reads
`document.documentElement.lang` and takes everything language-specific from
`src/i18n.js`:

- **Dataset**: `docs/data/ja/meta.json`, `embeddings.bin`, `search-index.json` — the same records
  (same order, `commands`, `versions`) with the Japanese `summary`.
- **Embedding model**: the same pinned text-only EmbeddingGemma 2, `q4`,
  768-dimensional normalized `sentence_embedding` and shared document/query
  format as English and French (§4). Japanese summaries remain Japanese;
  no translation changes are required by the encoder migration.
- **Score calibration**: measure with the aligned evaluation queries rather
  than copying historical ruri thresholds (§13).
- **UI strings**: status lines, reply templates, table headers, copy messages.
  `describeIntent(intent, "ja")` in `version.js` phrases version filters in
  Japanese.

Classic matching is shared and works on Japanese text unchanged — JS `\b` is
ASCII-only, so `\bGOTO OBJECT\b` and `\bACI\d+` match next to kana/kanji.
Queries are NFKC-normalized before ACI/command/version matching so full-width
input (`ＡＣＩ００９２２１８`, `Ｖ２０`) works. `parseVersionIntent` also
understands Japanese phrasings: `v18前後`/`18頃`/`約18` (approximate),
`17より前`/`17未満` (strictly before), `17以前`/`17以下` (inclusive), `20より後`
(strictly after), `20以降`/`20以上` (inclusive), `バージョン20` (exact). The
inclusive forms carry `inclusive: true` on the intent.

Japanese summaries are written per `scripts/update/TRANSLATION_PROMPT.md`
from the English summary and the original 4D Japan release-note text
(`jp_notes`), in polite form (です・ます調), keeping every command link with
its English link text and the URL moved to `https://developer.4d.com/docs/ja/…`
(the renderer's allowlist prefix still matches). `merge_translation.py`
enforces this; see `UPDATING.md` → *The Japanese site*.

In WebLLM mode the system prompt stays in English with an added instruction to
reply in Japanese.

## 12. French version (`docs/fr/`)

The French page shares the app and language configuration in `docs/src/i18n.js`.
Its full dataset is `docs/data/fr/meta.json`, `embeddings.bin` and
`search-index.json`, with the same
references, commands, versions and ordering as English, but French summaries.
Offline and browser embedding settings come from the same
`docs/src/search-config.js` contract (§4): text-only EmbeddingGemma 2 `q4`,
768 dimensions, the shared reference/summary/commands document format and
`"task: search result | query: "` query prefix. E5's old `"passage: "` /
`"query: "` prefixes are not used by the current model.

French prose is translated **only from canonical English**, not from Japanese
notes or Japanese summaries. `build_translation.py --lang fr` fingerprints
the English summary and command set; Japanese-note-only changes cannot enqueue
French work. It writes `data/pending_translation_fr.json`, split into
`data/translation_fr/` chunks. `merge_translation.py --lang fr` validates and
stores `data/all_bugs_fr.json` records with their source fingerprints.
The merge rejects stale pending fingerprints if English changed after queuing.

Shared structural validation preserves Markdown links (both label and original
English URL), inline code, verbatim command names and ACI references. French
does not rewrite URLs to `/docs/fr/` and does not apply Japanese character or
politeness heuristics. It requires a French prose signal, rejects unchanged
English, and permits genuine French without accented characters.
`scripts/update/TRANSLATION_PROMPT_FR.md` gives the writing contract.

`update.sh` computes both translation queues before stopping at their manual
gate, builds all three datasets only when both queues are empty, checks links
from all three corpora, and synchronizes asset cache versions on all three pages.
French URLs are the canonical English ones, so link checks share cached results.

After generating French data, validate retrieval from `scripts/` with
`node ../tests/eval/eval_retrieval.mjs --lang fr --min-recall8 0.95 --min-visible-recall8 0.95 --max-off-topic-hits 0`.
The 43 French query cases correspond to the Japanese evaluation set; both
raw top-eight recall and recall among client-visible results must reach 95%,
and no evaluated off-topic query may pass the score floor.

## 13. Retrieval calibration and historical baselines

All three 2,467-record indexes have been built and verified; their metadata
remains byte-identical to commit `3544f94`. The three aligned evaluation sets
contain 43 queries each. Actual semantic-ranking results are:

| Language | Historical model | Old R@1 / R@8 / MRR | EmbeddingGemma 2 R@1 / R@8 / MRR |
|---|---|---|---|
| English | MiniLM | 95.35% / 100% / .97093 | 88.37% / 100% / .94186 |
| French | multilingual E5-small | 72.09% / 88.37% / .80502 | 86.05% / 97.67% / .91122 |
| Japanese | ruri | 95.35% / 100% / .96802 | 93.02% / 97.67% / .95460 |

This is **not baseline parity**. English retains top-eight recall but loses
top-one accuracy and MRR. Japanese loses one top-eight hit: `ACI0104021` moves
from rank 2 to 21. French improves overall, but `ACI0105986` moves from rank 21
to 64; it was already outside the top eight under E5.

The active independently measured semantic floors and badge bands are:

| Language | Minimum | Medium | High |
|---|---:|---:|---:|
| English | .705 | .799 | .841 |
| French | .702 | .800 | .841 |
| Japanese | .715 | .798 | .845 |

These floors retain every correct top-eight hit and reject all 12 expanded
negative queries **per language** on the measured sets. They do not establish
universal off-topic rejection, and keyword-fallback badges remain lexical.
Bare `v20` queries scored at most .677/.687/.691 in English/French/Japanese,
below these floors; recognized command/version-only queries therefore use
the exact-filter path (§6.3), independent of model quality. Genuine bug
descriptions retain semantic ranking and thresholds; exact ACI lookup is unchanged.
The final evaluation gates require ranked and visible recall@8 ≥ .95 and
zero off-topic hits; passing these gates is not a claim of baseline parity.

Durable results and calibration details are in
`tests/eval/embeddinggemma-{en,fr,ja}.json`; comparisons and preserved baselines
are in `tests/eval/embeddinggemma-comparison.json` and `tests/eval/baselines.json`.
