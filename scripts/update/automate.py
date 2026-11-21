#!/usr/bin/env python3
"""
Automate the two manual "writing" gates with the OpenAI API.

The pipeline stops twice for prose that needs judgement: the English summaries
(ENRICHMENT_PROMPT.md) and the Japanese and French translations
(TRANSLATION_PROMPT*.md). This script does that work with a model, then merges
it with the very same strict validators a person would hit:

  1. English summaries   -> merge_enrichment.py
  2. rebuild the translation queues
  3. Japanese summaries  -> merge_translation.py
  4. French summaries    -> merge_translation.py --lang fr

Nothing unvalidated is ever merged. Each record is checked on its own; a record
that fails is sent back to the model together with the exact problems (up to
ATTEMPTS times) and, if it still fails, stays pending for a human. Pending work
therefore only ever shrinks, and a half-finished run is safe to commit.

Configuration (environment):
  OPENAI_API_KEY        required (GitHub Actions secret)
  OPENAI_MODEL          required (GitHub Actions variable); no default on purpose
  OPENAI_BASE_URL       optional, default https://api.openai.com/v1
  AUTOMATE_CHUNK_SIZE   records per request, default 10
  AUTOMATE_MAX_RECORDS  cap per stage per run, default 400 (a cost guard);
                        the rest stays pending for the next run
  AUTOMATE_WORKERS      concurrent requests, default 4

Exit codes:
  0  everything pending was written and merged (run the build next)
  3  not configured (no key or model): nothing was done
  4  partial: some records are still pending
  5  nothing was pending
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

EXIT_OK, EXIT_NOT_CONFIGURED, EXIT_PARTIAL, EXIT_NOTHING = 0, 3, 4, 5

HERE = os.path.dirname(os.path.abspath(__file__))
ATTEMPTS = 3
SECRET_RE = re.compile(r"sk-[A-Za-z0-9_\-*]+")

FORMAT_NOTE = (
    "\n\n---\n\nOutput format override: respond with a JSON object "
    '{"items": [...]} whose `items` array is exactly the array described above '
    "(same length, same order, same `reference` values). A record that carries "
    "a `problems` list is a retry: its `previous_attempt` was rejected by the "
    "validator for those reasons, so fix exactly those problems."
)


class ApiError(RuntimeError):
    pass


def _clean(text: str, key: str = "") -> str:
    """Make an error message safe to print: never echo a key."""
    if key:
        text = text.replace(key, "[redacted]")
    return SECRET_RE.sub("[redacted]", text)[:300]


# --------------------------------------------------------------------------
# OpenAI client (standard library only)
# --------------------------------------------------------------------------

def openai_complete(system: str, records: list, item_schema: dict, *, key: str, model: str,
                    base_url: str = "https://api.openai.com/v1", timeout: int = 600,
                    attempts: int = 4) -> tuple[list, int]:
    """Ask the model for {"items": [...]} and return (items, tokens_used)."""
    schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["items"],
        "properties": {"items": {"type": "array", "items": item_schema}},
    }
    payload = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": json.dumps(records, ensure_ascii=False)},
        ],
        "response_format": {
            "type": "json_schema",
            "json_schema": {"name": "result", "strict": True, "schema": schema},
        },
    }).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions", data=payload, method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )

    last = ""
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                body = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = json.loads(err.read().decode("utf-8")).get("error", {}).get("message", "")
            except Exception:  # noqa: BLE001
                pass
            last = f"HTTP {err.code}: {_clean(detail, key)}"
            if err.code in (429, 500, 502, 503, 504) and attempt < attempts - 1:
                time.sleep(5 * 2 ** attempt)
                continue
            raise ApiError(last) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError) as err:
            last = f"network error: {_clean(str(err), key)}"
            if attempt < attempts - 1:
                time.sleep(5 * 2 ** attempt)
                continue
            raise ApiError(last) from None

        try:
            message = body["choices"][0]["message"]
            if message.get("refusal"):
                raise ApiError(f"model refused: {_clean(str(message['refusal']), key)}")
            items = json.loads(message["content"])["items"]
        except ApiError:
            raise
        except (KeyError, IndexError, TypeError, ValueError):
            raise ApiError("unexpected response shape") from None
        if not isinstance(items, list):
            raise ApiError("response `items` is not an array")
        tokens = (body.get("usage") or {}).get("total_tokens") or 0
        return items, tokens
    raise ApiError(last or "request failed")


# --------------------------------------------------------------------------
# The retry loop (pure; the model call and the validator are injected)
# --------------------------------------------------------------------------

def write_records(records, ask, check, *, accept_warnings=False, attempts=ATTEMPTS):
    """Get validated output for every record it can.

    ask(batch) -> list of output items.   check(item) -> (errors, warnings).
    Returns (accepted {reference: item}, failed {reference: [problems]}).
    A record is accepted when it has no errors and no warnings; on the last
    attempt, warnings alone are tolerated if `accept_warnings` is set.
    """
    accepted: dict = {}
    todo = [dict(r) for r in records]
    problems: dict = {}
    for attempt in range(1, attempts + 1):
        if not todo:
            break
        try:
            items = ask(todo)
        except ApiError as err:
            for rec in todo:
                problems[rec["reference"]] = [f"API error: {err}"]
            break
        by_ref = {i.get("reference"): i for i in items if isinstance(i, dict)}
        retry = []
        for rec in todo:
            ref = rec["reference"]
            item = by_ref.get(ref)
            if item is None:
                errors, warnings = ["missing from the response"], []
            else:
                errors, warnings = check(item)
            if not errors and (not warnings or (accept_warnings and attempt == attempts)):
                accepted[ref] = item
                problems.pop(ref, None)
                continue
            problems[ref] = list(errors) + list(warnings)
            base = {k: v for k, v in rec.items() if k not in ("problems", "previous_attempt")}
            retry.append({**base, "previous_attempt": item, "problems": problems[ref]})
        todo = retry
    failed = {ref: msgs for ref, msgs in problems.items() if ref not in accepted}
    return accepted, failed


def _chunks(records, size):
    return [records[i:i + size] for i in range(0, len(records), size)]


# --------------------------------------------------------------------------
# Stages
# --------------------------------------------------------------------------

def _run_stage(label, records, system, item_schema, check, *, accept_warnings, cfg, out_path, merge_args):
    from common import write_json  # noqa: E402

    if not records:
        return 0, 0
    records = records[: cfg["max_records"]]
    print(f"\n== {label}: {len(records)} record(s) in {len(_chunks(records, cfg['chunk']))} request(s)")
    tokens = 0

    def work(batch):
        nonlocal tokens

        def ask(todo):
            nonlocal tokens
            items, used = openai_complete(system, todo, item_schema, key=cfg["key"], model=cfg["model"],
                                          base_url=cfg["base_url"])
            tokens += used
            return items

        return write_records(batch, ask, check, accept_warnings=accept_warnings)

    accepted: dict = {}
    failed: dict = {}
    with ThreadPoolExecutor(max_workers=cfg["workers"]) as pool:
        for ok, bad in pool.map(work, _chunks(records, cfg["chunk"])):
            accepted.update(ok)
            failed.update(bad)

    ordered = [accepted[r["reference"]] for r in records if r["reference"] in accepted]
    print(f"   accepted {len(ordered)}, left pending {len(failed)}  (~{tokens} tokens)")
    for ref, msgs in sorted(failed.items()):
        print(f"   - {ref}: {'; '.join(msgs)[:300]}")
    if ordered:
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        write_json(out_path, ordered)
        proc = subprocess.run([sys.executable, *merge_args, out_path, "--partial"], capture_output=True, text=True)
        lines = proc.stdout.strip().splitlines()
        print("   " + lines[-1] if lines else "")
        if proc.returncode != 0:
            print(proc.stdout[-1500:], proc.stderr[-500:])
            raise RuntimeError(f"{label}: merge step rejected the validated output")
    return len(ordered), len(failed)


def _strip(records):
    return [{k: v for k, v in r.items() if k != "fingerprint"} for r in records]


def enrich_stage(cfg):
    from common import COMMAND_INDEX_PATH, PENDING_PATH, load_json  # noqa: E402
    import merge_enrichment  # noqa: E402

    pending = load_json(PENDING_PATH, []) or []
    by_ref = {p["reference"]: p for p in pending}
    index = {k.upper(): v for k, v in (load_json(COMMAND_INDEX_PATH, {}) or {}).items()}

    def check(item):
        errors, warnings, _missing = merge_enrichment.validate([item], by_ref, index, False)
        return errors, warnings

    schema = {
        "type": "object", "additionalProperties": False,
        "required": ["reference", "summary", "commands"],
        "properties": {"reference": {"type": "string"}, "summary": {"type": "string"},
                       "commands": {"type": "array", "items": {"type": "string"}}},
    }
    system = open(os.path.join(HERE, "ENRICHMENT_PROMPT.md"), encoding="utf-8").read() + FORMAT_NOTE
    return _run_stage("English summaries", _strip(pending), system, schema, check, accept_warnings=True, cfg=cfg,
                      out_path=os.path.join(os.path.dirname(PENDING_PATH), "enrichment", "auto.out.json"),
                      merge_args=[os.path.join(HERE, "merge_enrichment.py")])


def translate_stage(lang, cfg):
    from common import ENRICHED_PATH, load_json  # noqa: E402
    from translation_common import config  # noqa: E402

    _translated, pending_path, language = config(lang)
    pending = load_json(pending_path, []) or []
    en_by_ref = {b["reference"]: b for b in load_json(ENRICHED_PATH, []) or []}

    def check(item):
        ref = item.get("reference")
        if ref not in en_by_ref:
            return ["reference not in the English dataset"], []
        return language.validate_translation(item.get("summary"), en_by_ref[ref])

    schema = {
        "type": "object", "additionalProperties": False, "required": ["reference", "summary"],
        "properties": {"reference": {"type": "string"}, "summary": {"type": "string"}},
    }
    prompt = "TRANSLATION_PROMPT_FR.md" if lang == "fr" else "TRANSLATION_PROMPT.md"
    system = open(os.path.join(HERE, prompt), encoding="utf-8").read() + FORMAT_NOTE
    folder = "translation_fr" if lang == "fr" else "translation"
    name = "French" if lang == "fr" else "Japanese"
    return _run_stage(f"{name} summaries", _strip(pending), system, schema, check,
                      accept_warnings=(lang == "ja"), cfg=cfg,
                      out_path=os.path.join(os.path.dirname(pending_path), folder, "auto.out.json"),
                      merge_args=[os.path.join(HERE, "merge_translation.py"), "--lang", lang])


def _pending(path):
    from common import load_json  # noqa: E402
    return len(load_json(path, []) or [])


def main() -> int:
    key, model = os.environ.get("OPENAI_API_KEY", ""), os.environ.get("OPENAI_MODEL", "")
    if not key or not model:
        missing = [n for n, v in (("OPENAI_API_KEY", key), ("OPENAI_MODEL", model)) if not v]
        print(f"Automation not configured (missing {', '.join(missing)}); leaving the writing to a person.")
        return EXIT_NOT_CONFIGURED

    from common import PENDING_PATH, PENDING_TRANSLATION_FR_PATH, PENDING_TRANSLATION_PATH  # noqa: E402

    cfg = {
        "key": key, "model": model,
        "base_url": os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1",
        "chunk": max(1, int(os.environ.get("AUTOMATE_CHUNK_SIZE", "10"))),
        "max_records": max(1, int(os.environ.get("AUTOMATE_MAX_RECORDS", "400"))),
        "workers": max(1, int(os.environ.get("AUTOMATE_WORKERS", "4"))),
    }
    print(f"Writing with model {model} (chunks of {cfg['chunk']}, up to {cfg['max_records']} per stage).")

    enrichment_pending = _pending(PENDING_PATH)
    if not (enrichment_pending or _pending(PENDING_TRANSLATION_PATH) or _pending(PENDING_TRANSLATION_FR_PATH)):
        print("Nothing is pending.")
        return EXIT_NOTHING

    try:
        if enrichment_pending:
            enrich_stage(cfg)
            if _pending(PENDING_PATH):
                print("\nEnglish summaries are still pending; translations have to wait.")
                return EXIT_PARTIAL
            # translation queues only exist for finished English text
        for lang_args in ((), ("--lang", "fr")):
            subprocess.run([sys.executable, os.path.join(HERE, "build_translation.py"), *lang_args],
                           check=True, capture_output=True, text=True)
        translate_stage("ja", cfg)
        translate_stage("fr", cfg)
    except (RuntimeError, subprocess.CalledProcessError) as err:
        print(f"\nAutomation stopped: {_clean(str(err), key)}")
        return EXIT_PARTIAL

    left = _pending(PENDING_PATH) + _pending(PENDING_TRANSLATION_PATH) + _pending(PENDING_TRANSLATION_FR_PATH)
    print(f"\n{'All pending work written.' if not left else f'{left} record(s) still pending.'}")
    return EXIT_OK if not left else EXIT_PARTIAL


if __name__ == "__main__":
    raise SystemExit(main())
