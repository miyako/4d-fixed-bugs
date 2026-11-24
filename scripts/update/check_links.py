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

developer.4d.com is served by GitHub Pages, which answers 503 under load, so
a status that says "the server is busy" is retried and then treated as
*unverified* rather than broken: it is not cached, it does not fail the run,
and it is checked again next time. Only a definitive answer (404/410/…) is
reported as a broken link.

    python3 scripts/update/check_links.py
    python3 scripts/update/check_links.py --recheck-all
"""

import argparse
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

from common import ENRICHED_PATH, JA_PATH, FR_PATH, USER_AGENT, load_json, load_state, save_state

LINK_RE = re.compile(r"\]\((https?://[^)\s]+)\)")

# "The server is busy, ask again" — never evidence that a link rotted.
RETRYABLE_HTTP = {429, 500, 502, 503, 504}
RETRY_DELAYS = (2, 5, 10, 20)


def collect_links(bugs):
    """Map each URL to the bug references that cite it."""
    links = {}
    for bug in bugs:
        for url in LINK_RE.findall(bug.get("summary", "")):
            links.setdefault(url, []).append(bug["reference"])
    return links


def check(url):
    """Return the final HTTP status for url, following redirects.

    0 means no status was ever read (timeout, DNS/TLS failure), which is
    likewise not evidence about the link."""
    code = 0
    for attempt in range(len(RETRY_DELAYS) + 1):
        if attempt:
            time.sleep(RETRY_DELAYS[min(attempt - 1, len(RETRY_DELAYS) - 1)])
        try:
            done = subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                 "-L", "--max-time", "25", "-A", USER_AGENT, url],
                capture_output=True, text=True, timeout=40,
            )
        except subprocess.TimeoutExpired:
            continue
        raw = done.stdout.strip()
        if not (raw.isdigit() and raw != "000"):
            continue
        code = int(raw)
        if code not in RETRYABLE_HTTP:
            return code
    return code


def classify_results(links, results):
    """Split the check results into (broken, unverified) and what to cache.

    Broken: the server gave a definitive answer that is not 200.
    Unverified: it was busy or never answered, so the link is still unknown —
    leave it out of the cache so the next run asks again.
    """
    broken = sorted(
        (url, results[url]) for url in links
        if results[url] != 200 and results[url] not in RETRYABLE_HTTP and results[url] != 0
    )
    unverified = sorted(
        url for url in links
        if results[url] == 0 or results[url] in RETRYABLE_HTTP
    )
    cache = {u: c for u, c in results.items() if u in links and u not in set(unverified)}
    return broken, unverified, cache


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--recheck-all", action="store_true",
                    help="ignore cached results and re-verify every link")
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()

    bugs = load_json(ENRICHED_PATH, [])
    if not bugs:
        sys.exit(f"No enriched bugs found at {ENRICHED_PATH}")

    # Japanese localizes /docs/ja/; French preserves the canonical English URLs.
    links = collect_links(bugs + (load_json(JA_PATH, []) or []) + (load_json(FR_PATH, []) or []))
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

    broken, unverified, state["link_checks"] = classify_results(links, results)
    save_state(state)

    if unverified:
        print(
            f"\n{len(unverified)} link(s) could not be verified this run "
            f"(server busy or no response); they are checked again next run and "
            f"are NOT reported as broken:",
            file=sys.stderr,
        )
        for url in unverified[:10]:
            print(f"  {results[url]}  {url}", file=sys.stderr)
        if len(unverified) > 10:
            print(f"  … and {len(unverified) - 10} more", file=sys.stderr)

    if not broken:
        print(f"All {len(links) - len(unverified)} verified links OK.")
        return 0

    print(f"\n{len(broken)} broken link(s):", file=sys.stderr)
    for url, code in broken:
        refs = links[url]
        shown = ", ".join(refs[:5]) + (f" (+{len(refs) - 5} more)"
                                       if len(refs) > 5 else "")
        print(f"  {code}  {url}\n        cited by {shown}", file=sys.stderr)
    print("\nFix the URLs in data/all_bugs_enriched.json / data/all_bugs_ja.json / data/all_bugs_fr.json (and in "
          "data/command_index.json if a whole command family moved), then "
          "re-run generate_embeddings.mjs to re-embed the edited summaries.",
          file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
