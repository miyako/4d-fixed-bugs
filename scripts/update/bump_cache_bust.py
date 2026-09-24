#!/usr/bin/env python3
"""
Step 6 — bump the cache-busting query string on docs/index.html asset URLs.

GitHub Pages serves static assets with `Cache-Control: max-age=600` and offers
no way to set custom response headers, so without this a browser tab opened
just before a deploy can keep running stale JS/CSS for up to ten minutes. Every
deploy that changes JS or CSS bumps `?v=N` by one.
"""
from __future__ import annotations

import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import BASE  # noqa: E402

INDEX_PATH = os.path.join(BASE, "docs", "index.html")
ASSET_RE = re.compile(r'((?:href|src)="[^"]+?\?v=)(\d+)(")')


def main() -> int:
    with open(INDEX_PATH, "r", encoding="utf-8") as f:
        content = f.read()

    versions = [int(m.group(2)) for m in ASSET_RE.finditer(content)]
    if not versions:
        print(f"No ?v=N asset URLs found in {INDEX_PATH} — nothing to bump.")
        return 0

    next_version = max(versions) + 1
    updated = ASSET_RE.sub(lambda m: f"{m.group(1)}{next_version}{m.group(3)}", content)
    with open(INDEX_PATH, "w", encoding="utf-8") as f:
        f.write(updated)

    print(f"Bumped {len(versions)} asset URL(s) to ?v={next_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
