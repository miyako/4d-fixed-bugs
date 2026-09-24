#!/usr/bin/env python3
"""Verify every documentation link in the enriched dataset still resolves.

developer.4d.com reorganizes its documentation from time to time — the
4D Write Pro and View Pro command pages, for instance, moved out of
/docs/commands/ into /docs/WritePro/commands/ and /docs/ViewPro/commands/.
Nothing in the pipeline notices that on its own, because a link only rots
after it has been written, so this stage re-checks the published corpus.

Results are cached in update_state.json, so a routine run only pays for
links it has never seen before.  --recheck-all ignores the cache, which is
what you want occasionally (say, before a release) to catch pages that have
disappeared since they were last verified.

    python3 scripts/update/check_links.py
    python3 scripts/update/check_links.py --recheck-all
"""

import argparse
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor

from common import ENRICHED_PATH, USER_AGENT, load_json, load_state, save_state

LINK_RE = re.compile(r"\]\((https?://[^)\s]+)\)")


def collect_links(bugs):
    """Map each URL to the bug references that cite it."""
    links = {}
    for bug in bugs:
        for url in LINK_RE.findall(bug.get("summary", "")):
            links.setdefault(url, []).append(bug["reference"])
    return links


def check(url):
    """Return the final HTTP status for url, following redirects."""
    for attempt in range(3):
        try:
            done = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 "-L", "--max-time", "25", "-A", USER_AGENT, url],
                capture_output=True, text=True, timeout=40,
            )
            code = done.stdout.strip()
            if code.isdigit() and code != "000":
                return int(code)
        except subprocess.TimeoutExpired:
            pass
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--recheck-all", action="store_true",
                    help="ignore cached results and re-verify every link")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    bugs = load_json(ENRICHED_PATH, [])
    if not bugs:
        sys.exit(f"No enriched bugs found at {ENRICHED_PATH}")

    links = collect_links(bugs)
    state = load_state()
    cache = {} if args.recheck_all else state.get("link_checks", {})

    todo = sorted(url for url in links if cache.get(url) != 200)
    print(f"{len(links)} distinct links; {len(todo)} to verify "
          f"({len(links) - len(todo)} cached OK).")

    results = dict(cache)
    if todo:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            for url, code in zip(todo, pool.map(check, todo)):
                results[url] = code

    # Forget cached URLs that no longer appear anywhere in the dataset.
    state["link_checks"] = {u: c for u, c in results.items() if u in links}
    save_state(state)

    broken = sorted((u, results[u]) for u in links if results[u] != 200)
    if not broken:
        print(f"All {len(links)} links OK.")
        return 0

    print(f"\n{len(broken)} broken link(s):", file=sys.stderr)
    for url, code in broken:
        refs = links[url]
        shown = ", ".join(refs[:5]) + (f" (+{len(refs) - 5} more)"
                                       if len(refs) > 5 else "")
        print(f"  {code}  {url}\n        cited by {shown}", file=sys.stderr)
    print("\nFix the URLs in data/all_bugs_enriched.json (and in "
          "data/command_index.json if a whole command family moved), then "
          "re-run generate_embeddings.mjs to re-embed the edited summaries.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
