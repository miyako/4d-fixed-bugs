# Updating the dataset

The site is a static build over a crawled dataset. This is how to refresh it
when 4D ships new fixes.

```
./scripts/update.sh
```

That runs the deterministic stages, stops at the enrichment gate if there is
prose to write, and tells you what to do next. Everything is incremental: only
bugs whose source text actually changed get re-written and re-embedded.

## The pipeline

| # | Stage | Script | Output |
|---|-------|--------|--------|
| 1 | Crawl | `scripts/update/crawl.py` | `html/`, `crawl_log.tsv`, page hashes in `data/update_state.json` |
| 2 | Parse | `scripts/update/parse.py` | `data/bugs_raw.json`, `data/version_sources.json` |
| 3 | JP sync | `scripts/update/sync_jp.py` | `data/jp_notes.json` (+ shallow clones in `vendor/`) |
| 4 | Context | `scripts/update/build_context.py` | `data/all_bugs_context.json`, `data/pending_enrichment.json` |
| — | **Enrichment (manual gate)** | `scripts/update/ENRICHMENT_PROMPT.md` | `data/enrichment/chunk_N.out.json` |
| 5 | Merge | `scripts/update/merge_enrichment.py` | `data/all_bugs_enriched.json` |
| 6 | Link check | `scripts/update/check_links.py` | verified URLs cached in `data/update_state.json` |
| 7 | Build | `scripts/update/generate_embeddings.mjs` | `docs/data/meta.json`, `docs/data/embeddings.bin`, `docs/src/beta-versions.js` |
| 8 | Cache-bust | `scripts/update/bump_cache_bust.py` | `docs/index.html` `?v=N` |

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
incremental on the same principle: a bug whose `summary` is byte-identical to
the one in the existing `docs/data/meta.json` keeps its existing vector row.

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

This is the only step that needs judgement, and the only one where written
content enters the dataset.

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
python3 scripts/update/build_context.py --force-all
# …write all ~2,400 summaries…
(cd scripts && node update/generate_embeddings.mjs --force)
```

`--force-all` and `--force` bypass the fingerprint and row-reuse logic
respectively. Use `--force` on its own after an embedding-model change, when
the summaries are unchanged but every vector must be recomputed.

## Link rot

Every documentation URL in a summary points at developer.4d.com, and 4D
reorganizes that site occasionally, so links that were correct when they were
written can quietly start 404ing. Stage 6 re-checks them:

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

## Known defects in the Japanese source

`sync_jp.py` tolerates all of these, so the dataset is correct either way — but
they are malformed upstream and worth fixing at the source. Re-run the audit
any time with:

```
python3 scripts/update/lint_jp_source.py --links
```

Line numbers below are as of `4D-jp.github.io` @ `24fe121` and `release-notes`
@ `e149e67`.

### 1. Bad spacing after the bullet marker (7 lines)

With **no** space after the asterisk, CommonMark does not see a list item at
all — the line renders as running text with a stray emphasis marker, so these
are wrong on the published site too, not only for this pipeline.

`*ACI0106136` — no space; the same note is duplicated across four posts:

- [`_posts/2026-01-13-release-note-version-21.md#L82`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2026-01-13-release-note-version-21.md#L82)
- [`_posts/2026-02-23-release-note-version-21r2.md#L165`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2026-02-23-release-note-version-21r2.md#L165)
- [`_posts/2026-03-19-release-note-version-21.md#L76`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2026-03-19-release-note-version-21.md#L76)
- [`_posts/2026-08-26-release-note-version-20.md#L86`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2026-08-26-release-note-version-20.md#L86)

`*ACI0094436` — no space:

- [`v15/15.2/hf2/README.md#L118`](https://github.com/4D-JP/release-notes/blob/master/v15/15.2/hf2/README.md#L118)

`*  ACI0098713` — two spaces; renders fine, but breaks a single-space regex:

- [`_posts/2019-02-08-release-note-version-17r4.md#L222`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2019-02-08-release-note-version-17r4.md#L222)
- [`_posts/2019-02-11-release-note-version-17.md#L152`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2019-02-11-release-note-version-17.md#L152)

### 2. Reference not separated from the note text (11 lines)

The id runs straight into the summary — `* ACI0103196Mac版のみ。`. This renders,
but it reads as one token and only parses because a reference is known to be
exactly 7 digits. The worst case is
[`v17/r2/README.md#L40`](https://github.com/4D-JP/release-notes/blob/master/v17/r2/README.md#L40), `* ACI009838832ビット版のみ`,
which is `ACI0098388` followed by `32ビット版` — a human could reasonably read
that id as 8 or 9 digits long.

| Reference | File |
|---|---|
| `ACI0103196` | [`_posts/2022-10-10-release-note-version-19r7.md#L173`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2022-10-10-release-note-version-19r7.md#L173) |
| `ACI0103964` | [`_posts/2023-07-09-release-note-version-20.md#L135`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2023-07-09-release-note-version-20.md#L135) |
| `ACI0104521` | [`_posts/2024-01-04-release-note-version-20r4.md#L221`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2024-01-04-release-note-version-20r4.md#L221) |
| `ACI0104521` | [`_posts/2024-02-04-release-note-version-20.md#L128`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2024-02-04-release-note-version-20.md#L128) |
| `ACI0104864` | [`_posts/2024-06-26-release-note-version-20r7.md#L144`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2024-06-26-release-note-version-20r7.md#L144) |
| `ACI0104864` | [`_posts/2024-11-24-release-note-version-20.md#L70`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2024-11-24-release-note-version-20.md#L70) |
| `ACI0105403` | [`_posts/2025-01-19-release-note-version-20r7.md#L31`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2025-01-19-release-note-version-20r7.md#L31) |
| `ACI0106065` | [`_posts/2025-09-09-release-note-version-21.md#L53`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2025-09-09-release-note-version-21.md#L53) |
| `ACI0106230` | [`_posts/2026-02-23-release-note-version-21r2.md#L38`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2026-02-23-release-note-version-21r2.md#L38) |
| `ACI0092551` | [`v15/r2/README.md#L330`](https://github.com/4D-JP/release-notes/blob/master/v15/r2/README.md#L330) |
| `ACI0098388` | [`v17/r2/README.md#L40`](https://github.com/4D-JP/release-notes/blob/master/v17/r2/README.md#L40) |

### 3. Truncated references (5 lines, 4 distinct bugs)

Every other reference in both repos is `ACI` + exactly 7 digits; these have 6,
so an `ACI\d{7}` matcher skips them silently. **The correct id could not be
recovered** — neither a prefix match nor a symptom search against the
bugs.4d.com dataset identifies any of them — so each needs checking against the
original bug report before it can be corrected.

| Written as | Subject | File |
|---|---|---|
| `ACI009873` | `entity.clone()` returns empty fields in client/server | [`_posts/2018-10-18-release-note-version-17.md#L160`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2018-10-18-release-note-version-17.md#L160) |
| `ACI009873` | (same note, duplicated) | [`v17/17.0/hf3/README.md#L153`](https://github.com/4D-JP/release-notes/blob/master/v17/17.0/hf3/README.md#L153) |
| `ACI009938` | Write Pro underline/strikethrough style sheet, Mac | [`_posts/2019-05-15-release-note-version-17r5.md#L299`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2019-05-15-release-note-version-17r5.md#L299) |
| `ACI010148` | accented-character input via key repeat, Mac | [`_posts/2020-10-19-release-note-version-18r5.md#L94`](https://github.com/4D-JP/4D-jp.github.io/blob/master/_posts/2020-10-19-release-note-version-18r5.md#L94) |
| `ACI008907` | Structure editor full-width → half-width rename | [`v15/r2/README.md#L48`](https://github.com/4D-JP/release-notes/blob/master/v15/r2/README.md#L48) |
