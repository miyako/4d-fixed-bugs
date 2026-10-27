#!/usr/bin/env python3
"""
Translation stage 1 — work out which bugs need a (re-)translation.

Use --lang fr for French, sourced only from English summaries and commands.
The default --lang ja retains the Japanese release-note context described below.

Every bug in data/all_bugs_enriched.json gets a Japanese summary in
data/all_bugs_ja.json, written from its English summary plus the official
Japanese release-note text (`jp_notes` from data/all_bugs_context.json). Each
Japanese record stores the fingerprint of the sources it was written from, so
a bug is queued again only when its English summary or its JP notes change.

Output: data/pending_translation.json
        [{reference, summary_en, commands, jp_notes, fingerprint, reason,
          previous_summary_ja}]

Japanese records whose bug has disappeared from the English dataset are
dropped from data/all_bugs_ja.json here.
"""
from __future__ import annotations

import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    CONTEXT_PATH,
    ENRICHED_PATH,
    load_json,
    write_json,
)
from translation_common import config  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lang", choices=("ja", "fr"), default="ja")
    parser.add_argument(
        "--max-pending",
        type=int,
        default=400,
        help="abort if more than this many already-translated bugs need re-translation",
    )
    parser.add_argument("--force-all", action="store_true", help="re-translate every bug")
    args = parser.parse_args()
    translated_path, pending_path, language = config(args.lang)

    enriched = load_json(ENRICHED_PATH, []) or []
    notes_by_ref = (
        {c["reference"]: c.get("jp_notes", []) for c in load_json(CONTEXT_PATH, []) or []}
        if args.lang == "ja" else {}
    )
    translated = {r["reference"]: r for r in load_json(translated_path, []) or []}

    pending = []
    for bug in enriched:
        ref = bug["reference"]
        notes = notes_by_ref.get(ref, [])
        fp = language.fingerprint(bug["summary"], notes if args.lang == "ja" else bug.get("commands", []))
        existing = translated.get(ref)
        if args.force_all or not existing or existing.get("source_fingerprint") != fp:
            pending.append(
                {
                    "reference": ref,
                    "summary_en": bug["summary"],
                    "commands": bug.get("commands", []),
                    **({"jp_notes": notes} if args.lang == "ja" else {}),
                    "fingerprint": fp,
                    "reason": "new" if not existing else "source-changed",
                    f"previous_summary_{args.lang}": existing.get("summary") if existing else None,
                }
            )

    known = {b["reference"] for b in enriched}
    stale = sorted(set(translated) - known)

    reasons = collections.Counter(p["reason"] for p in pending)
    print(f"Bugs in dataset:        {len(enriched)}")
    print(f"Already translated:     {len(translated)}")
    print(f"Needing translation:    {len(pending)}  {dict(reasons)}")
    if stale:
        print(f"Dropping {len(stale)} translation(s) for bugs no longer in the dataset")

    if reasons.get("source-changed", 0) > args.max_pending and not args.force_all:
        print(
            f"ERROR: {reasons['source-changed']} existing translations flagged as stale, over "
            f"--max-pending {args.max_pending}. Inspect first, then re-run with a higher limit."
        )
        return 1

    if stale:
        write_json(translated_path, [r for ref, r in sorted(translated.items()) if ref in known])
    write_json(pending_path, pending)
    print(f"Wrote {pending_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
