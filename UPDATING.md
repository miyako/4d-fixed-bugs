# Updating the dataset

The site is a static build over a crawled dataset. This is how to refresh it
when 4D ships new fixes.

```
./scripts/update.sh
```

That runs the deterministic stages, stops at the enrichment gate if there is
prose to write, and tells you what to do next. Everything is incremental: only
bugs whose source text actually changed get re-written. Search vectors are
reused only after their shared model contract and corpus integrity verify.

## Running it on GitHub Actions

The *Update dataset* workflow (`.github/workflows/update-dataset.yml`) runs the
same pipeline on demand (Actions → Update dataset → Run workflow):

- **mode `update`** (optionally with *full crawl*) runs stages 1–4 and opens a
  pull request with the result. If bugs need English summaries, the pipeline
  stops at the enrichment gate and the PR body lists them. Write the prose on
  the PR branch (see [Writing the enrichment](#writing-the-enrichment)),
  merge it with `merge_enrichment.py`, push, then re-run the workflow **on
  that branch** with mode `build-only`. If nothing is pending, the PR already
  contains the rebuilt site data.
- **mode `build-only`** runs stages 6–13 on the selected branch and commits the
  result back to it. If Japanese or French summaries are pending it stops at the
  translation gate instead (see [The Japanese site](#the-japanese-site) and
  [The French site](#the-french-site)). PR messaging lists both queues.

The repository must allow *GitHub Actions to create and approve pull requests*
(Settings → Actions → General → Workflow permissions).

## The pipeline

| # | Stage | Script | Output |
|---|-------|--------|--------|
| 1 | Crawl | `scripts/update/crawl.py` | `html/`, `crawl_log.tsv`, page hashes in `data/update_state.json` |
| 2 | Parse | `scripts/update/parse.py` | `data/bugs_raw.json`, `data/version_sources.json` |
| 3 | JP sync | `scripts/update/sync_jp.py` | `data/jp_notes.json` (+ shallow clones in `vendor/`) |
| 4 | Context | `scripts/update/build_context.py` | `data/all_bugs_context.json`, `data/pending_enrichment.json` |
| — | **Enrichment (manual gate)** | `scripts/update/ENRICHMENT_PROMPT.md` | `data/enrichment/chunk_N.out.json` |
| 5 | Merge | `scripts/update/merge_enrichment.py` | `data/all_bugs_enriched.json` |
| 6 | Translation context | `scripts/update/build_translation.py` (also `--lang fr`) | `data/pending_translation.json`, `data/pending_translation_fr.json` |
| — | **Translation (manual gate)** | `scripts/update/TRANSLATION_PROMPT.md`, `scripts/update/TRANSLATION_PROMPT_FR.md` | `data/translation/chunk_N.out.json`, `data/translation_fr/chunk_N.out.json` |
| 7 | Merge translation | `scripts/update/merge_translation.py` (also `--lang fr`) | `data/all_bugs_ja.json`, `data/all_bugs_fr.json` |
| 8 | Link check | `scripts/update/check_links.py` | verified URLs cached in `data/update_state.json` |
| 9 | Locked dependencies + CDN runtime verification | `npm ci --prefix scripts` then `npm run build:search-runtime --prefix scripts` | verified gitignored runtime cache; committed licenses/versions only |
| 10 | Build (en) | `scripts/update/generate_embeddings.mjs` | `docs/data/{meta.json,embeddings.bin,search-index.json}`, `docs/src/beta-versions.js` |
| 11 | Build (ja) | `scripts/update/generate_embeddings.mjs --lang ja` | `docs/data/ja/{meta.json,embeddings.bin,search-index.json}` |
| 12 | Build (fr) | `scripts/update/generate_embeddings.mjs --lang fr` | `docs/data/fr/{meta.json,embeddings.bin,search-index.json}` |
| 13 | Cache-bust | `scripts/update/bump_cache_bust.py` | English, Japanese and French `index.html` `?v=N` |

`html/` and `vendor/` are gitignored — both are large and fully reproducible.

## The two bugs.4d.com listings

bugs.4d.com serves two different lists with two different HTML layouts, and
the crawler probes both:

- `?version=<v>` — released products (`All Products 21.2`). Rows are
  `<th class="title 4D">`. A version that does not exist returns HTTP 200 with
  `<div class="standard_error">`.
- `?branch=<v>` — beta / nightly builds (`Beta 4D 21 R4`). Rows are
  `<td class="title">` with build number and build date columns. A branch that
  does not exist returns an essentially empty document.

A version in beta has **no** released listing: `?version=21_r4` returns the
error page while `?branch=21_r4` has its bugs. Those versions are recorded as
`beta_only_versions` in `data/update_state.json` and baked into
`docs/src/beta-versions.js` so the client links them to `?branch=` instead.

bugs.4d.com does not rate-limit. The 403-looking responses seen historically
came from curl's default User-Agent, not request frequency — a normal browser
User-Agent fixes it, and no sleeps or backoff are needed. The crawler uses the
system `curl` rather than Python's urllib because some Python installs have no
usable CA trust store.

## How the delta is tracked

`data/update_state.json` is the memory between runs. It holds:

- `pages` — per crawled page: status, bug count, and a SHA-256 of the HTML.
  Used to report which pages are new/changed/gone, and to drive the frontier
  logic in `--fast` crawls.
- `enrichment_fingerprints` — per bug: a SHA-256 over the inputs that affect
  its English prose, namely `raw_summary` plus its Japanese notes. Deliberately
  **not** `versions`: a bug appearing in one more hotfix changes the version
  list but not what the summary should say, so it costs nothing downstream.
- `jp` — the HEAD sha of each 4D-JP clone.
- `beta_only_versions`, `counts` — build inputs and a run summary.

A bug is queued for enrichment only when it is new, or when its fingerprint
differs from the one recorded at its last enrichment. The embedding step is
incremental only after the previous `search-index.json` contract, record
count/bytes and metadata/vector SHA-256 checksums verify. Under that verified
contract, an unchanged `documentText(record)` keeps its existing vector row;
reference, summary and command changes can invalidate it. Version-only changes
do not alter the embedded document. Missing/mismatched contract or integrity
automatically forces full recomputation, even if dimensions match.

On the very first run there are no fingerprints, so they are bootstrapped from
the existing `data/all_bugs_context.json` — that file is the record of what the
original enrichment actually read.

`build_context.py` aborts if more than `--max-pending` (default 400) bugs are
queued. A source-format change upstream would otherwise silently invalidate the
whole dataset and trigger a full 2,400-bug rewrite.

## Crawl modes

- `--fast` (default): re-probe every known-good page, plus a bounded frontier
  (three candidates past the newest release in each series) and any hotfix of a
  known release. Enough to discover new releases without re-probing the full
  candidate space.
- `--full`: probe every candidate — majors 18–22, feature releases `r2`–`r14`
  with `hf1`–`hf6`, minors `.1`–`.9` with `hf1`–`hf6`, against both listings
  (~1,550 requests, a couple of minutes). Use after editing `majors` in
  `data/update_state.json`, or if you suspect the frontier logic missed
  something.

## Writing the enrichment

Enrichment and translation are the manual steps where written content enters
the dataset.

```
python3 scripts/update/split_pending.py --chunks 4
```

splits `data/pending_enrichment.json` into self-contained chunk files. Hand
each chunk plus `scripts/update/ENRICHMENT_PROMPT.md` to a worker (agent or
person); each chunk is complete input, nothing else needs to be read. Write
`chunk_N.out.json` next to each input, then:

```
python3 scripts/update/merge_enrichment.py data/enrichment/chunk_N.out.json --partial
```

The merge step validates hard before writing anything: references must exist
and be pending, summaries must be real prose, every markdown link must point at
`https://developer.4d.com/` (the client's renderer allowlists exactly that
prefix), and every name in `commands` must exist in `data/command_index.json`
and be mentioned in the summary. Drop `--partial` once the final chunk lands to
assert that nothing is left unwritten.

Then finish the build:

```
./scripts/update.sh --build-only
```

## The Japanese site

`docs/ja/` is the same app over a Japanese dataset. Every bug gets a Japanese
summary in `data/all_bugs_ja.json`, written from two sources: the English
summary (structure, facts, doc-links) and the bug's `jp_notes` — the original
text 4D Japan published, which is the authority on Japanese wording. Each record
keeps the fingerprint of both sources it was written from, so a bug is queued
again only when its English summary or its JP notes change.

After the English summaries are merged, `./scripts/update.sh --build-only` runs
`build_translation.py` and stops at the translation gate if anything is
pending:

```
python3 scripts/update/split_pending.py --kind translation
# hand each data/translation/chunk_N.json + scripts/update/TRANSLATION_PROMPT.md to a worker
python3 scripts/update/merge_translation.py data/translation/chunk_N.out.json --partial
./scripts/update.sh --build-only
```

`merge_translation.py` validates hard: every link from the English summary must
be present with identical (English) link text and its URL moved under
`https://developer.4d.com/docs/ja/`; every code span and ACI reference must be
preserved; the text must actually be Japanese, one paragraph, in the allowed
markdown subset. Warnings flag sentences not in polite form (です・ます調),
numbers dropped from the English, and long untranslated English runs; pass
`--strict` to make them errors.

The Japanese dataset retains every localized summary but now uses the same
text-only EmbeddingGemma 2 contract as English and French. The old ruri model
and its Japanese document/query prefixes are historical, not current settings.
See [Unified search build](#unified-search-build) below.

## The French site

`docs/fr/` has a full French summary for every canonical English bug.
French translation uses **only `summary_en` and `commands`**, never Japanese
notes or Japanese summaries. These scripts default to `--lang ja` for backwards
compatibility; select French explicitly:

```sh
python3 scripts/update/build_translation.py --lang fr
python3 scripts/update/split_pending.py --kind translation --lang fr
# translate each data/translation_fr/chunk_N.json per scripts/update/TRANSLATION_PROMPT_FR.md
python3 scripts/update/merge_translation.py --lang fr data/translation_fr/chunk_N.out.json --partial --strict
./scripts/update.sh --build-only
```

The queue is `data/pending_translation_fr.json`; merged records live in
`data/all_bugs_fr.json`. The SHA-256 source fingerprint covers the English
summary and command set, not JP notes. Only changed inputs are requeued;
removed bugs lose their translations. A stale queue is rejected at merge if
English or commands changed: rebuild the context and translate the new input.
`--dry-run`, `--partial`, `--strict`, `--force-all` and `--max-pending` behave as
for Japanese. Drop `--partial` on the final merge to require full coverage.

Preserve command names, inline code, ACI references and every Markdown link's
label and **original English URL exactly**; no `/docs/fr/` localization.
Summaries must be single-paragraph French prose. Validation shares Japanese's
structural invariants but not Japanese character/politeness heuristics; French
without accents is valid, identical English is rejected, and missing numbers
produce warnings (`--strict` makes them errors).

Both queues are refreshed before the translation gate. No language's build
runs until both queues are empty. French summaries remain French; the encoder
is now shared with English and Japanese. The old E5 model, `"passage: "` /
`"query: "` prefixes and E5 score cutoffs must not be used by the current
EmbeddingGemma 2 contract.

## Unified search build

`docs/src/search-config.js` is the single encoder contract for all languages:

- `onnx-community/embeddinggemma-2-ONNX` pinned to revision
  `daa72c51243991dfcaf9f9137d2c573d8f7790c0`, the text-only 270M model in `q4`.
- Clear `vision_config` and `audio_config`; use its exported
  `sentence_embedding`, explicitly L2-normalized to **768 dimensions**,
  with truncation at **512 tokens**. This is not generic feature-extraction
  mean pooling.
- `documentText(record)` formats
  `title: ${reference} | text: ${markdown-links-stripped localized summary}`
  followed by a newline and command names joined with `" · "`.
- Query text is exactly `"task: search result | query: " + query`.

The CPU encoder (`scripts/update/search-encoder.mjs`) downloads the pinned
artifacts into `.cache/search-model/<revision>/` and verifies their SHA-256
checksums. `SEARCH_MODEL_PATH=/path/to/model-directory` selects existing local
artifacts, but does not bypass verification. The workflow caches
`.cache/search-model` and `.cache/search-runtime` with a key including the shared
search contract, runtime URL/hash configuration and package lock.

Restore locked dependencies and verify the official CDN runtime **before** indexing:

```sh
npm ci --prefix scripts
npm run build:search-runtime --prefix scripts
(cd scripts && node update/generate_embeddings.mjs)
(cd scripts && node update/generate_embeddings.mjs --lang ja)
(cd scripts && node update/generate_embeddings.mjs --lang fr)
```

Dependencies are pinned to `@huggingface/transformers@4.3.1`, with Playwright
tooling. `docs/src/runtime-config.js` specifies the official immutable module
`https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js`,
the exact ORT `wasmPaths` base
`https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/`,
and known SHA-256 digests for every official runtime file, including all three
`.mjs`/`.wasm` flavors.

The command name `build:search-runtime` remains compatible, but now verifies
locked installed npm versions and upstream file hashes, downloads CDN files
into gitignored `.cache/search-runtime/4.3.1/`, and checks their digests match.
Cached files are revalidated rather than blindly trusted; corrupt/missing
entries are downloaded again, and a mismatched response fails verification.
Verification can reuse a valid cache when the CDN is unavailable; with no valid
cache, an unavailable CDN file stops the stage rather than selecting a different
version. Browser CDN failures use the explicit keyword fallback described below.
There is no bundling or executable runtime vendoring. Commit only the retained
Transformers.js, tokenizer, Jinja and ORT licenses/notices and `versions.json`
in `docs/search-runtime/4.3.1/` alongside
the index artifacts. Deployment remains GitHub Pages from `main` / `docs`,
not a new deployment workflow.

For each of `docs/data/`, `docs/data/ja/` and `docs/data/fr/`, commit `meta.json`,
`embeddings.bin` and `search-index.json` together. The manifest contains the
full `contract`, `count`, `bytes`, `metadata_sha256` and `vectors_sha256`.
The generator automatically recomputes on any contract/integrity mismatch;
`--force` remains available to explicitly rebuild every vector. Changing model,
revision, precision, text format or runtime is not safe just because dimensions
happen to remain the same.

The browser automatically attempts WebGPU inference in a worker. Localized
metadata keyword search remains usable during download, on unsupported WebGPU,
CDN/model load failure or query failure. `#search-status` shows progress/fallback state
and a retry button allows another attempt. Keyword badges describe lexical
matches, not semantic confidence percentages. There is no generic quantized
WASM encoder fallback. ACI lookup, case-sensitive command matching and version
filters remain available in either search mode.
Queries containing only recognized command/version criteria bypass encoding
and semantic floors, returning the exact filtered pool with a localized
`Filter` / `Filtre` / `条件一致` badge in every loading/device state.
Bug descriptions still use semantic ranking and thresholds; ACI lookup is
unchanged. Unknown terms are not discarded: `weather after v20` must not turn
into an exact version-only search, including in keyword fallback.

## Tests

```
cd scripts && npm ci && npm test                  # unit tests (JS + Python)
node ../tests/eval/eval_retrieval.mjs --lang en --min-recall8 0.95 --min-visible-recall8 0.95 --max-off-topic-hits 0
node ../tests/eval/eval_retrieval.mjs --lang ja --min-recall8 0.95 --min-visible-recall8 0.95 --max-off-topic-hits 0
node ../tests/eval/eval_retrieval.mjs --lang fr --min-recall8 0.95 --min-visible-recall8 0.95 --max-off-topic-hits 0
PW_CHANNEL=chrome node ../tests/browser/smoke.mjs # locale pages in headless Chrome (needs network)
```

`eval_retrieval.mjs` also prints the score distribution of correct hits versus
off-topic queries. Recalibrate semantic scores in `docs/src/i18n.js` against
measured new-model results, not the old models' thresholds. Check keyword
fallback/retry separately; its lexical labels are not cosine-score calibration.

The French evaluation uses `tests/eval/fr_queries.json` (43 French counterparts
of the Japanese queries) and the generated `docs/data/fr/` corpus. Run it after
building the French embeddings. The commands above enforce a 95% floor for
both recall@8 and visible recall@8, so a good ranking that the client's score
threshold hides does not pass unnoticed. They also require zero evaluated
off-topic queries above the score floor.

All three indexes were built and verified with metadata byte-identical to
commit `3544f94`. Measured results on 43 aligned queries per language are:

| Language | Historical R@1 / R@8 / MRR | EmbeddingGemma 2 R@1 / R@8 / MRR | Active min / medium / high |
|---|---|---|---|
| English (old MiniLM) | 95.35% / 100% / .97093 | 88.37% / 100% / .94186 | .705 / .799 / .841 |
| French (old E5) | 72.09% / 88.37% / .80502 | 86.05% / 97.67% / .91122 | .702 / .800 / .841 |
| Japanese (old ruri) | 95.35% / 100% / .96802 | 93.02% / 97.67% / .95460 | .715 / .798 / .845 |

Each locale's cutoffs were independently calibrated: they retain every correct
top-eight hit and reject all 12 expanded negative queries per language.
This is not baseline parity: English top-one accuracy/MRR decline; Japanese
loses the `ACI0104021` top-eight hit (rank 2 → 21). French improves overall,
but `ACI0105986` regresses from rank 21 → 64, already outside the top eight.
The 95% gates are explicit acceptance floors, not assertions of no regression.

Durable reports are `tests/eval/embeddinggemma-{en,fr,ja}.json`,
`tests/eval/embeddinggemma-comparison.json` and `tests/eval/baselines.json`.
Inspect these comparisons and recalibrate after encoder or corpus changes;
the measured negative sets do not guarantee rejection of every off-topic query.

## Command matching

`scripts/update/match_commands.py` produces the *candidate* command links that
the enrichment step then judges. It uses two regimes, because naive matching
fails in both directions:

- Multi-word names are matched freely by scanning every 1–7-word phrase against
  `data/command_index.json`. A quote/case-based heuristic misses plain Title
  Case names in running prose (e.g. "Maximize Window").
- Single-word names are matched **only** when the text marks them as code —
  backticked, quoted, or strict ALL-CAPS — because ~105 of them are ordinary
  English words (`File`, `Form`, `Date`, `QUERY`). A free scan put spurious
  matches on 2,137 of 2,420 bugs. Single-character legacy commands are excluded
  outright.

Japanese prose runs command names straight into surrounding text with no
spaces, so non-Latin runs are replaced with whitespace before tokenizing, and
code spans are additionally matched whole.

Measured against the 2,420 hand-reviewed bugs of the original dataset: 94.7%
exact set match, precision 0.992, recall 0.883. The remaining gap is almost
entirely the original's over-matches on ambiguous single-word names.

## Full regenerate

Rarely needed, but supported:

```
./scripts/update.sh --full-crawl
npm ci --prefix scripts
npm run build:search-runtime --prefix scripts
python3 scripts/update/build_context.py --force-all
# …write all ~2,400 summaries…
(cd scripts && node update/generate_embeddings.mjs --force)
python3 scripts/update/build_translation.py --force-all
# …write all ~2,400 Japanese summaries…
(cd scripts && node update/generate_embeddings.mjs --lang ja --force)
python3 scripts/update/build_translation.py --lang fr --force-all
# …write all French summaries from canonical English…
(cd scripts && node update/generate_embeddings.mjs --lang fr --force)
```

`--force-all` and `--force` bypass the fingerprint and row-reuse logic
respectively. Use `--force` on its own after an embedding-model change, when
the summaries are unchanged but every vector must be recomputed.

## Link rot

Every documentation URL in a summary points at developer.4d.com, and 4D
reorganizes that site occasionally, so links that were correct when they were
written can quietly start 404ing. Stage 8 re-checks them (English, Japanese and French
summaries alike):

```
python3 scripts/update/check_links.py      # only unverified/previously-broken links
python3 scripts/update/check_links.py --recheck-all
```

Successful checks are cached under `link_checks` in `data/update_state.json`, so
a routine run verifies only the handful of URLs the latest enrichment
introduced. Run `--recheck-all` every few months to catch pages that have moved
since they were last confirmed.

When a whole command family moves, fix `data/command_index.json` as well as the
summaries — otherwise the next enrichment pass will cheerfully reintroduce the
dead URL. Two families already live outside `/docs/commands/`:

| Family | Correct path |
|--------|--------------|
| `VP …` (4D View Pro) | `https://developer.4d.com/docs/ViewPro/commands/vp-…` |
| `WP …` (4D Write Pro) | `https://developer.4d.com/docs/WritePro/commands/wp-…` |

Also note that a handful of genuinely old commands (`CHANGE USER`, for one) have
no page on developer.4d.com at all. Render those as a plain code span rather
than inventing a URL, and leave them out of the record's `commands` array.

## Known defects in the Japanese source (resolved)

An earlier version of this pipeline found 23 malformed ACI bullets across
both repos — bad spacing after the bullet marker, references glued directly
to the note text, and 4-6-digit truncated references. `sync_jp.py` tolerated
all of them, so the published dataset was never wrong, but they were genuine
defects upstream and were reported. 4D-JP fixed every one across a handful of
commits between `24fe121`→`c8bce5d` (`4D-jp.github.io`) and
`e149e67`→`fb8e68c` (`release-notes`).

Re-run the audit any time — it should report nothing:

```
python3 scripts/update/lint_jp_source.py --links
```

## Known defects in bugs.4d.com source (resolved)

`?version=` pages list, per bug, every other version it was "fixed also
with" as a link — `parse.py` follows every one of those links. One page
(`18_r4`/`18_r5`/`18_r6`) linked to `?version=18.3_nb_257605`, an internal QA
nightly-build snapshot that doesn't fit 4D's public version scheme
(`major[.minor][_rN][_hfM]`) but does resolve to a real (if useless) page, so
it was picked up as if it were a legitimate version and attached to 15 bugs.
`parse.py` now whitelists version tokens against that scheme
(`VALID_VERSION_RE`) and silently drops anything that doesn't match, so this
class of internal-tag leak can't recur.

Separately, when the same bug's summary text differs slightly across the
pages it appears on (typo fixed/reintroduced upstream, e.g. `Listbox` vs.
`listbox`), `parse.py` keeps the longest variant as canonical. Same-length
ties used to fall back to Python's hash-randomized `set` iteration order,
making a plain re-parse of unchanged HTML non-deterministic — it could flip
the chosen variant and spuriously mark a bug `source-changed`, pointlessly
demanding re-enrichment. Ties now break alphabetically, so re-parsing the
same HTML always yields the same `bugs_raw.json`.
