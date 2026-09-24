#!/usr/bin/env python3
"""
Step 5 — merge written enrichment back into the dataset.

Reads a batch file of `{reference, summary, commands}` objects produced for the
bugs listed in data/pending_enrichment.json, validates it hard, then merges it
into data/all_bugs_enriched.json and records each merged bug's source
fingerprint in data/update_state.json so the next run knows it is up to date.

Validation is intentionally strict — this is the one step where hand/LLM-written
content enters the dataset, and the deployed client renders these summaries:

  * every reference must exist in the current dataset and be pending
  * summaries must be non-empty prose
  * every markdown link must point at https://developer.4d.com/ (the client's
    renderer allowlists exactly that prefix and silently de-links anything else)
  * every name in `commands` must exist in data/command_index.json and be
    mentioned in the summary

Usage:  python3 scripts/update/merge_enrichment.py data/enrichment_output.json
"""
from __future__ import annotations

import argparse
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    COMMAND_INDEX_PATH,
    ENRICHED_PATH,
    PENDING_PATH,
    load_json,
    load_state,
    save_state,
    write_json,
)

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
ALLOWED_LINK_PREFIX = "https://developer.4d.com/"


def validate(batch, pending_by_ref, command_index, allow_extra: bool):
    errors, warnings = [], []
    seen = set()
    for i, item in enumerate(batch):
        where = f"item {i}"
        if not isinstance(item, dict):
            errors.append(f"{where}: not an object")
            continue
        ref = item.get("reference")
        where = f"{ref or where}"
        if not ref:
            errors.append(f"{where}: missing reference")
            continue
        if ref in seen:
            errors.append(f"{where}: duplicate reference in batch")
            continue
        seen.add(ref)
        if ref not in pending_by_ref and not allow_extra:
            errors.append(f"{where}: not in pending_enrichment.json")
            continue

        summary = item.get("summary")
        if not isinstance(summary, str) or len(summary.strip()) < 10:
            errors.append(f"{where}: summary missing or too short")
            continue
        for _text, href in LINK_RE.findall(summary):
            if not href.startswith(ALLOWED_LINK_PREFIX):
                errors.append(f"{where}: link href not on developer.4d.com: {href}")

        commands = item.get("commands", [])
        if not isinstance(commands, list) or any(not isinstance(c, str) for c in commands):
            errors.append(f"{where}: commands must be an array of strings")
            continue
        for name in commands:
            if name.upper() not in command_index:
                warnings.append(f"{where}: command not in command_index: {name!r}")
            elif name not in summary:
                warnings.append(f"{where}: command {name!r} not mentioned in summary")

    missing = sorted(set(pending_by_ref) - seen)
    return errors, warnings, missing


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batch", help="JSON file of [{reference, summary, commands}]")
    parser.add_argument(
        "--partial",
        action="store_true",
        help="allow the batch to cover only some pending bugs",
    )
    parser.add_argument(
        "--allow-extra",
        action="store_true",
        help="allow references that are not currently pending (re-writes)",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    batch = load_json(args.batch)
    if not isinstance(batch, list) or not batch:
        print(f"ERROR: {args.batch} is not a non-empty JSON array")
        return 1

    pending = load_json(PENDING_PATH, []) or []
    pending_by_ref = {p["reference"]: p for p in pending}
    command_index = {k.upper(): v for k, v in (load_json(COMMAND_INDEX_PATH, {}) or {}).items()}
    enriched = load_json(ENRICHED_PATH, []) or []

    errors, warnings, missing = validate(batch, pending_by_ref, command_index, args.allow_extra)
    for w in warnings:
        print(f"  warning: {w}")
    for e in errors:
        print(f"  ERROR: {e}")
    if errors:
        print(f"\n{len(errors)} validation error(s) — nothing merged.")
        return 1
    if missing and not args.partial:
        print(f"\nERROR: batch is missing {len(missing)} pending bug(s): {missing[:10]}")
        print("Pass --partial to merge anyway.")
        return 1

    by_ref = {e["reference"]: e for e in enriched}
    added = updated = 0
    for item in batch:
        record = {
            "reference": item["reference"],
            "summary": item["summary"].strip(),
            "commands": item.get("commands", []),
        }
        if record["reference"] in by_ref:
            updated += 1
        else:
            added += 1
        by_ref[record["reference"]] = record

    merged = [by_ref[ref] for ref in sorted(by_ref)]
    print(f"\nMerged {added} new + {updated} updated = {len(batch)} bugs")
    print(f"Dataset now has {len(merged)} enriched bugs ({len(warnings)} warning(s))")
    if missing:
        print(f"Still pending after this merge: {len(missing)}")

    if args.dry_run:
        print("Dry run — nothing written.")
        return 0

    write_json(ENRICHED_PATH, merged)
    state = load_state()
    fingerprints = state.setdefault("enrichment_fingerprints", {})
    for item in batch:
        ref = item["reference"]
        fp = pending_by_ref.get(ref, {}).get("fingerprint")
        if fp:
            fingerprints[ref] = fp
    state["counts"]["enriched"] = len(merged)
    save_state(state)

    remaining = [p for p in pending if p["reference"] in missing]
    write_json(PENDING_PATH, remaining)
    print(f"Wrote {ENRICHED_PATH}")
    print(f"Rewrote {PENDING_PATH} ({len(remaining)} still pending)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
