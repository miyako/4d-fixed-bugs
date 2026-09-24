#!/usr/bin/env python3
"""
Step 4 — build the enrichment context and work out what is actually new.

For every bug this assembles the bundle the enrichment step reads:
raw English summary + every version it shipped in + the Japanese notes +
mechanically-matched candidate command links.

The incremental part lives here. Each bug gets a *source fingerprint* over the
inputs that affect its English prose (raw summary + JP notes — deliberately
**not** `versions`, since a bug appearing in one more hotfix does not change
what its summary should say). A bug needs (re-)enrichment only when:

  * it has no entry in data/all_bugs_enriched.json, or
  * its fingerprint differs from the one recorded when it was last enriched.

Version-only changes therefore cost nothing downstream.

Output: data/all_bugs_context.json      full context for every bug
        data/pending_enrichment.json    only the bugs needing prose written
"""
from __future__ import annotations

import argparse
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    BUGS_RAW_PATH,
    COMMAND_INDEX_PATH,
    CONTEXT_PATH,
    ENRICHED_PATH,
    JP_NOTES_PATH,
    PENDING_PATH,
    load_json,
    load_state,
    save_state,
    sha256_text,
    version_sort_key,
    write_json,
)
from match_commands import build_lookup, match_commands  # noqa: E402


def fingerprint(raw_summary: str, jp_notes: list) -> str:
    """Order-insensitive over the JP notes: re-sorting the notes is not a
    content change and must not trigger a re-enrichment."""
    body = "\n\u0000\n".join(sorted(set(jp_notes)))
    return sha256_text(raw_summary + "\n\u0000\n" + body)


def group_jp_notes(jp_notes: list) -> dict:
    grouped = collections.defaultdict(list)
    for note in jp_notes:
        grouped[note["reference"]].append(note)
    for ref, notes in grouped.items():
        notes.sort(
            key=lambda n: (
                version_sort_key(n.get("version_norm", "")),
                n.get("source", ""),
                n.get("path", ""),
            )
        )
        seen, deduped = set(), []
        for note in notes:
            if note["text"] in seen:
                continue
            seen.add(note["text"])
            deduped.append(note["text"])
        grouped[ref] = deduped
    return grouped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--max-pending",
        type=int,
        default=400,
        help="abort if more bugs than this need enrichment (guards against a "
        "source-format change silently invalidating the whole dataset)",
    )
    parser.add_argument("--force-all", action="store_true", help="re-enrich every bug")
    args = parser.parse_args()

    bugs_raw = load_json(BUGS_RAW_PATH)
    if not bugs_raw:
        print("ERROR: data/bugs_raw.json missing or empty — run parse.py first")
        return 1
    command_index = load_json(COMMAND_INDEX_PATH, {})
    lookup = build_lookup(command_index)
    jp_by_ref = group_jp_notes(load_json(JP_NOTES_PATH, []))

    previous_context = {c["reference"]: c for c in load_json(CONTEXT_PATH, []) or []}
    enriched = {e["reference"]: e for e in load_json(ENRICHED_PATH, []) or []}

    state = load_state()
    fingerprints = state.setdefault("enrichment_fingerprints", {})

    # Bootstrap: the pre-existing context file *is* the record of what the
    # enrichment actually read, so derive baselines from it rather than
    # flagging every already-written summary as stale.
    if not fingerprints:
        for ref, ctx in previous_context.items():
            if ref in enriched:
                fingerprints[ref] = fingerprint(ctx.get("raw_summary", ""), ctx.get("jp_notes", []))
        print(f"Bootstrapped {len(fingerprints)} enrichment fingerprints from existing context.")

    context, pending = [], []
    for bug in bugs_raw:
        ref = bug["reference"]
        notes = jp_by_ref.get(ref, [])
        record = {
            "reference": ref,
            "raw_summary": bug["raw_summary"],
            "versions": bug["versions"],
            "jp_notes": notes,
            "matched_commands": match_commands([bug["raw_summary"]] + notes, command_index, lookup),
        }
        context.append(record)

        fp = fingerprint(record["raw_summary"], notes)
        record["_fingerprint"] = fp
        if args.force_all or ref not in enriched or fingerprints.get(ref) != fp:
            pending.append(
                {
                    "reference": ref,
                    "raw_summary": record["raw_summary"],
                    "versions": record["versions"],
                    "jp_notes": notes,
                    "matched_commands": record["matched_commands"],
                    "reason": "new" if ref not in enriched else "source-changed",
                    "fingerprint": fp,
                    "previous_summary": enriched.get(ref, {}).get("summary"),
                }
            )

    for record in context:
        record.pop("_fingerprint", None)

    reasons = collections.Counter(p["reason"] for p in pending)
    print(f"Bugs in dataset:     {len(context)}")
    print(f"Already enriched:    {len(enriched)}")
    print(f"Needing enrichment:  {len(pending)}  {dict(reasons)}")

    if len(pending) > args.max_pending and not args.force_all:
        print(
            f"ERROR: {len(pending)} bugs flagged for enrichment, over the "
            f"--max-pending limit of {args.max_pending}. This usually means a "
            "source-format change rather than real new data. Inspect first, "
            "then re-run with a higher --max-pending if it is genuine."
        )
        return 1

    write_json(CONTEXT_PATH, context)
    write_json(PENDING_PATH, pending)
    print(f"\nWrote {CONTEXT_PATH} ({len(context)} bugs)")
    print(f"Wrote {PENDING_PATH} ({len(pending)} bugs)")

    state["counts"]["context"] = len(context)
    state["counts"]["pending_enrichment"] = len(pending)
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
