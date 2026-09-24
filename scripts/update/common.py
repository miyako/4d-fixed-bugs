#!/usr/bin/env python3
"""
Shared paths, constants and state handling for the incremental update pipeline.

The pipeline is built around one idea: *crawling is cheap and idempotent,
everything downstream is not*. So every run re-probes bugs.4d.com in full and
records a content hash per page in `data/update_state.json`; the expensive
steps (LLM enrichment, embedding) then run only for bug references that are
actually new or whose source text changed.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone

BASE = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

DATA_DIR = os.path.join(BASE, "data")
DOCS_DATA_DIR = os.path.join(BASE, "docs", "data")
HTML_DIR = os.path.join(BASE, "html")
EXISTS_DIR = os.path.join(HTML_DIR, "exists")
NOTFOUND_DIR = os.path.join(HTML_DIR, "notfound")
VENDOR_DIR = os.path.join(BASE, "vendor")

STATE_PATH = os.path.join(DATA_DIR, "update_state.json")
CRAWL_LOG_PATH = os.path.join(BASE, "crawl_log.tsv")

BUGS_RAW_PATH = os.path.join(DATA_DIR, "bugs_raw.json")
JP_NOTES_PATH = os.path.join(DATA_DIR, "jp_notes.json")
COMMAND_INDEX_PATH = os.path.join(DATA_DIR, "command_index.json")
CONTEXT_PATH = os.path.join(DATA_DIR, "all_bugs_context.json")
ENRICHED_PATH = os.path.join(DATA_DIR, "all_bugs_enriched.json")
PENDING_PATH = os.path.join(DATA_DIR, "pending_enrichment.json")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
BASE_URL = "https://bugs.4d.com/fixedbugslist"

# bugs.4d.com exposes two different listings with two different HTML layouts:
#   ?version=<v>  released products ("All Products 21.2")  -> <th class="title 4D">
#   ?branch=<v>   beta / nightly builds ("Beta 4D 21 R4")   -> <td class="title">
SOURCE_VERSION = "version"
SOURCE_BRANCH = "branch"
SOURCES = (SOURCE_VERSION, SOURCE_BRANCH)

REF_RE = re.compile(r"^ACI\d{7}$")

STATE_VERSION = 1


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()


def page_key(source: str, version: str) -> str:
    return f"{source}:{version}"


def normalize_version(v: str) -> str:
    return v.strip().lower().replace(" ", "_")


def version_sort_key(v: str):
    """Order version strings by (major, minor, r-release, hotfix)."""
    m = re.match(r"^(\d+)(?:\.(\d+))?(?:_r(\d+))?(?:_hf(\d+))?", v)
    if not m:
        return (999, 0, 0, 0, v)
    return (
        int(m.group(1)),
        int(m.group(2)) if m.group(2) else 0,
        int(m.group(3)) if m.group(3) else 0,
        int(m.group(4)) if m.group(4) else 0,
        v,
    )


def empty_state() -> dict:
    return {
        "state_version": STATE_VERSION,
        "last_run": None,
        "last_successful_run": None,
        "majors": [18, 19, 20, 21, 22],
        "pages": {},
        "jp": {},
        "counts": {},
    }


def load_state() -> dict:
    if not os.path.exists(STATE_PATH):
        return empty_state()
    with open(STATE_PATH, "r", encoding="utf-8") as f:
        state = json.load(f)
    base = empty_state()
    base.update(state)
    return base


def save_state(state: dict) -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(STATE_PATH, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write("\n")


def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path, payload, indent=2):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=indent, ensure_ascii=False)
        if indent is not None:
            f.write("\n")
    os.replace(tmp, path)


def build_candidates(majors) -> list[tuple[str, str]]:
    """Every (source, version) pair worth probing.

    Ranges are deliberately generous: an out-of-range candidate costs one cheap
    HTTP request and comes back as "not found", which is far more robust than
    trying to predict each major version's real ceiling up front.
    """
    out: list[tuple[str, str]] = []
    for major in majors:
        for source in SOURCES:
            out.append((source, str(major)))
            for r in range(2, 15):
                out.append((source, f"{major}_r{r}"))
                for hf in range(1, 7):
                    out.append((source, f"{major}_r{r}_hf{hf}"))
            for m in range(1, 10):
                out.append((source, f"{major}.{m}"))
                for hf in range(1, 7):
                    out.append((source, f"{major}.{m}_hf{hf}"))
    return out
