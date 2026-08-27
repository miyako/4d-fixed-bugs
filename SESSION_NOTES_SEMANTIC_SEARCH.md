# Session Notes: Client-Side Semantic Search + Local RAG

This document records the plan and implementation notes for the
`docs/` static semantic-search page over the fixed-bugs dataset, in the
same spirit as `SESSION_NOTES.md` for the crawl/enrichment pipeline —
working notes for future extension, not user-facing documentation.

## Goal

Build a fully static, client-side (no backend) web page that provides
semantic search over `data/all_bugs_enriched.json` (2,420 4D bug fixes),
running entirely in the browser, with an optional local RAG layer for
natural-language Q&A. Confirmed with the user up front: the RAG layer is
**WebLLM-only** — no hosted-API-key option — so nothing about a user's
query or the bug data ever leaves their browser.

## Architecture

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
2. **Static page** (`docs/`, no bundler, plain ES modules): on load,
   fetches the small precomputed data files. On first search, lazily
   loads the *same pinned* transformers.js model/version to embed the
   query, then ranks all 2,420 bugs via brute-force dot product (trivial
   at this scale — no vector DB needed). Renders top-K results.
3. **Optional local RAG** (`docs/src/rag.js`, opt-in only): explicit
   "Enable local AI answers" button downloads a small instruct model via
   `@mlc-ai/web-llm` (never auto-downloads — it's a large one-time
   fetch). Grounds answers to natural-language questions in the top-K
   semantic search hits, citing ACI references that are clickable and
   scroll to the matching result card.

## File/folder layout
```
docs/                          <- static site root (GitHub Pages: "/docs" on main)
  index.html
  style.css
  src/
    main.js                    <- app entry: search UI, embedding, ranking
    render.js                  <- safe markdown-link renderer for summaries
    rag.js                     <- WebLLM init + prompt building (lazy-loaded)
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
  ever use `[text](url)` link syntax. `docs/src/render.js` HTML-escapes
  the raw text first, then regex-linkifies that pattern, restricting
  `href` to an allowlist prefix (`https://developer.4d.com/`) as
  defense-in-depth against any future bad data injecting arbitrary
  links/HTML. A general markdown library was judged unnecessary
  complexity/attack surface for this narrow use case.
- **WebLLM-only RAG, opt-in, lazy-loaded.** Confirmed with the user this
  should be fully local/private with no hosted-API path. The model is
  never auto-downloaded (it's a large one-time fetch) — only starts on
  an explicit button click.
- **`env.allowLocalModels = false` for transformers.js.** By default
  transformers.js probes a local `/models/...` path before falling back
  to the Hugging Face CDN, causing spurious 404s in the browser console
  on every load. Setting this explicitly skips straight to the CDN.

## Verification performed

- Ran `scripts/generate_embeddings.mjs` end-to-end: produced
  `docs/data/embeddings.bin` (3,717,120 bytes = 2420 x 384 x 4, verified
  shape) and `docs/data/meta.json` (2,420 records); spot-checked that
  embedding vectors are unit-normalized (L2 norm ~= 1.0).
- Headless Playwright smoke test against a local static server:
  - Query "crash when printing PDF" returned 10 relevant, correctly
    ranked results (top hit `ACI0104561`, similarity 0.726) with **zero**
    console/network errors after fixing the `allowLocalModels` issue
    above.
  - `render.js` confirmed to reject a synthetic `javascript:` URL
    (rendered as plain text, no `<a>`) while correctly linkifying a real
    `developer.4d.com` URL, and to HTML-escape a raw `<script>` tag
    embedded in test input.
  - Clicking "Enable local AI answers" correctly kicked off WebLLM's
    model-loading flow (`CreateMLCEngine`) with no JS errors. The full
    ~1 GB model download itself was not waited out in this pass, but the
    wiring was confirmed correct.

## Possible follow-ups (not done in this pass)

- Offer a choice of RAG model sizes/quality in the UI (e.g.
  Llama-3.2-1B vs. Phi-3.5-mini) instead of a single hardcoded model.
- Re-run `scripts/generate_embeddings.mjs` whenever
  `data/all_bugs_enriched.json` or `data/all_bugs_context.json` change,
  and commit the refreshed `docs/data/*` artifacts.
