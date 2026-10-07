#!/usr/bin/env python3
"""
Japanese stage 2 — merge written translations into data/all_bugs_ja.json.

Reads a batch file of `{reference, summary}` objects written for bugs listed
in data/pending_translation.json, validates every one (see
ja_common.validate_translation), then stores them together with the source
fingerprint they were written from.

Usage:  python3 scripts/update/merge_translation.py data/translation/chunk_1.out.json --partial
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    ENRICHED_PATH,
    JA_PATH,
    PENDING_TRANSLATION_PATH,
    load_json,
    write_json,
)
from ja_common import validate_translation  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batches", nargs="+", help="JSON file(s) of [{reference, summary}]")
    parser.add_argument("--partial", action="store_true", help="allow pending bugs to remain")
    parser.add_argument("--strict", action="store_true", help="treat warnings as errors")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    batch = []
    for path in args.batches:
        items = load_json(path)
        if not isinstance(items, list) or not items:
            print(f"ERROR: {path} is not a non-empty JSON array")
            return 1
        batch.extend(items)

    pending = load_json(PENDING_TRANSLATION_PATH, []) or []
    pending_by_ref = {p["reference"]: p for p in pending}
    en_by_ref = {b["reference"]: b for b in load_json(ENRICHED_PATH, []) or []}

    errors, warnings, seen = [], [], set()
    for i, item in enumerate(batch):
        ref = item.get("reference") if isinstance(item, dict) else None
        if not ref:
            errors.append(f"item {i}: missing reference")
            continue
        if ref in seen:
            errors.append(f"{ref}: duplicate reference in batch")
            continue
        seen.add(ref)
        if ref not in pending_by_ref:
            errors.append(f"{ref}: not in pending_translation.json")
            continue
        e, w = validate_translation(item.get("summary"), en_by_ref[ref])
        errors += [f"{ref}: {m}" for m in e]
        warnings += [f"{ref}: {m}" for m in w]

    for w in warnings:
        print(f"  warning: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if args.strict:
        errors += warnings
    if errors:
        print(f"\n{len(errors)} validation error(s) — nothing merged.")
        return 1

    missing = sorted(set(pending_by_ref) - seen)
    if missing and not args.partial:
        print(f"\nERROR: batch is missing {len(missing)} pending bug(s): {missing[:10]}")
        print("Pass --partial to merge anyway.")
        return 1

    ja = {r["reference"]: r for r in load_json(JA_PATH, []) or []}
    for item in batch:
        ref = item["reference"]
        ja[ref] = {
            "reference": ref,
            "summary": item["summary"].strip(),
            "source_fingerprint": pending_by_ref[ref]["fingerprint"],
        }
    print(f"\nMerged {len(batch)} translation(s) ({len(warnings)} warning(s)); {len(ja)} total")

    if args.dry_run:
        print("Dry run — nothing written.")
        return 0

    write_json(JA_PATH, [ja[ref] for ref in sorted(ja)])
    write_json(PENDING_TRANSLATION_PATH, [p for p in pending if p["reference"] in missing])
    print(f"Wrote {JA_PATH}; {len(missing)} still pending")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
