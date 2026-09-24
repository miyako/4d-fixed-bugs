# Session Notes: Building the 4D Fixed-Bugs Database

This document records how this dataset was built, including the dead ends
and mistakes, so future work (by a human or an agent) doesn't repeat them.
This is a working-notes file, not user-facing documentation — see the
project README for that.

## Goal

Crawl `bugs.4d.com` (the official 4D "fixed bugs" list, versions 18–21+)
and cross-reference with Japanese-language 4D-JP GitHub repos to build a
structured, searchable database of fixed bugs, each with:
- `reference` — the ACI bug ID (e.g. `ACI0104534`)
- `summary` — an English prose summary (not a copy-paste of the terse
  source text), with genuine 4D command names hyperlinked to
  developer.4d.com
- `versions` — every 4D version the fix shipped in (a bug is often
  backported/also-fixed in multiple releases)

## The 4D version numbering scheme

This was the hardest non-obvious piece of domain knowledge and is essential
to reconstructing/extending the crawl:

- Major version alone: `20` (`https://bugs.4d.com/fixedbugslist?version=20`)
- Feature release: `<major>_r<N>`, N starts at **2** (there is no `r1`;
  the major-only URL plays that role), e.g. `20_r10`
- Feature release + hotfix: `<major>_r<N>_hf<M>`, M starts at 1,
  e.g. `20_r10_hf2`
- Minor/patch release: `<major>.<N>`, N starts at **1** (no `.0`),
  e.g. `20.1`
- Minor release + hotfix: `<major>.<N>_hf<M>`, e.g. `20.1_hf1`
- Neither feature releases nor hotfixes have a fixed ceiling per major
  version — you must probe and stop when you hit "not found" (see below).
  As of this crawl: v18 is the oldest version bugs.4d.com has data for.

## Fails and dead ends (read this before re-crawling)

1. **`web_fetch` looked like it "worked" but wasn't actually usable for
   bulk fetching.** It returned HTML fine to the chat, but (a) there was no
   reliable way to persist its raw output verbatim to disk, and (b) it
   silently truncates long pages at ~20KB, which for `bugs.4d.com` pages
   with more than ~100 bug rows means **the page gets cut off mid-table**
   with no obvious error — you get a truncated-but-valid-looking result
   with correct HTML at the point of the cut, which is easy to mistake for
   a complete page. This wasted a lot of time confirming "did it fetch the
   full file or not" before the truncation behavior was understood.
   **Lesson: never trust `web_fetch` for anything you need the complete,
   verbatim byte content of. Use it only for quick human-readable previews.**

2. **`curl`/`wget` looked "rate-limited" (immediate rejection) — it wasn't.**
   The real cause was simply the default `curl`/`wget` User-Agent string
   being rejected by the server (looked like a 403/blocked response, easy to
   misdiagnose as anti-scraping throttling). Adding a normal browser
   `User-Agent` header fixed it completely.
   **Verified: 775 rapid sequential `curl` requests all returned HTTP 200
   with zero throttling, zero backoff needed, zero sleep needed.**
   **Lesson: don't assume rate-limiting from a blocked request without
   checking the response body/headers first — a missing/default
   User-Agent is a much more common and much easier fix.**

3. **Several early attempts saved corrupted/incomplete file sets** and had
   to be thrown away entirely (old `4d_bugs_html/`, `4d_bugs_html_clean/`,
   and several one-off scripts: `fetch_and_save.py`, `fetch_versions.py`,
   `process_batch.py`, `save_batch.py`, `save_chunks.sh`,
   `save_valid_batch.py`). Root cause was always the same underlying
   `web_fetch` truncation/non-persistence issue above, approached with
   different workarounds before the real fix (switch to `curl` + a real
   User-Agent) was found.
   **Lesson: when several successive workarounds all partially fail the
   same way, stop patching and re-diagnose the root cause instead of trying
   yet another workaround.**

4. **The working, final approach** (used to produce the data in this repo):
   plain `curl` with a standard browser `User-Agent` header, no delays
   needed, saving each response straight to disk. Invalid version strings
   don't 404 — they return HTTP 200 with a page containing
   `<div class="standard_error">`; that marker (not the HTTP status code)
   is what determines "not found" vs. "valid". See `scripts/crawl_4d_bugs.sh`
   for the reconstructed working script (candidate ranges: majors 18–22,
   releases r2–r14 with hotfixes hf1–hf6, minors .1–.9 with hotfixes
   hf1–hf6 — comprehensive over-probing is cheap and simpler than trying to
   predict exact ceilings).
   - Result: 2,420 unique ACI bug references discovered across versions
     18–21 (and their feature/minor/hotfix releases).

5. **Command-name extraction from free text is much harder than it looks.**
   Naive matching approaches both under- and over-matched:
   - *Under-matching*: a purely "quoted / backtick / ALL-CAPS" matcher
     missed plain, unquoted Title Case command names that appear in normal
     prose, e.g. **"Maximize Window"** in bug `ACI0104534` was invisible to
     the matcher even though `MAXIMIZE WINDOW` was correctly present in the
     command index — because nothing about its formatting in the source
     text signaled "this is a command name" to a quote/case-based heuristic.
   - *Over-matching*: switching to a free n-gram scan (checking every
     1–7-word phrase in the text against the ~1,492-command index) fixed
     the above, but ~105 single-word 4D command names are also common
     English words/operators (`Not`, `True`, `False`, `Old`, `Max`,
     `Field`, `File`, `After`, `A`, plus legacy single-letter commands
     `N,O,C,D,P,E,I,S,F,G,R,M,A`). A free scan matched these constantly in
     ordinary prose (2,137 of 2,420 bugs got spurious "matches").
   - **Final working approach**: split the command index into multi-word
     names (2+ words — matched freely via n-gram scan, low false-positive
     risk) vs. single-word names (matched *only* when they appear
     backtick-quoted, quote-marked, or in strict ALL-CAPS form in the
     source text, and excluding all single-character legacy commands
     entirely). Even this is treated as a *candidate* list, not ground
     truth — the enrichment step is explicitly told to independently judge
     each candidate's relevance before linking it, rather than trust the
     mechanical match blindly.
   - Also watch for a **tokenizer bug**: stripping/tokenizing text with a
     regex that doesn't explicitly strip leading/trailing quote characters
     will leave stray `'` / `"` stuck to tokens (e.g. `'License`,
     `usage'`), silently breaking multi-word phrase matches that would
     otherwise be exact. Strip `.,;:()'"` from every token after
     tokenizing, before joining into phrases.

6. **Command reference URLs**: initially planned to verify command names by
   searching developer.4d.com/blog.4d.com live, but discovered a **local
   static mirror of developer.4d.com** was available on the user's machine
   (Docusaurus-based, ~34K HTML files) — this made command verification
   fully offline/deterministic: canonical command index built by scanning
   `commands/`, `commands-legacy/`, `ViewPro/commands/`, `WritePro/commands/`
   for `<title data-rh=true>NAME | 4D Docs</title>`, giving 1,492 commands
   with their canonical `developer.4d.com/docs/...` URLs. No live web
   search was used for the final command-link data in this repo.
   **Lesson: always check whether a local/offline authoritative source
   exists before reaching for live web search/scraping — it's faster, more
   reliable, and removes an entire class of network/rate-limit failure
   modes.**

7. **Japanese-language cross-reference sources**: two GitHub repos
   (`4D-JP/4D-jp.github.io` blog posts under `_posts` with
   `layout: fix`, and `4D-JP/release-notes`) contain richer per-bug
   Japanese descriptions than the terse English bugs.4d.com text, and the
   `release-notes` repo already embeds markdown links to command docs.
   Fetching hundreds of individual files via the GitHub API would have been
   slow/rate-limited; **cloning both repos locally with
   `git clone --depth 1`** was fast and hit no issues. 2,341 of 2,420 bugs
   (96.7%) ended up with at least one matching JP note.

8. **Scale problem for prose writing**: rewriting 2,420 terse summaries
   into real English prose (not templated) is not something that scales
   as a single-session, single-pass task. Solution: split the enriched
   input into 18 chunks (~140 bugs each) and dispatch 18 parallel
   background sub-agents, each with a fully self-contained prompt (sub-agents
   are stateless) including the exact schema, a 40-bug hand-written pilot
   as a style reference, and explicit instructions to judge (not blindly
   trust) each mechanically-matched command candidate before linking it.
   All 18 completed cleanly with 0 schema/count/reference mismatches on
   merge.

## Pipeline summary (what actually worked, end to end)

1. **Crawl** (`scripts/crawl_4d_bugs.sh`): `curl` + browser User-Agent,
   probe every version-string candidate in the known numbering scheme,
   classify by presence/absence of `<div class="standard_error">`, save
   HTML to `exists/` or `notfound/`, log everything to `crawl_log.tsv`.
2. **Parse** (`scripts/parse_phase1.py`): regex-extract
   `(reference, raw_summary, versions)` rows from every file in `exists/`,
   validate the `ACI\d{7}` reference format (treat anything else as a
   typo/noise and drop it), merge duplicate references across files so
   each ACI number has one record with the union of all versions it was
   ever fixed in.
3. **Load** into SQLite (`fixed_bugs`, `fixed_bug_versions` tables).
4. **JP cross-reference**: clone `4D-JP/4D-jp.github.io` and
   `4D-JP/release-notes`, extract ACI-keyed Japanese notes, load into
   `jp_bug_notes` table.
5. **Command index**: build canonical command→URL table from a local
   static developer.4d.com mirror (`command_index.json`).
6. **Enrichment**: for every bug, build a context bundle (raw summary +
   versions + JP notes + candidate command matches), pilot a 40-bug
   hand-written sample for style approval, then batch the full 2,420-bug
   set across 18 parallel background agents, each translating/synthesizing
   into English prose and judging command-link relevance.
7. **Merge & load**: concatenate the 18 outputs, validate 1:1
   count/order/reference parity against the input, load `summary` and
   `commands` back into the `fixed_bugs` SQLite table.

## Files in this repo (as transferred from the working session)

- `crawl_log.tsv` — full crawl log (version, status, http_code, bytes,
  bug_count) for every version string probed.
- `scripts/crawl_4d_bugs.sh` — the crawler (reconstructed faithfully from
  session notes; the original temp-file copy was lost to `/tmp` cleanup
  before transfer, but the logic, headers, and detection marker are exactly
  as used to produce `crawl_log.tsv` and the raw HTML that fed `bugs_raw.json`).
- `scripts/parse_phase1.py` — the exact working HTML→JSON parser (path
  adjusted to be repo-relative instead of session-absolute).
- `parsed/bugs_raw.json` — Phase 1 output: 2,420 bugs, raw (unenriched)
  summaries + versions, straight from bugs.4d.com HTML.
- `parsed/jp_notes.json` — Japanese-language cross-reference notes keyed
  by ACI reference.
- `parsed/command_index.json` — 1,492 canonical 4D command names → title +
  developer.4d.com URL.
- `parsed/all_bugs_context.json` — Phase 2 input: full context bundle per
  bug (raw summary, versions, JP notes, candidate command matches) used to
  drive the enrichment batch.
- `parsed/pilot_bugs.json` / `parsed/pilot_report.md` — the 40-bug,
  human-reviewed pilot that set the style/quality bar for the full batch.
- `parsed/all_bugs_enriched.json` — **final output**: all 2,420 bugs with
  English prose `summary` and judged/verified `commands` hyperlinks.

Raw HTML (`exists/`, `notfound/`) was not transferred (large, and fully
reproducible from `crawl_4d_bugs.sh` — the JSON artifacts above are the
durable value).

---

# Addendum: the 2025 incremental-update session (2,420 → 2,458 bugs)

The notes above describe the original one-shot build. This addendum records
what changed when the dataset was refreshed for the first time, and what that
exercise taught. The workflow itself is documented in `UPDATING.md`.

## What broke between builds

1. **`bugs.4d.com` grew a second listing with a different HTML layout.**
   `?version=<v>` still serves released products, but versions still in beta
   are now only reachable via `?branch=<v>`, which renders a completely
   different table (`<td class="title">` rows carrying build number and date,
   rather than `<th class="title 4D">`). `?version=21_r4` returns the site's
   standard error page. Both endpoints answer **HTTP 200 regardless**, so
   existence has to be detected from the body: an error `<div>` for the
   released layout, a missing `<h1>` for the beta one.
   **Lesson: the crawler must probe both listings for every candidate, and
   the parser must handle both layouts. Which listing served a version is
   worth persisting — `data/version_sources.json` does that, and it is what
   lets the client link beta-only versions to the URL that actually works.**

2. **Documentation links rot silently.** developer.4d.com moved the whole
   4D Write Pro and View Pro command families out of `/docs/commands/` into
   `/docs/WritePro/commands/` and `/docs/ViewPro/commands/`. 199 entries in
   `data/command_index.json` and 81 published summaries were pointing at
   404s, and nothing noticed, because links are only ever written, never
   re-read. `scripts/update/check_links.py` now re-verifies the whole corpus
   (results cached in `update_state.json`, so a routine run is cheap).
   **Lesson: any dataset that embeds third-party URLs needs a link check as
   a pipeline stage, not as a one-off. And when a family moves, fix the
   index as well as the prose — otherwise the next enrichment pass
   reintroduces the dead URL.**

3. **Miniforge Python's CA trust store was unusable** (`SSLCertVerificationError`
   on every HTTPS request). Rather than fight it, all fetching goes through
   system `curl` via `subprocess`.
   **Lesson: the original notes already concluded "use curl"; this time it
   was forced rather than chosen.**

## What made the delta tracking work

- **Crawl and parse are always complete and idempotent.** They are cheap.
  Only the expensive, non-deterministic step — writing English prose — is
  gated on a delta. That split is the whole design.
- **The enrichment fingerprint hashes the raw summary plus the *sorted set*
  of Japanese notes, and deliberately excludes `versions`.** A new hotfix
  adds a version without changing a word of the prose, so including
  `versions` would have forced needless rewrites. Sorting matters too: the
  first attempt flagged 166 bugs, of which a third differed only in the
  *order* the JP notes happened to be extracted in. Order-insensitivity took
  it to 110 genuinely-changed bugs.
- **A `--max-pending` guard (default 400) refuses to proceed** if the delta
  suddenly looks enormous. An upstream layout change should fail loudly, not
  silently trigger a 2,400-bug rewrite.
- **Embedding reuse keys on byte-identical summary text**, so the final build
  re-embedded 46 rows instead of 2,458 — seconds instead of many minutes.

## Japanese note extraction: two real bugs found

- Bullets are occasionally written `*ACI0106136` with **no space** after the
  asterisk, or `*  ACI0098713` with two. A regex requiring exactly one space
  silently drops them. Across both repos this is 7 lines covering 3 distinct
  references — small, but the affected notes vanish without a trace. These
  are malformed in the source too (with no space, CommonMark does not see a
  list item at all), so they are worth fixing upstream; `UPDATING.md` lists
  the exact files and line numbers.
- The original extractor let a `---` horizontal rule fall through, bleeding
  the following bullet's text into the previous note. This was the larger of
  the two effects by far, and unlike the bullet spacing it is purely an
  extractor bug — a `---` in the body is perfectly valid markdown.
  **Lesson: when rewriting an extractor, diff the output against the old one
  item by item and account for every single difference. Both of these showed
  up only as "this run has fewer/longer items than last time" — and beware
  attributing a large discrepancy to the first cause you find, which is
  exactly the mistake made here before the two were measured separately.**

Separately, 5 bullets carry a **6-digit** ACI id where every other reference
is 7 digits, so any `ACI\d{7}` matcher skips them. None of the five could be
resolved against the bugs.4d.com dataset by prefix or by symptom, so the
correct ids are unknown and need the upstream author. They are listed in
`UPDATING.md` too.

## Command matching

`scripts/update/match_commands.py` reproduces the original candidate matcher
at 94.7% exact agreement (precision 0.992, recall 0.883) against the 2,420
hand-reviewed bugs. The residual disagreements are almost entirely the
*original's* over-matches on ambiguous single-word names (`File`, `Form`,
`Formula`, `QUERY`, `Table`); the new matcher only accepts those inside a
code span. The one non-obvious requirement: **Japanese prose has no spaces**,
so non-Latin runs must be blanked out before tokenizing, or command names get
"found" inside unrelated Japanese text.

Note that matching only produces *candidates* — the enrichment step still
judges each one, and routinely drops matches like `WEB Server` (the bug is
about the web server, not the command) or `True`/`False` (values, not
commands).
