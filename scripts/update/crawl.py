#!/usr/bin/env python3
"""
Step 1 — crawl developer.4d.com/FixedBugsList.

Probes every candidate version string in the 4D version-numbering scheme
against both listings:

  versions/<VERSION>/   releases / hotfixes   e.g. versions/21.1_HF2/
  nightly/<BRANCH>/     nightly builds       e.g. nightly/21_R4/

Missing pages return HTTP 404. Legacy cached pages may instead contain
`<div class="standard_error">` or an empty branch document.

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

Transient failures:
  The site is GitHub Pages, which answers HTTP 503 under load — a burst of
  parallel requests from a datacenter IP is exactly what it throttles. A page
  that still returns 5xx/429 after the per-request retries, or whose request
  never got a response, is *unresolved*: not "missing", and not a reason to
  throw away the whole crawl. Unresolved pages are retried one at a time with
  longer spacing, keep whatever state (and cached HTML) they had before, and
  are listed in `last_crawl.unresolved` so the run reports them. Only a crawl
  that loses more than MAX_UNRESOLVED_SHARE of its pages is treated as an
  outage and fails. Pages that keep failing one after another trip a circuit
  breaker (FAILURE_PATIENCE), which stops the crawl instead of letting every
  remaining candidate sit out its own backoff.
"""
from __future__ import annotations

import argparse
import os
import random
import re
import subprocess
import sys
import threading
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
    listing_url,
    now_iso,
    page_key,
    save_state,
    sha256_text,
)

FRONTIER_LOOKAHEAD = 3
ROW_MARKER_RELEASED = re.compile(r'<th class="title 4D">')
ROW_MARKER_BETA = re.compile(r'<td class="title"[^>]*>\s*ACI\d{7}\s*</td>')
H1_RE = re.compile(r"<h1>(.*?)</h1>", re.DOTALL)

RETRYABLE_HTTP = {429, 500, 502, 503, 504}
MAX_BACKOFF = 60
# The parallel pass stays quick on purpose: short backoff, many pages. The
# long waits belong to the sequential retry passes, which cover only pages
# that are still missing.
PROBE_ATTEMPTS = 3
# Attempts per sequential retry pass, and the delays between passes. A GitHub
# Pages 503 usually clears within a minute or two.
RETRY_ATTEMPTS = (4, 6)
RETRY_PASS_DELAYS = (20, 60)
# Pages in a row with no successful response before the crawl gives up: the
# site is down, and sitting out the backoff for every remaining candidate
# would burn the whole job timeout to learn nothing.
FAILURE_PATIENCE = 20
# A crawl that leaves more than this share of its candidates unresolved is
# treated as an outage rather than a few flaky pages.
MAX_UNRESOLVED_SHARE = 0.2


class TransientError(RuntimeError):
    """The server was temporarily unavailable (HTTP 5xx/429, or no response).

    Deliberately a RuntimeError subclass so existing callers that only catch
    RuntimeError keep working, but distinct enough for the crawl to skip the
    page and keep the data it already has instead of failing the whole run.
    """


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


def classify(source: str, body: str, http_code: int = 200, url: str = "") -> tuple[bool, int]:
    """(page_exists, bug_count) for a fetched page.

    `url` is only used to make errors name the offending page. A status the
    server may recover from (5xx/429) raises TransientError so the page can be
    retried later; anything else is a genuine surprise and stops the crawl."""
    if http_code == 404:
        return False, 0
    if http_code != 200:
        snippet = re.sub(r"\s+", " ", body).strip()[:200]
        message = (
            f"unexpected HTTP {http_code} for {source} listing {url} "
            f"(body: {snippet!r})"
        )
        raise (TransientError if http_code in RETRYABLE_HTTP else RuntimeError)(message)
    heading = H1_RE.search(body)
    if source == SOURCE_VERSION:
        if 'class="standard_error"' in body:
            return False, 0
        if heading and heading.group(1).startswith("All Products "):
            return True, len(ROW_MARKER_RELEASED.findall(body))
        # A version still in beta answers 200 with an "Information" notice
        # ("... is still in Beta. A bug list will be available when this
        # version will be released.") instead of a 404. It has no released
        # listing yet; the nightly listing covers it.
        if (heading and heading.group(1).strip() == "Information"
                and "still in Beta" in body
                and not ROW_MARKER_RELEASED.search(body)):
            return False, 0
    elif heading and heading.group(1).startswith(("Nightly builds 4D ", "Beta 4D ")):
        return True, len(ROW_MARKER_BETA.findall(body))
    elif not heading and not body.strip():
        return False, 0
    title = re.search(r"<title>(.*?)</title>", body, re.DOTALL)
    raise RuntimeError(
        f"unrecognized HTML for {source} listing {url} "
        f"(h1={heading.group(1).strip()[:80] if heading else None!r}, "
        f"title={title.group(1).strip()[:80] if title else None!r}, "
        f"{len(body)} bytes)"
    )


# When any worker gets a transient error, every worker waits until this
# monotonic time before its next request, so a rate-limited or overloaded
# server is not hit by the rest of the pool while one worker backs off.
_cooldown_lock = threading.Lock()
_cooldown_until = 0.0


def _wait_for_cooldown() -> None:
    with _cooldown_lock:
        delay = _cooldown_until - time.monotonic()
    if delay > 0:
        time.sleep(delay)


def _start_cooldown(seconds: float) -> None:
    global _cooldown_until
    with _cooldown_lock:
        _cooldown_until = max(_cooldown_until, time.monotonic() + seconds)


# Circuit breaker. Each backoff is cheap for one page and ruinous across ~700:
# if the site is genuinely down, every candidate would sit out its own retries
# and the weekly job would spend its whole timeout learning that. After
# FAILURE_PATIENCE pages in a row with nothing usable, the crawl stops probing
# and reports an outage instead.
_failure_lock = threading.Lock()
_consecutive_failures = 0
_abort = threading.Event()


def reset_breaker() -> None:
    global _consecutive_failures
    with _failure_lock:
        _consecutive_failures = 0
    _abort.clear()


def _note_failure() -> None:
    global _consecutive_failures
    with _failure_lock:
        _consecutive_failures += 1
        tripped = _consecutive_failures >= FAILURE_PATIENCE
    if tripped:
        _abort.set()


def _note_success() -> None:
    global _consecutive_failures
    with _failure_lock:
        _consecutive_failures = 0


def fetch(source: str, version: str, attempts: int = 7) -> tuple[int, str]:
    """Fetch one listing page.

    Uses the system `curl` rather than urllib: the bundled Python on some
    machines has no usable CA trust store, and curl is what the original
    crawler used. Transport errors and transient HTTP statuses (429/5xx)
    are retried with jittered exponential backoff shared across workers; if a
    transient status persists it is returned so `classify` reports it, and a
    transport error that never clears raises `TransientError`.
    """
    url = listing_url(source, version)
    last_err = ""
    for attempt in range(attempts):
        _wait_for_cooldown()
        proc = subprocess.run(
            [
                "curl", "-sS", "-L", "--max-time", "30",
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
                http_code = int(code.strip())
            except ValueError:
                last_err = f"unparsable status {code!r}"
            else:
                if http_code not in RETRYABLE_HTTP or attempt == attempts - 1:
                    return http_code, body
                last_err = f"HTTP {http_code}"
        else:
            last_err = proc.stderr.decode("utf-8", "replace").strip()
        if attempt < attempts - 1:
            # Jitter: identical backoff makes workers resume in lockstep and
            # reproduce the same burst that was just throttled.
            _start_cooldown(min(2 ** (attempt + 1), MAX_BACKOFF) * random.uniform(1.0, 1.4))
    raise TransientError(f"failed to fetch {url}: {last_err}")


def probe(candidate: tuple[str, str], attempts: int = PROBE_ATTEMPTS) -> dict:
    """Fetch and classify one listing page.

    A page the server would not serve is reported as `unresolved` instead of
    raising: one unreachable page must not discard the other 700.
    """
    source, version = candidate
    if _abort.is_set():
        return {
            "source": source,
            "version": version,
            "status": "unresolved",
            "error": "not attempted: developer.4d.com stopped responding",
        }
    try:
        http_code, body = fetch(source, version, attempts=attempts)
        exists, bug_count = classify(source, body, http_code, listing_url(source, version))
    except TransientError as exc:
        _note_failure()
        return {
            "source": source,
            "version": version,
            "status": "unresolved",
            "error": str(exc),
        }
    _note_success()
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


def retry_unresolved(results: list[dict], delays=RETRY_PASS_DELAYS,
                     attempts=RETRY_ATTEMPTS) -> list[dict]:
    """Re-probe the pages that failed, one at a time.

    Sequential on purpose: the parallel burst is what a throttling GitHub
    Pages edge reacts to, so repeating it is the one thing guaranteed not to
    help. Later passes are allowed more attempts, since they deal with fewer
    pages. Order is preserved and every entry is replaced in place.
    """
    by_key = {(r["source"], r["version"]): r for r in results}
    unresolved = [r for r in results if r["status"] == "unresolved"]
    if not unresolved:
        return results
    print(f"\n{len(unresolved)} page(s) were not served; retrying them one at a time...")
    for index, delay in enumerate(delays, 1):
        if not unresolved:
            break
        print(f"  pass {index}/{len(delays)}: waiting {delay}s before "
              f"{len(unresolved)} sequential request(s)")
        time.sleep(delay)
        still = []
        for position, res in enumerate(unresolved):
            if _abort.is_set():
                still.extend(unresolved[position:])
                print("  giving up: developer.4d.com is not answering at all")
                break
            key = (res["source"], res["version"])
            fresh = probe(key, attempts=attempts[index - 1] if index <= len(attempts)
                          else attempts[-1])
            by_key[key] = fresh
            if fresh["status"] == "unresolved":
                still.append(fresh)
                print(f"  still unavailable: {key[0]}={key[1]}")
            else:
                print(f"  [recovered] {key[0]}={key[1]}")
        unresolved = still
    return [by_key[(r["source"], r["version"])] for r in results]


def select_candidates(state: dict, full: bool) -> list[tuple[str, str]]:
    candidates = build_candidates(state.get("majors", [18, 19, 20, 21, 22]))
    if full or state.get("listing_base_url") != BASE_URL:
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
    reset_breaker()
    state = load_state()
    pages = state.setdefault("pages", {})
    candidates = select_candidates(state, full)
    print(f"Probing {len(candidates)} candidates ({'full' if full else 'fast'} mode)...")

    for source in (SOURCE_VERSION, SOURCE_BRANCH):
        os.makedirs(os.path.join(EXISTS_DIR, source), exist_ok=True)
        os.makedirs(os.path.join(NOTFOUND_DIR, source), exist_ok=True)

    results = []

    with ThreadPoolExecutor(max_workers=workers) as pool:
        for i, res in enumerate(pool.map(probe, candidates), 1):
            results.append(res)
            if res["status"] == "found":
                print(f"  [found]    {res['source']}={res['version']} ({res['bug_count']} bugs)")
            if i % 200 == 0:
                print(f"  ...{i}/{len(candidates)}")

    if _abort.is_set():
        print(f"\nGiving up: {FAILURE_PATIENCE} pages in a row could not be fetched. "
              "developer.4d.com looks down rather than merely busy.")
    results = retry_unresolved(results)
    unresolved = [r for r in results if r["status"] == "unresolved"]

    new_pages, changed_pages, gone_pages = [], [], []
    for res in results:
        if res["status"] == "unresolved":
            # Keep the previous state (and the cached HTML) exactly as it was:
            # a page we could not read is not a page that disappeared.
            continue
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
    state["listing_base_url"] = BASE_URL
    state["counts"]["pages_found"] = sum(
        1 for p in pages.values() if p.get("status") == "found"
    )
    state["last_crawl"] = {
        "mode": "full" if full else "fast",
        "probed": len(candidates),
        "new_pages": sorted(new_pages),
        "changed_pages": sorted(changed_pages),
        "gone_pages": sorted(gone_pages),
        # Pages the site would not serve this run. Their previous state was
        # kept, so the delta they would have produced is simply deferred to
        # the next crawl.
        "unresolved": sorted(page_key(r["source"], r["version"]) for r in unresolved),
    }
    save_state(state)
    write_log([r for r in results if r["status"] != "unresolved"])

    print(f"\nFound pages: {state['counts']['pages_found']}")
    print(f"New pages:     {len(new_pages)}  {sorted(new_pages)}")
    print(f"Changed pages: {len(changed_pages)}  {sorted(changed_pages)}")
    if gone_pages:
        print(f"Disappeared:   {len(gone_pages)}  {sorted(gone_pages)}")
    if unresolved:
        print(f"Unavailable:   {len(unresolved)}  "
              f"{state['last_crawl']['unresolved']}")
    return state


def verdict(probed: int, unresolved: list[str]) -> int:
    """Exit status for a crawl that left `unresolved` pages unread.

    A handful of throttled pages is normal and already covered by the data
    carried over from the previous run, so it only warrants a warning. Losing
    a fifth of the site is an outage, and publishing a dataset built from it
    would misreport a quiet week.
    """
    if not unresolved:
        return 0
    listed = ", ".join(unresolved[:10]) + (" …" if len(unresolved) > 10 else "")
    if probed and len(unresolved) / probed > MAX_UNRESOLVED_SHARE:
        print(
            f"\nERROR: {len(unresolved)} of {probed} listings could not be fetched "
            f"(over {MAX_UNRESOLVED_SHARE:.0%}). This looks like developer.4d.com "
            f"being unavailable rather than a few throttled pages; re-run later.\n"
            f"  {listed}",
            file=sys.stderr,
        )
        return 1
    print(
        f"\nWARNING: {len(unresolved)} of {probed} listings could not be fetched after "
        f"retrying. Their previous data was kept and they are re-probed next run.\n"
        f"  {listed}",
        file=sys.stderr,
    )
    return 0


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


def main() -> int:
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
    state = crawl(full=full, workers=args.workers)
    last = state.get("last_crawl", {})
    return verdict(last.get("probed", 0), last.get("unresolved", []))


if __name__ == "__main__":
    raise SystemExit(main())
