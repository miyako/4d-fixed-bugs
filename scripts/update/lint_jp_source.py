#!/usr/bin/env python3
"""Lint the Japanese source repos for malformed ACI bullets.

`sync_jp.py` is deliberately tolerant — it would rather extract a note from a
slightly malformed bullet than lose it. That tolerance hides real defects in
the upstream markdown, so this script reports them separately.

Three classes are checked:

1. Bad spacing after the bullet marker. With no space at all, CommonMark does
   not produce a list item, so these are wrong on the published site too.
2. The reference running straight into the note text with no separator
   (``* ACI0103196Mac版のみ``). Readable enough, but it relies on the reader
   knowing a reference is exactly 7 digits, and it reads as one long token.
3. Truncated references — fewer than 7 digits. These are skipped silently by
   any matcher keyed on that shape, and the correct id cannot be recovered.

Exits non-zero if anything is found, so it can gate a run if you want it to.

    python3 scripts/update/lint_jp_source.py
    python3 scripts/update/lint_jp_source.py --links   # print GitHub URLs
"""

import argparse
import glob
import os
import re
import subprocess
import sys

from common import BASE, VENDOR_DIR

REPO_SLUGS = {
    "4D-jp.github.io": "4D-JP/4D-jp.github.io",
    "release-notes": "4D-JP/release-notes",
}

STRICT = re.compile(r"^\* (ACI\d{7})(?:[\s\u3000]|$)")
LOOSE = re.compile(r"^(?P<marker>[*\-+])(?P<gap>[\s\u3000]*)ACI(?P<digits>\d+)")


def head_sha(repo_dir):
    try:
        out = subprocess.run(["git", "-C", repo_dir, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=15)
        return out.stdout.strip() or "?"
    except Exception:
        return "?"


def github_url(path, lineno):
    rel = os.path.relpath(path, VENDOR_DIR)
    repo, _, inner = rel.partition(os.sep)
    slug = REPO_SLUGS.get(repo)
    if not slug:
        return f"{rel}:{lineno}"
    return f"https://github.com/{slug}/blob/master/{inner}#L{lineno}"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--links", action="store_true",
                    help="print GitHub blob URLs instead of local paths")
    args = ap.parse_args()

    if not os.path.isdir(VENDOR_DIR):
        sys.exit("vendor/ not found — run scripts/update/sync_jp.py first.")

    spacing, runon, truncated = [], [], []
    for path in sorted(glob.glob(os.path.join(VENDOR_DIR, "**", "*.md"),
                                 recursive=True)):
        with open(path, encoding="utf-8", errors="replace") as fh:
            for lineno, line in enumerate(fh, 1):
                line = line.rstrip("\n")
                m = LOOSE.match(line)
                if not m or STRICT.match(line):
                    continue
                run = m.group("digits")
                # A digit run longer than 7 is a valid reference whose text
                # happens to start with a number (ACI009838832 = ACI0098388
                # followed by "32-bit"), not a malformed id.
                ref = "ACI" + run[:7]
                entry = (path, lineno, ref, line.strip()[:70])
                if len(run) < 7:
                    truncated.append((path, lineno, "ACI" + run, line.strip()[:70]))
                elif m.group("gap") != " ":
                    spacing.append(entry)
                else:
                    runon.append(entry)

    for repo in sorted(REPO_SLUGS):
        d = os.path.join(VENDOR_DIR, repo)
        if os.path.isdir(d):
            print(f"{repo} @ {head_sha(d)}")

    def report(title, rows):
        print(f"\n{title}: {len(rows)}")
        for path, lineno, ref, text in rows:
            loc = github_url(path, lineno) if args.links else \
                f"{os.path.relpath(path, BASE)}:{lineno}"
            print(f"  {ref}  {loc}")
            print(f"      {text}")

    report("Bad spacing after the '*' bullet marker", spacing)
    report("Reference not separated from the note text", runon)
    report("Truncated reference (fewer than 7 digits)", truncated)

    total = len(spacing) + len(runon) + len(truncated)
    if total == 0:
        print("\nNo malformed ACI bullets found.")
        return 0
    print(f"\n{total} malformed bullet(s). These are tolerated by sync_jp.py, "
          "so the dataset is unaffected — but they are defects in the upstream "
          "markdown and should be reported there. See UPDATING.md.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
