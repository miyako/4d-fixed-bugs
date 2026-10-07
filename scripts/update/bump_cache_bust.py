#!/usr/bin/env python3
"""
Step 8 — bump the cache-busting query string on every page's asset URLs
(docs/index.html and docs/ja/index.html share one version number, since they
load the same JS/CSS).

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

PAGES = [
    os.path.join(BASE, "docs", "index.html"),
    os.path.join(BASE, "docs", "ja", "index.html"),
]
ASSET_RE = re.compile(r'((?:href|src)="[^"]+?\?v=)(\d+)(")')


def main() -> int:
    contents = {}
    for path in PAGES:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                contents[path] = f.read()

    versions = [int(m.group(2)) for c in contents.values() for m in ASSET_RE.finditer(c)]
    if not versions:
        print("No ?v=N asset URLs found — nothing to bump.")
        return 0

    next_version = max(versions) + 1
    for path, content in contents.items():
        updated = ASSET_RE.sub(lambda m: f"{m.group(1)}{next_version}{m.group(3)}", content)
        with open(path, "w", encoding="utf-8") as f:
            f.write(updated)

    print(f"Bumped {len(versions)} asset URL(s) in {len(contents)} page(s) to ?v={next_version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
