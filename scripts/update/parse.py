#!/usr/bin/env python3
"""
Step 2 — parse crawled HTML into structured bug records.

bugs.4d.com serves two different table layouts:

  released (`?version=`)      <th class="title 4D">ACI…</th>
                              <td class="description">summary</td>
                              <td class="version">… "fixed also with" links …</td>

  beta (`?branch=`)           <td class="title">build no</td>
                              <td class="title">build date</td>
                              <td class="title" style="…">ACI…</td>
                              <td class="description">summary</td>
                              <td class="description">… "fixed also with" links …</td>

Both are parsed here. Each ACI reference ends up with exactly one record whose
`versions` is the union of every version it was seen fixed in (the page's own
version plus every "fixed also with" link, across all pages).

References that are not exactly `ACI` + 7 digits are treated as source noise
and dropped.

Output: data/bugs_raw.json
        data/version_sources.json   {version: ["version"|"branch", …]}
"""
from __future__ import annotations

import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    BUGS_RAW_PATH,
    DATA_DIR,
    EXISTS_DIR,
    REF_RE,
    SOURCE_BRANCH,
    SOURCE_VERSION,
    SOURCES,
    load_state,
    normalize_version,
    save_state,
    version_sort_key,
    write_json,
)

VERSION_SOURCES_PATH = os.path.join(DATA_DIR, "version_sources.json")

ROW_RELEASED_RE = re.compile(
    r'<th class="title 4D">(?P<ref>[^<]*)</th>\s*'
    r'<td class="description">(?P<summary>.*?)</td>\s*'
    r"(?:<!--.*?-->\s*)?"
    r'<td class="version">(?P<also>.*?)</td>',
    re.DOTALL,
)
ROW_BETA_RE = re.compile(
    r'<td class="title"[^>]*>\s*(?P<ref>ACI\d{7})\s*</td>\s*'
    r'<td class="description">(?P<summary>.*?)</td>\s*'
    r'<td class="description">(?P<also>.*?)</td>',
    re.DOTALL,
)
HREF_RE = re.compile(r'href="/fixes\?version=([^"]+)"')
TAG_RE = re.compile(r"<[^>]+>")


def clean_text(raw: str) -> str:
    text = TAG_RE.sub("", raw)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def parse_file(source: str, version: str, content: str):
    pattern = ROW_RELEASED_RE if source == SOURCE_VERSION else ROW_BETA_RE
    rows, malformed = [], []
    for m in pattern.finditer(content):
        ref = m.group("ref").strip()
        if not REF_RE.match(ref):
            malformed.append((source, version, ref))
            continue
        also = {normalize_version(v) for v in HREF_RE.findall(m.group("also"))}
        rows.append(
            {
                "reference": ref,
                "summary": clean_text(m.group("summary")),
                "versions": {version} | also,
            }
        )
    return rows, malformed


def main() -> int:
    records: dict[str, dict] = {}
    malformed_all = []
    files_processed = rows_seen = 0

    for source in SOURCES:
        src_dir = os.path.join(EXISTS_DIR, source)
        if not os.path.isdir(src_dir):
            continue
        for fname in sorted(os.listdir(src_dir)):
            if not fname.endswith(".html"):
                continue
            version = normalize_version(fname[:-5])
            with open(os.path.join(src_dir, fname), "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            files_processed += 1
            rows, malformed = parse_file(source, version, content)
            malformed_all.extend(malformed)
            rows_seen += len(rows)
            for row in rows:
                rec = records.setdefault(
                    row["reference"], {"versions": set(), "summaries": set()}
                )
                rec["versions"] |= row["versions"]
                if row["summary"]:
                    rec["summaries"].add(row["summary"])

    print(f"Files processed:        {files_processed}")
    print(f"Rows seen:              {rows_seen}")
    print(f"Unique ACI references:  {len(records)}")
    print(f"Malformed refs skipped: {len(malformed_all)}")
    for source, version, ref in malformed_all[:20]:
        print(f"  MALFORMED in {source}={version}: {ref!r}")

    if not records:
        print("ERROR: no records parsed — refusing to overwrite data/bugs_raw.json")
        return 1

    output = []
    for ref, rec in records.items():
        # Longest variant wins: pages sometimes carry a truncated summary.
        summaries = sorted(rec["summaries"], key=len, reverse=True)
        output.append(
            {
                "reference": ref,
                "raw_summary": summaries[0] if summaries else "",
                "raw_summary_variants": summaries,
                "versions": sorted(rec["versions"], key=version_sort_key),
            }
        )
    output.sort(key=lambda r: r["reference"])
    write_json(BUGS_RAW_PATH, output)

    state = load_state()
    pages = state.get("pages", {})

    def page_found(source, version):
        return pages.get(f"{source}:{version}", {}).get("status") == "found"

    # A version is "beta-only" when bugs.4d.com serves it as a nightly/beta
    # branch but has no released listing for it — its canonical URL is then
    # ?branch=<v>, not ?version=<v> (which returns the error page).
    all_versions = sorted(
        {v for rec in output for v in rec["versions"]}, key=version_sort_key
    )
    beta_only = [
        v for v in all_versions if page_found(SOURCE_BRANCH, v) and not page_found(SOURCE_VERSION, v)
    ]
    write_json(
        VERSION_SOURCES_PATH,
        {
            v: [s for s in SOURCES if page_found(s, v)]
            for v in all_versions
        },
    )

    print(f"\nWrote {BUGS_RAW_PATH} ({len(output)} bugs)")
    print(f"Beta-only versions (no released listing): {beta_only}")

    state["counts"]["bugs_raw"] = len(output)
    state["beta_only_versions"] = beta_only
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
