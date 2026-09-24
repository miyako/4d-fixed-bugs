#!/usr/bin/env python3
"""
Step 3 — sync the Japanese cross-reference notes.

Two 4D-JP repositories carry per-bug Japanese descriptions that are far richer
than the terse English text on bugs.4d.com, and are used as extra context when
writing each bug's English summary:

  4D-JP/4D-jp.github.io   _posts/*.md with `layout: fix` front matter
  4D-JP/release-notes     v<major>/<release>/README.md  (static, v13–v17)

Both are shallow-cloned into vendor/ (fetching hundreds of files through the
GitHub API is slow and rate-limited; cloning is neither).

Note items look like:

    * ACI0106502 リストフォームにピクチャーが表示されませんでした。

    **注記**: … continuation paragraph belonging to the bullet above …

Output: data/jp_notes.json  [{reference, source, version_raw, version_norm, text, path}]
"""
from __future__ import annotations

import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from common import (  # noqa: E402
    JP_NOTES_PATH,
    VENDOR_DIR,
    load_state,
    now_iso,
    save_state,
    write_json,
)

REPOS = {
    "blog": ("4D-jp.github.io", "https://github.com/4D-JP/4D-jp.github.io.git"),
    "release-notes": ("release-notes", "https://github.com/4D-JP/release-notes.git"),
}

ITEM_RE = re.compile(r"^\*[\s\u3000]*(ACI\d{7})[\s\u3000]*(.*)$")
HR_RE = re.compile(r"^-{3,}\s*$")
FRONT_MATTER_VERSION_RE = re.compile(r"^version:\s*(.+?)\s*$", re.MULTILINE)
LAYOUT_FIX_RE = re.compile(r"^layout:\s*fix\s*$", re.MULTILINE)


def run(cmd, cwd=None) -> str:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)} failed: {proc.stderr.strip()}")
    return proc.stdout.strip()


def sync_repo(name: str, url: str) -> str:
    """Shallow-clone or fast-forward the repo; returns its HEAD sha."""
    path = os.path.join(VENDOR_DIR, name)
    if os.path.isdir(os.path.join(path, ".git")):
        run(["git", "fetch", "--depth", "1", "origin", "HEAD"], cwd=path)
        run(["git", "reset", "--hard", "FETCH_HEAD"], cwd=path)
    else:
        os.makedirs(VENDOR_DIR, exist_ok=True)
        run(["git", "clone", "--depth", "1", "--quiet", url, path])
    return run(["git", "rev-parse", "HEAD"], cwd=path)


def normalize_blog_version(raw: str) -> str:
    """`"21r4"` -> `21_r4`, `16.4 Hotfix 1` -> `16.4_hf1`, `17.0` -> `17`."""
    v = raw.strip().strip('"').strip("'").strip().lower()
    v = re.sub(r"\s+hotfix\s*(\d+)$", r"_hf\1", v)
    v = re.sub(r"\s+hotfix$", "", v)
    v = re.sub(r"^(\d+)r(\d+)", r"\1_r\2", v)
    v = re.sub(r"^(\d+)\.0$", r"\1", v)
    return v.replace(" ", "_")


def normalize_release_notes_version(rel_dir: str) -> str:
    """`v16/r4/2` -> `16_r4_hf2`, `v15/15.4/hf3` -> `15.4_hf3`."""
    parts = rel_dir.split("/")
    major = parts[0].lstrip("vV")
    rest = parts[1:]
    if not rest:
        return major
    head = rest[0]
    out = f"{major}_{head}" if re.fullmatch(r"r\d+", head) else head
    for extra in rest[1:]:
        m = re.fullmatch(r"(?:hf)?(\d+)", extra)
        out += f"_hf{m.group(1)}" if m else f"_{extra}"
    return out


def extract_items(body: str):
    """Yield (reference, text) for every `* ACI…` bullet, keeping any
    continuation paragraphs that follow it."""
    current_ref = None
    buffer: list[str] = []
    for line in body.splitlines():
        m = ITEM_RE.match(line)
        if m:
            if current_ref:
                yield current_ref, "\n".join(buffer).strip()
            current_ref = m.group(1)
            buffer = [m.group(2).strip()]
            continue
        if current_ref is None:
            continue
        if HR_RE.match(line) or ITEM_RE.match(line.lstrip()):
            yield current_ref, "\n".join(buffer).strip()
            current_ref, buffer = None, []
            continue
        buffer.append(line.rstrip())
    if current_ref:
        yield current_ref, "\n".join(buffer).strip()


def split_front_matter(content: str) -> tuple[str, str]:
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) == 3:
            return parts[1], parts[2]
    return "", content


def collect_blog(repo_dir: str):
    posts_dir = os.path.join(repo_dir, "_posts")
    for fname in sorted(os.listdir(posts_dir)):
        if not fname.endswith((".md", ".markdown")):
            continue
        path = os.path.join(posts_dir, fname)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        front, body = split_front_matter(content)
        if not LAYOUT_FIX_RE.search(front):
            continue
        m = FRONT_MATTER_VERSION_RE.search(front)
        if not m:
            continue
        version_raw = m.group(1).strip()
        rel = os.path.join("4D-JP", "4D-jp.github.io", "_posts", fname)
        for ref, text in extract_items(body):
            if text:
                yield {
                    "reference": ref,
                    "source": "blog",
                    "version_raw": version_raw,
                    "version_norm": normalize_blog_version(version_raw),
                    "text": text,
                    "path": rel,
                }


def collect_release_notes(repo_dir: str):
    for root, _dirs, files in os.walk(repo_dir):
        if ".git" in root.split(os.sep) or "README.md" not in files:
            continue
        rel_dir = os.path.relpath(root, repo_dir)
        if rel_dir == "." or not re.match(r"^v\d+", rel_dir):
            continue
        rel_dir = rel_dir.replace(os.sep, "/")
        path = os.path.join(root, "README.md")
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        rel = f"4D-JP/release-notes/{rel_dir}/README.md"
        for ref, text in extract_items(content):
            if text:
                yield {
                    "reference": ref,
                    "source": "release-notes",
                    "version_raw": rel_dir,
                    "version_norm": normalize_release_notes_version(rel_dir),
                    "text": text,
                    "path": rel,
                }


def main() -> int:
    state = load_state()
    jp_state = state.setdefault("jp", {})
    notes = []
    for source, (dirname, url) in REPOS.items():
        sha = sync_repo(dirname, url)
        previous = jp_state.get(source, {}).get("head")
        print(f"{source}: {sha}" + ("" if previous != sha else "  (unchanged)"))
        jp_state[source] = {"head": sha, "synced_at": now_iso()}
        repo_dir = os.path.join(VENDOR_DIR, dirname)
        collector = collect_blog if source == "blog" else collect_release_notes
        found = list(collector(repo_dir))
        print(f"  {len(found)} notes")
        notes.extend(found)

    if not notes:
        print("ERROR: no JP notes extracted — refusing to overwrite data/jp_notes.json")
        return 1

    write_json(JP_NOTES_PATH, notes)
    refs = {n["reference"] for n in notes}
    print(f"\nWrote {JP_NOTES_PATH}: {len(notes)} notes across {len(refs)} references")

    state["counts"]["jp_notes"] = len(notes)
    save_state(state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
