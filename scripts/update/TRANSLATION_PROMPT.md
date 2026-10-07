# Translation prompt (one chunk of `data/pending_translation.json`)

Give a worker exactly this file plus one chunk file. The output feeds the
Japanese version of the site (`docs/ja/`).

---

You are writing Japanese bug-fix summaries for a searchable database of fixed
4D bugs (4D is a database/IDE product). Your input is a JSON array of bug
records; your output is a JSON array of the same length, in the same order,
with the same `reference` values.

## Input record

```json
{
  "reference": "ACI0096479",
  "summary_en": "On Windows only, when the taskbar was docked at the top of the screen, …",
  "commands": ["Pop up menu"],
  "jp_notes": ["Windows版のみ。タスクバーを画面の上部に表示している場合，…"],
  "previous_summary_ja": null
}
```

- `summary_en` — the English summary shown on the English site. It carries
  the structure, the facts, and every documentation link.
- `jp_notes` — the **original** Japanese text 4D Japan published for this same
  bug (the English summary was partly written from it). It may be empty.
  It is the authority on Japanese wording: reuse its terminology and, where it
  says the same thing as the English, prefer its phrasing over a literal
  translation of the English.
- `previous_summary_ja` — present when this bug was translated before and its
  sources changed since. Keep what is still accurate and fold in the change.

## Output record

```json
{ "reference": "ACI0096479", "summary": "Windows 版でのみ、…" }
```

Output **only** the JSON array — no prose, no code fences, no commentary.

## Rules for `summary`

1. Cover the same facts as `summary_en` — no fewer, and nothing that is in
   neither `summary_en` nor `jp_notes`. If the notes give a precise detail the
   English summarises loosely, you may use the precise version.
2. Write natural Japanese in **polite form (です・ます調)**, one paragraph,
   1–5 sentences. Describe the bug in the past tense: 「〜していました」
   「〜することがありました」「〜が返されていました」. Every sentence ends
   in a polite form (〜ました／〜ません／〜でした／〜です) followed by 「。」.
   Avoid the terse note style 「Windows版のみ。」 as a sentence of its own —
   write 「Windows 版でのみ、…」 inside the sentence instead. Follow the English
   on platform scope: "only" / 「のみ」 → 「Windows 版でのみ」; a plain
   "On Windows" → 「Windows 版で」.
3. Keep **every** markdown link from `summary_en`, with the **link text
   unchanged** (4D command names stay in English, e.g. `[Print form](…)`),
   and the URL moved under `/docs/ja/`:
   `https://developer.4d.com/docs/commands/print-form` →
   `https://developer.4d.com/docs/ja/commands/print-form`
   (likewise `/docs/WritePro/…` → `/docs/ja/WritePro/…`). Add no new links.
4. Keep every `` `code` `` span from `summary_en` verbatim. `*italic*` may be
   kept or dropped. No bold, headings, lists, tables or code fences.
5. Every name in `commands` that appears verbatim in `summary_en` must also
   appear verbatim in the summary (it does if rule 3 is followed). If the
   English words a listed command differently, do not add a mention for it.
6. Keep 4D product and feature names in their usual form: 4D, 4D Server,
   4D Remote, 4D Write Pro, 4D View Pro, ORDA, Qodly, 4D NetKit, etc. For
   UI and concept terms, use 4D's Japanese terminology as it appears in
   `jp_notes` (e.g. ストラクチャー, フォームエディター, リストボックス,
   プロパティリスト, デザインモード, メソッドエディター, クライアント/サーバー).
   Write katakana terms with the trailing long-vowel mark, as current 4D
   documentation does (ストラクチャー, パラメーター, エディター, ブラウザー,
   サーバー), even where older notes omit it.
   If the notes name a command differently from the English link (e.g. an
   older command name), keep the English link as is.
7. Never invent an ACI reference, a version number, or a command name. Keep
   every number that matters (error codes, sizes, counts, versions).
8. Typography: full-width 「、」「。」「（）」 in Japanese text, half-width
   letters and digits. Put a half-width space between Japanese text and a
   standalone Latin word (「Windows 版」「4D Server で」). Numbers attached to
   Japanese counters need no space (「3つ」「第3引数」「エラー#106」 are fine
   either way). No space is needed around links or code spans. Identifiers
   the English leaves as plain text (OK, Designer) stay plain text.
9. Do not mention the English text, the release notes, translation, or where
   the information came from. If the English summary itself says a record is
   a placeholder with no technical detail available, say so plainly
   (「技術的な詳細は公開されていません。」).
10. Content in the notes that cannot be expressed under these rules (images,
   bullet lists, code blocks, links to other sites) is left out.

## Checking your work

From the repository root:

```
python3 scripts/update/merge_translation.py data/translation/chunk_N.out.json --partial --dry-run
```

It must report no `ERROR`. Warnings (a non-polite sentence ending, a number
missing, a long run of untranslated English) should be fixed unless they are
genuinely fine.

## Self-check before returning

- [ ] Same number of records as the input, same order, same `reference` values.
- [ ] Valid JSON array, nothing else in the file.
- [ ] Every link from `summary_en` is present with the same text and a `/docs/ja/` URL.
- [ ] Every sentence is polite form and ends with 「。」.
