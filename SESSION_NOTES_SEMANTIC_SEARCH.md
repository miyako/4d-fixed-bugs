# Session Notes: Client-Side Semantic Search + Local RAG

This document records the plan and implementation notes for the
`docs/` static AI-chat page over the fixed-bugs dataset, in the same
spirit as `SESSION_NOTES.md` for the crawl/enrichment pipeline —
working notes for future extension, not user-facing documentation.

## Goal

Build a fully static, client-side (no backend) web page that lets users
ask natural-language questions about `data/all_bugs_enriched.json`
(2,420 4D bug fixes), grounded by semantic search, running entirely in
the browser. Confirmed with the user up front: the AI layer is
**WebLLM-only** — no hosted-API-key option — so nothing about a user's
query or the bug data ever leaves their browser.

The UI went through several iterations in this session (documented
below in "History of iterations") and has settled on a **single chat
interface**: there is no separate search box, result list, or subset
picker. Every user chat message is invisibly and automatically used to
retrieve relevant bugs, which ground the local model's answer.

## Architecture (current)

1. **Offline precompute** (`scripts/generate_embeddings.mjs`, run once /
   re-run whenever the dataset changes): a Node script using
   `@xenova/transformers` (pinned version) embeds each bug's summary with
   `Xenova/all-MiniLM-L6-v2` (384-dim, mean-pooled, L2-normalized), after
   stripping markdown link syntax so the model sees clean prose. It joins
   `versions` per bug from `data/all_bugs_context.json` by `reference`.
   Output: a flat `Float32Array` binary (`docs/data/embeddings.bin`,
   row-major `[2420 x 384]`, ~3.7 MB) plus an aligned
   `docs/data/meta.json` (~1 MB) — small enough to commit directly, no
   external storage or quantization needed.
2. **Static page** (`docs/`, no bundler, plain ES modules, single entry
   point `docs/src/app.js`): on load, the page automatically (no opt-in
   click required) fetches the precomputed data, loads the transformers.js
   embedding model, then loads the WebLLM chat model — showing progress
   in a status line — and only then enables the chat input.
3. **Automatic, deterministic retrieval per turn.** Rather than asking
   the (small, 1B-parameter) local model to decide for itself when/how to
   run a "search tool" — unreliable at that model size — `app.js` always
   parses every user message for a 4D version reference
   (`docs/src/version.js`), filters the dataset by it if one is found,
   ranks the remaining (or full) set by cosine similarity against the
   precomputed embeddings, and passes the top 15 hits into the system
   prompt as grounding context for every turn. The model's job is just to
   answer from that context (citing ACI references) and to politely
   decline anything outside the bug database's scope — not to run
   retrieval itself.
4. **Persistent chat conversation.** Turns accumulate in memory
   (`conversation` array) and are all resent to the model every turn
   (each with a freshly rebuilt system message/context, since the
   "current" retrieval depends on the latest user message). A new
   question never clears history; an explicit "Clear conversation"
   button does. A "Copy conversation" button copies the full transcript
   plus the most-recently-retrieved bug set to the clipboard.

## File/folder layout
```
docs/                          <- static site root (GitHub Pages: "/docs" on main)
  index.html
  style.css
  src/
    app.js                     <- single entry point: boot sequence, retrieval, chat wiring
    version.js                 <- version-reference parsing/matching rules (pure functions)
    render.js                  <- safe markdown renderer for summaries/chat bubbles
  data/
    embeddings.bin             <- Float32Array, row-major [2420 x 384], L2-normalized
    meta.json                  <- aligned array: {reference, summary, commands, versions}
scripts/
  generate_embeddings.mjs      <- offline precompute (Node, @xenova/transformers)
  package.json                 <- pins @xenova/transformers version used by both
                                   the script and the browser CDN import
```
`docs/` was chosen specifically for zero-config GitHub Pages hosting
(Settings > Pages > Deploy from branch, folder `/docs`) with no build
step.

## Version-reference rules (`docs/src/version.js`)

Per the user's explicit spec, a message's 4D version reference is
mapped to a filter as follows (implemented as ordered regexes in
`parseVersionIntent`, matched against a bug's `versions` array via
`bugMatchesIntent`):

- Exact major: `v20`, `20`, `20.1` -> that major version and all its
  releases/hotfixes (`20`, `20.*`).
- R-release: `v19 R8`, `19r8` -> exactly that R-release **plus** the
  entire next major version, since R-releases are effectively previews
  of the next major (`19_r8` + all of `20`).
- Approximate: `around v18`, `18 or thereabouts` -> one major version
  below and above (`17`, `18`, `19`).
- Open-ended: `before 17`, `after 20` -> all majors on the matching side
  of the boundary that exist in the dataset.

The min/max major bounds used to sanity-check a parsed number (so an
unrelated two-digit number in a message isn't mistaken for a version)
are computed **dynamically from the loaded `meta.json`** at boot time,
not hardcoded — the shipped dataset spans majors **15-21** (the user's
initial ask assumed 13-21; the code doesn't hardcode either number, so
it's correct either way as the dataset evolves).

If a version filter is parsed but matches zero bugs, retrieval falls
back to an unfiltered semantic search and the system prompt tells the
model to mention that fallback to the user.

## Explicit ACI reference lookup

If a message names a specific bug reference ID (e.g. "what is
ACI0101931 about?", "aci 101931", case-insensitive, with or without
leading zeros), `retrieve()` in `app.js` matches it via
`extractExplicitRefs` (`\bACI\s*0*(\d{1,7})\b`, normalized to the
dataset's exact `ACI` + 7-zero-padded-digits format) and does a direct
exact-match lookup in `meta.json` instead of semantic search — faster
and more accurate for the common "tell me about bug X" case. If none of
the mentioned IDs exist in the dataset, retrieval falls back to normal
version-aware semantic search and the system prompt is told which
ID(s) were not found, so the model states that plainly instead of
guessing.

## Key implementation decisions

- **Same pinned model version on both sides.** The Node precompute
  script and the browser page both import the exact same
  `@xenova/transformers` version (`2.17.2`) and use identical
  `{ pooling: 'mean', normalize: true }` settings, so query embeddings
  are directly comparable (dot product = cosine similarity) to the
  precomputed matrix without any drift.
- **No quantization.** float32 embeddings for 2,420 bugs are already
  only ~3.7 MB, well under the "few MB" target, so quantization would
  have added complexity (dequantization, precision loss) for no real
  size benefit.
- **Custom safe renderer instead of a markdown library.** Summaries only
  use `[text](url)` links, `` `code` `` spans, and `*italic*` (confirmed
  by scanning the dataset — no bold, no fenced code blocks anywhere).
  `docs/src/render.js` HTML-escapes the raw text first, then a single
  regex-alternation pass converts just those three inline constructs,
  restricting link `href`s to an allowlist prefix
  (`https://developer.4d.com/`) as defense-in-depth. A general markdown
  library was judged unnecessary complexity/attack surface for this
  narrow, confirmed-safe subset of syntax.
- **Deterministic JS retrieval instead of model-driven tool-calling.**
  The system prompt explains the version rules to the model for
  transparency/citation reasoning, but the actual filtering/ranking
  always runs in `app.js` before every model call — a 1B-parameter local
  model cannot reliably self-drive a real tool-calling loop, so this
  keeps retrieval correct and fast regardless of model quality.
- **WebLLM-only RAG, now auto-loaded on page boot.** Confirmed with the
  user this should be fully local/private with no hosted-API path.
  Earlier iterations gated the (large, one-time, ~1GB) model download
  behind an explicit "Enable" button; the user later asked for the app
  to just be a chat interface, auto-loading on open with the UI disabled
  until ready, so the button was removed and boot now runs the full
  sequence (dataset -> embedder -> WebLLM) automatically, surfacing
  progress via a status line.
- **`env.allowLocalModels = false` for transformers.js.** By default
  transformers.js probes a local `/models/...` path before falling back
  to the Hugging Face CDN, causing spurious 404s in the browser console
  on every load. Setting this explicitly skips straight to the CDN.
- **Citations as bold text, not scroll-linked.** Earlier iterations had
  a visible result-card list that ACI-reference citations in chat could
  scroll to. Once that list was removed in the single-chat redesign,
  citations became plain emphasized text (`<strong class="citation">`)
  since there's no longer a card to link to.
- **Deterministic hits table, independent of model prose quality.** The
  1B local model was observed to sometimes ignore good retrieval
  results and claim "I don't have information" even when relevant bugs
  had been found. Rather than relying purely on prompt engineering to
  fix that, `app.js` now always renders an HTML table of the top 8
  retrieved bugs (ACI reference, versions as `bugs.4d.com` links, and
  summaries with their command links to `developer.4d.com`) underneath
  every assistant reply, built directly from the retrieval data. The
  model's prose is just a short complementary summary — the actual
  results are always shown correctly regardless of what the model says.
- **Positive-only system prompt phrasing.** An earlier system prompt
  used heavy negative/imperative language ("IMPORTANT", "forbid",
  "never say ...") to stop the model from claiming no information was
  found. This backfired: the small model latched onto the refusal-like
  framing and started giving generic declines even for clearly on-topic,
  well-matched questions. The prompt was rewritten to short, positive
  instructions that assume every message is in-scope and simply ask for
  a brief helpful summary, which resolved the spurious refusals.

## History of iterations (chronological, high level)

1. **v1 (search + opt-in RAG):** search box + top-K selector + result
   cards (rendered summary, version list, linked commands) + a separate
   opt-in "Enable local AI answers" panel below the results.
2. **v2 (UI polish):** version codes became links to
   `https://bugs.4d.com/fixedbugslist?version=<version>`; similarity
   score rendered as a horizontal bar graph; results moved into a
   scrollable panel; added selecting a subset of results (or resetting
   to all); local AI became a persistent chatbot (speech bubbles) whose
   context was the current subset/results, with explicit clear/copy
   buttons, and a new search no longer cleared the conversation.
3. **v3 (markdown rendering fix):** the renderer only handled links;
   inline code spans and italics in real summaries were showing as raw
   `` `text` ``/`*text*`. Extended `render.js` to handle all three
   constructs safely.
4. **v4 (single chat interface):** removed the search
   box/top-K select/results list/subset picker entirely. The whole page
   is now one chat interface that auto-boots (dataset, embedder, WebLLM,
   in that order) with input disabled until ready. Every message
   triggers automatic version-aware retrieval (see rules above); the
   system prompt restricts the model to the bug database's scope and
   politely declines anything else. Clear/copy conversation controls are
   kept from v2.
5. **v5 (current — RAG quality + direct ID lookup):** fixed a real-world
   failure mode where the small local model ignored good retrieval
   results and either claimed to have no information or gave generic
   refusals. Added a deterministic hits table (rendered from the actual
   retrieval data, not the model's reproduction of it) and rewrote the
   system prompt from negative/imperative phrasing to short, positive
   instructions. Also added direct exact-match lookup for messages that
   name a specific ACI bug reference ID, bypassing semantic search for
   that case.

## Deployment

Published via GitHub Pages: repository Settings > Pages is configured
to build from the `main` branch, `/docs` folder
(`gh api --method POST repos/<owner>/<repo>/pages -f "source[branch]=main" -f "source[path]=/docs"`).
Live at `https://miyako.github.io/4d-fixed-bugs/`. Because the initial
PR (#2) was merged to `main` early — before the later rounds of
iteration in this document — a follow-up PR (#4) was opened and merged
to bring `main` fully up to date before Pages was enabled, so the live
site reflects the current single-chat architecture rather than the
original search-bar version.

## Verification performed

- Ran `scripts/generate_embeddings.mjs` end-to-end: produced
  `docs/data/embeddings.bin` (3,717,120 bytes = 2420 x 384 x 4, verified
  shape) and `docs/data/meta.json` (2,420 records); spot-checked that
  embedding vectors are unit-normalized (L2 norm ~= 1.0).
- Headless Playwright tests against a local static server, using
  `page.route()` to intercept the WebLLM CDN import and serve a fake
  `CreateMLCEngine` (so full conversational flow can be tested without
  downloading the real ~1GB model):
  - Boot sequence completes and enables the chat input automatically
    with no click required; boot status line reports the dataset size
    and detected version range (15-21).
  - Each of the 4 version-rule categories was exercised with a concrete
    phrasing ("...in v20", "...in 19r8", "...around v18 or
    thereabouts", "...before v17") and the resulting system prompt sent
    to the model was confirmed to contain the correct rule description
    for each case.
  - An off-topic question ("What is the capital of France?") still
    performs retrieval (so the model has *some* context either way) and
    the system prompt always contains the scope-restriction/decline
    instruction — actual refusal behavior depends on the real model at
    runtime, which cannot be exercised by the mock.
  - Conversation persists across multiple turns (no reset on new
    messages); "Clear conversation" empties it; "Copy conversation"
    copies both the transcript and the last-retrieved bug set to the
    clipboard.
  - Zero console/page errors across the whole flow.
  - `render.js` confirmed (from earlier passes, still valid — renderer
    unchanged in this iteration) to reject a synthetic `javascript:` URL
    and HTML-escape a raw `<script>` tag embedded in test input.
- Follow-up Playwright passes for the v5 fixes (also using the mocked
  WebLLM engine):
  - The hits table renders the correct top-8 bugs with working version
    and command links even when the mocked model reproduces the exact
    "I don't have any information" failure mode originally reported.
  - The rewritten, positive-only system prompt was confirmed to no
    longer contain "IMPORTANT"/"forbid"/"Never say" phrasing.
  - Explicit ACI ID lookup: exact-format (`ACI0101931`) and loosely
    formatted (`aci 101931`, no leading zeros) IDs both resolve to a
    single, correct exact-match result; a nonexistent ID falls back to
    semantic search with a "not found" note surfaced to the model;
    normal semantic queries (no ID mentioned) are unaffected.
  - Conversation persistence, copy, and clear continue to work
    correctly after all of the above changes, with zero console errors.
- Verified the live GitHub Pages deployment directly: `curl` confirms
  `https://miyako.github.io/4d-fixed-bugs/` returns 200 with the current
  (single-chat) `<title>`, and `data/meta.json` / `src/app.js` are both
  reachable at their expected paths.

## Possible follow-ups (not done in this pass)

- Offer a choice of chat model sizes/quality in the UI (e.g.
  Llama-3.2-1B vs. Phi-3.5-mini) instead of a single hardcoded model.
- Re-run `scripts/generate_embeddings.mjs` whenever
  `data/all_bugs_enriched.json` or `data/all_bugs_context.json` change,
  and commit the refreshed `docs/data/*` artifacts.
- Consider surfacing which bugs were actually retrieved for a given
  answer somewhere in the UI (currently only visible via "Copy
  conversation" or by asking the model directly), now that there's no
  standing result list to glance at.
- **Model swap evaluation (in progress, separate branch/session):**
  GitHub issue #3 tracks evaluating LiquidAI's LFM2.5-1.2B-Thinking
  (ONNX/WebGPU) as an alternative to WebLLM's Llama-3.2-1B, since it's
  not a drop-in model-ID swap (different runtime: raw
  `onnxruntime-web` + manual generation loop vs. WebLLM's high-level
  chat API). Being prototyped on a separate branch behind a pluggable
  engine flag so it can be compared without risking this working
  implementation.
