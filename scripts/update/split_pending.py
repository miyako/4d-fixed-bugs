#!/usr/bin/env python3
"""
Split data/pending_enrichment.json into per-agent chunk files.

Rewriting terse bug text into real English prose does not scale as one
single-pass task, so the pending set is split into self-contained chunks that
can be handed to parallel workers (agents or people). Each chunk file is a
complete input: nothing else needs to be read to write its summaries.

Usage:  python3 scripts/update/split_pending.py --chunks 4 --out-dir data/enrichment
        (then write data/enrichment/chunk_N.out.json for each chunk and merge)
"""
from __future__ import annotations

import argparse
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import DATA_DIR, PENDING_PATH, load_json, write_json  # noqa: E402

DEFAULT_OUT_DIR = os.path.join(DATA_DIR, "enrichment")
PROMPT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ENRICHMENT_PROMPT.md")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chunks", type=int, default=4)
    parser.add_argument("--max-per-chunk", type=int, default=40)
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    args = parser.parse_args()

    pending = load_json(PENDING_PATH, []) or []
    if not pending:
        print("Nothing pending — no chunks written.")
        return 0

    chunks = max(args.chunks, math.ceil(len(pending) / args.max_per_chunk))
    size = math.ceil(len(pending) / chunks)
    os.makedirs(args.out_dir, exist_ok=True)

    written = []
    for i in range(chunks):
        part = pending[i * size : (i + 1) * size]
        if not part:
            continue
        path = os.path.join(args.out_dir, f"chunk_{i + 1}.json")
        write_json(path, part)
        written.append((path, len(part)))

    print(f"{len(pending)} pending bug(s) -> {len(written)} chunk(s):")
    for path, count in written:
        print(f"  {os.path.relpath(path)}  ({count} bugs)")
    print(f"\nInstructions for each chunk: {os.path.relpath(PROMPT_PATH)}")
    print("Write chunk_N.out.json alongside each input, then:")
    print(f"  python3 scripts/update/merge_enrichment.py {os.path.relpath(args.out_dir)}/chunk_N.out.json --partial")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
