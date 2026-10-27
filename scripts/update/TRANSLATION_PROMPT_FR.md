# French bug summaries

Translate each `summary_en` in the input chunk into natural, complete French.
Use **only canonical English** and its `commands`; do not consult Japanese
summaries or release notes. Keep the meaning, conditions, versions, numbers,
cause and observed failure intact. Do not invent explanations.

Return a JSON array of `{"reference": "ACI0000000", "summary": "…"}` objects,
one for every input reference. Write it alongside the input as `chunk_N.out.json`.
Use one paragraph per summary, without headings, lists, bold, tables or fences.

Preserve exactly:

- Every Markdown link's text and URL, including English command names.
  Keep `https://developer.4d.com/docs/...` unchanged; never replace it with
  `/docs/fr/` or `/docs/ja/`.
- All inline code spans, command/API identifiers, entities and ACI references.
- All numeric details from the English prose.

Translate prose, not commands or code. Accents are natural French spelling,
not a validation requirement: legitimate French without accents is acceptable.
Unchanged English is not a translation.

Merge with:

```sh
python3 scripts/update/merge_translation.py --lang fr data/translation_fr/chunk_N.out.json --partial --strict
```

Inspect errors and warnings; do not weaken validation to accept a bad translation.
Rebuild with `./scripts/update.sh --build-only` once both language queues are empty.
