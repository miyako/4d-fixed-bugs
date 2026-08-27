#!/usr/bin/env python3
"""
4D Bugs Crawler - Phase 2a: Deterministic HTML -> structured extraction

Parses every HTML file in exists/, extracts (reference, raw_summary, versions)
per row, validates the ACI reference format, and merges duplicate references
across files so each ACI number has exactly one record with the union of all
versions it was ever seen fixed in (its own page version + all "Fixed also
with" links across every occurrence).
"""
import os
import re
import json
import html
import sys

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
EXISTS_DIR = os.path.join(BASE, "exists")
OUT_DIR = os.path.join(BASE, "parsed")
os.makedirs(OUT_DIR, exist_ok=True)

REF_RE = re.compile(r'^ACI\d{7}$')
ROW_RE = re.compile(
    r'<th class="title 4D">(?P<ref>[^<]*)</th>\s*'
    r'<td class="description">(?P<summary>.*?)</td>\s*'
    r'(?:<!--.*?-->\s*)?'
    r'<td class="version">(?P<versions_html>.*?)</td>',
    re.DOTALL
)
HREF_RE = re.compile(r'href="/fixes\?version=([^"]+)"')
TAG_RE = re.compile(r'<[^>]+>')

def clean_text(raw):
    text = TAG_RE.sub('', raw)
    text = html.unescape(text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text

def normalize_version(v):
    return v.strip().lower()

records = {}  # reference -> {"versions": set(), "raw_summaries": set()}
malformed_refs = []
files_processed = 0
rows_seen = 0

for fname in sorted(os.listdir(EXISTS_DIR)):
    if not fname.endswith(".html"):
        continue
    own_version = normalize_version(fname[:-5])
    path = os.path.join(EXISTS_DIR, fname)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        content = f.read()

    files_processed += 1

    for m in ROW_RE.finditer(content):
        rows_seen += 1
        ref_raw = m.group("ref").strip()
        if not REF_RE.match(ref_raw):
            malformed_refs.append((fname, ref_raw))
            continue

        raw_summary = clean_text(m.group("summary"))
        versions_html = m.group("versions_html")
        fixed_also = {normalize_version(v) for v in HREF_RE.findall(versions_html)}

        all_versions_this_row = {own_version} | fixed_also

        rec = records.setdefault(ref_raw, {"versions": set(), "raw_summaries": set()})
        rec["versions"] |= all_versions_this_row
        if raw_summary:
            rec["raw_summaries"].add(raw_summary)

print(f"Files processed: {files_processed}")
print(f"Rows seen: {rows_seen}")
print(f"Unique ACI references: {len(records)}")
print(f"Malformed references skipped: {len(malformed_refs)}")
if malformed_refs:
    for fname, ref in malformed_refs[:20]:
        print(f"  MALFORMED in {fname}: {ref!r}")

# Build final structure, sorting versions for determinism.
def version_sort_key(v):
    # crude sort: major, minor, release, hotfix numeric-ish ordering
    m = re.match(r'^(\d+)(?:\.(\d+))?(?:_r(\d+))?(?:_hf(\d+))?', v)
    if not m:
        return (999, 0, 0, 0, v)
    major = int(m.group(1))
    minor = int(m.group(2)) if m.group(2) else 0
    release = int(m.group(3)) if m.group(3) else 0
    hotfix = int(m.group(4)) if m.group(4) else 0
    return (major, minor, release, hotfix, v)

output = []
multi_summary_count = 0
for ref, rec in records.items():
    summaries = sorted(rec["raw_summaries"], key=len, reverse=True)
    if len(summaries) > 1:
        multi_summary_count += 1
    output.append({
        "reference": ref,
        "raw_summary": summaries[0] if summaries else "",
        "raw_summary_variants": summaries,  # kept for review; not part of final schema
        "versions": sorted(rec["versions"], key=version_sort_key)
    })

output.sort(key=lambda r: r["reference"])

print(f"References with multiple distinct summary text variants across pages: {multi_summary_count}")

out_path = os.path.join(OUT_DIR, "bugs_raw.json")
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(output, f, indent=2, ensure_ascii=False)

print(f"\nSaved raw structured data to: {out_path}")
print(f"Total bug records: {len(output)}")
