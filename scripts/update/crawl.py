#!/usr/bin/env python3
"""
Step 1 — crawl bugs.4d.com.

Probes every candidate version string in the 4D version-numbering scheme
against both listings:

  ?version=<v>   released products      e.g. https://bugs.4d.com/fixedbugslist?version=21.2
  ?branch=<v>    beta / nightly builds  e.g. https://bugs.4d.com/fixedbugslist?branch=21_r4

bugs.4d.com does not rate-limit; the 403-looking responses seen historically
were caused by curl's default User-Agent, not by request frequency. A normal
browser User-Agent fixes it, so no sleeps/backoff are needed.

"Not found" is never signalled by the HTTP status code (always 200):
  - a released page that does not exist contains `<div class="standard_error">`
  - a branch page that does not exist comes back essentially empty (no <h1>)

Output:
  html/exists/<source>/<version>.html      raw HTML of valid pages
  html/notfound/<source>/<version>.html    raw HTML of "no such version" pages
  crawl_log.tsv                            source, version, status, http_code, bytes, bug_count
  data/update_state.json                   per-page content hash + bug count (drives delta work)

Modes:
  --fast   (default) probe known-good pages plus a bounded frontier past the
           newest release in each series — enough to discover new releases
           without re-probing the whole historical candidate space.
  --full   probe every candidate (~1,550 requests, a couple of minutes).
"""
from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    BASE_URL,
    CRAWL_LOG_PATH,
    EXISTS_DIR,
    NOTFOUND_DIR,
    SOURCE_BRANCH,
    SOURCE_VERSION,
    USER_AGENT,
    build_candidates,
    load_state,
    now_iso,
    page_key,
    save_state,
    sha256_text,
)

FRONTIER_LOOKAHEAD = 3
ROW_MARKER_RELEASED = re.compile(r'<th class="title 4D">')
ROW_MARKER_BETA = re.compile(r'<td class="title"[^>]*>\s*ACI\d{7}\s*</td>')
H1_RE = re.compile(r"<h1>(.*?)</h1>", re.DOTALL)


def series_of(version: str):
    """(series-key, index) used to decide how far past the newest known
    release the crawler should keep probing in --fast mode."""
    m = re.match(r"^(\d+)_r(\d+)_hf(\d+)$", version)
    if m:
        return (f"{m.group(1)}_r{m.group(2)}_hf", int(m.group(3)))
    m = re.match(r"^(\d+)\.(\d+)_hf(\d+)$", version)
    if m:
        return (f"{m.group(1)}.{m.group(2)}_hf", int(m.group(3)))
    m = re.match(r"^(\d+)_r(\d+)$", version)
    if m:
        return (f"{m.group(1)}_r", int(m.group(2)))
    m = re.match(r"^(\d+)\.(\d+)$", version)
    if m:
        return (f"{m.group(1)}.", int(m.group(2)))
    return (f"{version}_base", 0)


def parent_of(version: str):
    """The release a hotfix hangs off, or None."""
    m = re.match(r"^(.*)_hf\d+$", version)
    return m.group(1) if m else None


def classify(source: str, body: str) -> tuple[bool, int]:
    """(page_exists, bug_count) for a fetched page."""
    if source == SOURCE_VERSION:
        if 'class="standard_error"' in body:
            return False, 0
        return True, len(ROW_MARKER_RELEASED.findall(body))
    # Branch pages: a non-existent branch returns an essentially empty document.
    if not H1_RE.search(body):
        return False, 0
    return True, len(ROW_MARKER_BETA.findall(body))


def fetch(source: str, version: str, attempts: int = 3) -> tuple[int, str]:
    """Fetch one listing page.

    Uses the system `curl` rather than urllib: the bundled Python on some
    machines has no usable CA trust store (CERTIFICATE_VERIFY_FAILED against
    bugs.4d.com), and curl is what the original crawler used.
    """
    url = f"{BASE_URL}?{source}={version}"
    last_err = ""
    for attempt in range(attempts):
        proc = subprocess.run(
            [
                "curl", "-s", "--max-time", "30",
                "-H", f"User-Agent: {USER_AGENT}",
                "-w", "\n%{http_code}",
                url,
            ],
            capture_output=True,
        )
        if proc.returncode == 0:
            out = proc.stdout.decode("utf-8", "replace")
            body, _, code = out.rpartition("\n")
            try:
                return int(code.strip()), body
            except ValueError:
                last_err = f"unparsable status {code!r}"
        else:
            last_err = proc.stderr.decode("utf-8", "replace").strip()
        if attempt < attempts - 1:
            time.sleep(1 + attempt)
    raise RuntimeError(f"failed to fetch {url}: {last_err}")


def select_candidates(state: dict, full: bool) -> list[tuple[str, str]]:
    candidates = build_candidates(state.get("majors", [18, 19, 20, 21, 22]))
    if full:
        return candidates

    pages = state.get("pages", {})
    if not pages:
        return candidates

    # Newest known-good index per (source, series).
    frontier: dict[tuple, int] = {}
    found_versions: set[tuple[str, str]] = set()
    for key, info in pages.items():
        if info.get("status") != "found":
            continue
        source, version = key.split(":", 1)
        found_versions.add((source, version))
        skey, idx = series_of(version)
        fk = (source, skey)
        frontier[fk] = max(frontier.get(fk, -1), idx)

    selected = []
    for source, version in candidates:
        key = page_key(source, version)
        info = pages.get(key)
        if info is None or info.get("status") == "found":
            selected.append((source, version))
            continue
        skey, idx = series_of(version)
        if idx <= frontier.get((source, skey), -1) + FRONTIER_LOOKAHEAD:
            selected.append((source, version))
            continue
        parent = parent_of(version)
        if parent and (source, parent) in found_versions:
            selected.append((source, version))
    return selected


def crawl(full: bool, workers: int) -> dict:
    state = load_state()
    pages = state.setdefault("pages", {})
    candidates = select_candidates(state, full)
    print(f"Probing {len(candidates)} candidates ({'full' if full else 'fast'} mode)...")

    for source in (SOURCE_VERSION, SOURCE_BRANCH):
        os.makedirs(os.path.join(EXISTS_DIR, source), exist_ok=True)
        os.makedirs(os.path.join(NOTFOUND_DIR, source), exist_ok=True)

    results = []

    def one(candidate):
        source, version = candidate
        http_code, body = fetch(source, version)
        exists, bug_count = classify(source, body)
        target_dir = EXISTS_DIR if exists else NOTFOUND_DIR
        path = os.path.join(target_dir, source, f"{version}.html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        stale = os.path.join(
            NOTFOUND_DIR if exists else EXISTS_DIR, source, f"{version}.html"
        )
        if os.path.exists(stale):
            os.remove(stale)
        return {
            "source": source,
            "version": version,
            "status": "found" if exists else "not_found",
            "http_code": http_code,
            "bytes": len(body.encode("utf-8", "replace")),
            "bug_count": bug_count,
            "hash": sha256_text(body) if exists else None,
        }

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, res in enumerate(pool.map(one, candidates), 1):
            results.append(res)
            if res["status"] == "found":
                print(f"  [found]    {res['source']}={res['version']} ({res['bug_count']} bugs)")
            if i % 200 == 0:
                print(f"  ...{i}/{len(candidates)}")

    new_pages, changed_pages, gone_pages = [], [], []
    for res in results:
        key = page_key(res["source"], res["version"])
        previous = pages.get(key)
        if res["status"] == "found":
            if previous is None or previous.get("status") != "found":
                new_pages.append(key)
            elif previous.get("hash") != res["hash"]:
                changed_pages.append(key)
        elif previous is not None and previous.get("status") == "found":
            gone_pages.append(key)
        pages[key] = {
            "status": res["status"],
            "bug_count": res["bug_count"],
            "hash": res["hash"],
            "bytes": res["bytes"],
            "last_seen": now_iso(),
        }

    state["last_run"] = now_iso()
    state["counts"]["pages_found"] = sum(
        1 for p in pages.values() if p.get("status") == "found"
    )
    state["last_crawl"] = {
        "mode": "full" if full else "fast",
        "probed": len(candidates),
        "new_pages": sorted(new_pages),
        "changed_pages": sorted(changed_pages),
        "gone_pages": sorted(gone_pages),
    }
    save_state(state)
    write_log(results)

    print(f"\nFound pages: {state['counts']['pages_found']}")
    print(f"New pages:     {len(new_pages)}  {sorted(new_pages)}")
    print(f"Changed pages: {len(changed_pages)}  {sorted(changed_pages)}")
    if gone_pages:
        print(f"Disappeared:   {len(gone_pages)}  {sorted(gone_pages)}")
    return state


def write_log(results) -> None:
    existing: dict[str, str] = {}
    if os.path.exists(CRAWL_LOG_PATH):
        with open(CRAWL_LOG_PATH, "r", encoding="utf-8") as f:
            for line in f:
                parts = line.rstrip("\n").split("\t")
                if len(parts) == 6 and parts[0] in ("version", "branch"):
                    existing[f"{parts[0]}\t{parts[1]}"] = line.rstrip("\n")
                elif len(parts) == 5 and parts[0] != "version":
                    # legacy rows (no source column) were all ?version= probes
                    existing[f"version\t{parts[0]}"] = "version\t" + line.rstrip("\n")
    for res in results:
        existing[f"{res['source']}\t{res['version']}"] = "\t".join(
            str(res[k]) for k in ("source", "version", "status", "http_code", "bytes", "bug_count")
        )
    with open(CRAWL_LOG_PATH, "w", encoding="utf-8") as f:
        f.write("source\tversion\tstatus\thttp_code\tbytes\tbug_count\n")
        for key in sorted(existing):
            f.write(existing[key] + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--full", action="store_true", help="probe every candidate")
    parser.add_argument("--fast", action="store_true", help="frontier probe only (default)")
    parser.add_argument("--workers", type=int, default=8)
    args = parser.parse_args()
    if args.full:
        full = True
    elif args.fast:
        full = False
    else:
        # No prior state means nothing to be incremental against.
        full = not load_state().get("pages")
    crawl(full=full, workers=args.workers)


if __name__ == "__main__":
    main()
