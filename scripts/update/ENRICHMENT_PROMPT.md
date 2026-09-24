# Enrichment prompt (one chunk of `data/pending_enrichment.json`)

This is the only step in the update pipeline that needs judgement. Everything
else is deterministic. Give a worker exactly this file plus one chunk file.

---

You are writing English bug-fix summaries for a searchable database of fixed
4D bugs (4D is a database/IDE product). Your input is a JSON array of bug
records; your output is a JSON array of the same length, in the same order,
with the same `reference` values.

## Input record

```json
{
  "reference": "ACI0106528",
  "raw_summary": "Display format is applied during edit mode of date or time input",
  "versions": ["21_r4"],
  "jp_notes": ["日本語の詳しい説明…", "…"],
  "matched_commands": [{"title": "ALERT", "url": "https://developer.4d.com/docs/commands/alert"}],
  "reason": "new",
  "previous_summary": "…existing summary, when this is a rewrite…"
}
```

- `raw_summary` — the terse, often ungrammatical text from bugs.4d.com.
- `jp_notes` — Japanese descriptions of the *same* bug from 4D's Japanese
  release notes. These are usually far more detailed and precise than the
  English text and are your best source of real technical detail.
- `matched_commands` — **candidates only**, produced by mechanical text
  matching. They are not ground truth.
- `previous_summary` — present when the bug already had a summary and its
  source text changed. Treat it as a starting point, keep what is still
  accurate, and fold in the new information.

## Output record

```json
{
  "reference": "ACI0106528",
  "summary": "Markdown prose, see rules below",
  "commands": ["ALERT", "Print form"]
}
```

Output **only** the JSON array — no prose, no code fences, no commentary.

## Rules for `summary`

1. Write real English prose explaining what went wrong, in 1–4 sentences.
   Do not paraphrase the terse original word-for-word, and do not pad it into
   a template. Use the Japanese notes for the technical specifics: platform
   restrictions ("On macOS only"), client/server-only behaviour, the exact
   trigger, the workaround, what the correct behaviour should be.
2. Describe the bug in the past tense (it is fixed), e.g. "…could crash the
   application", "…returned 0 instead of -1".
3. Only this markdown subset is allowed, because the site's renderer supports
   nothing else: `[text](url)` links, `` `code` `` inline spans, and `*italic*`.
   No bold, no headings, no lists, no tables, no fenced code blocks.
4. Every link must point at `https://developer.4d.com/…`. Any other href is
   rejected by the merge step, and the client silently de-links it.
5. Never invent an ACI reference, a version number, or a command name.
6. Do not mention Japanese, the release notes, or the source of your
   information. Write as if describing the bug first-hand.
7. Do not start every summary the same way. Vary the sentence structure.

## Rules for `commands`

1. Go through `matched_commands` and **judge each one**. Include a command only
   if the bug genuinely involves it. The matcher over-matches on names that are
   also ordinary English words (`File`, `Form`, `Date`, `QUERY`, `Table`), and
   it under-matches plain Title Case names in running prose.
2. You may add a command the matcher missed, but only if you are confident of
   its exact documented name and URL (`https://developer.4d.com/docs/commands/<kebab-case-name>`).
3. Every name in `commands` must appear verbatim in `summary`, linked with
   markdown on its first mention:
   `[Print form](https://developer.4d.com/docs/commands/print-form)`.
4. Use the command's exact documented casing — `GOTO OBJECT`, `Print form`,
   `SELECTION TO ARRAY`. Do not normalize the casing.
5. An empty `commands` array is correct and common — roughly two thirds of
   bugs mention no command at all. Do not reach for a link that isn't there.

## Style reference

See `data/pilot_report.md` for 40 hand-written, human-reviewed examples that
set the quality bar.

## Self-check before returning

- [ ] Same number of records as the input, same order, same `reference` values.
- [ ] Valid JSON array, nothing else in the response.
- [ ] Every href starts with `https://developer.4d.com/`.
- [ ] Every entry in `commands` appears verbatim in `summary`.
- [ ] No bold, headings, lists, tables or fenced code blocks in any summary.
