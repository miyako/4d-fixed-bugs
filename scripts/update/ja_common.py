#!/usr/bin/env python3
"""
Shared helpers for the Japanese translation stage.

The Japanese site shows a Japanese summary for every bug. Each one is written
from two sources: the English summary (the dataset's canonical prose, with its
command doc-links) and the official Japanese release-note text for the same
bug (`jp_notes`, the original wording 4D Japan published). The fingerprint
below covers both, so a bug is re-translated whenever either changes.

`validate_translation` is the gate every written translation passes before it
enters `data/all_bugs_ja.json` — see `merge_translation.py`.
"""
from __future__ import annotations

import collections
import re

from common import sha256_text

LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
CODE_RE = re.compile(r"`([^`]+)`")
ACI_RE = re.compile(r"ACI\d{7}")
DIGITS_RE = re.compile(r"\d+(?:\.\d+)*")
ASCII_WORDS_RE = re.compile(r"(?:[A-Za-z][A-Za-z'’-]*[\s,]+){5,}[A-Za-z][A-Za-z'’-]*")
JA_CHAR_RE = re.compile(r"[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]")
LETTER_RE = re.compile(r"[A-Za-z\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]")

DOCS_PREFIX = "https://developer.4d.com/docs/"
DOCS_JA_PREFIX = "https://developer.4d.com/docs/ja/"
ALLOWED_LINK_PREFIX = "https://developer.4d.com/"

# Sentence endings accepted as polite form (です・ます調).
POLITE_ENDINGS = (
    "ます",
    "ました",
    "ません",
    "ませんでした",
    "です",
    "でした",
    "でしょう",
    "ください",
)
SENTENCE_TRAILERS = "）)」』\"'"


def to_ja_url(url: str) -> str:
    """developer.4d.com/docs/<path> -> developer.4d.com/docs/ja/<path>."""
    if url.startswith(DOCS_JA_PREFIX) or not url.startswith(DOCS_PREFIX):
        return url
    return DOCS_JA_PREFIX + url[len(DOCS_PREFIX):]


def fingerprint(summary_en: str, jp_notes: list) -> str:
    """Order-insensitive over the JP notes, like build_context.fingerprint."""
    body = "\n\u0000\n".join(sorted(set(jp_notes or [])))
    return sha256_text(summary_en + "\n\u0000\n" + body)


def _strip_markup(text: str) -> str:
    return CODE_RE.sub(" ", LINK_RE.sub(" ", text))


def _links(text: str):
    return collections.Counter(LINK_RE.findall(text))


def _code_spans(text: str):
    return collections.Counter(CODE_RE.findall(LINK_RE.sub(" ", text)))


def _sentences(text: str):
    plain = LINK_RE.sub(lambda m: m.group(1), text)
    return [s.strip() for s in re.split(r"(?<=。)", plain) if s.strip()]


def is_polite(sentence: str) -> bool:
    s = sentence.rstrip("。")
    # A trailing parenthetical: "…ました（Windows のみ）。"
    m = re.fullmatch(r"(.*?)[（(][^（()）]*[)）]", s)
    if m:
        s = m.group(1).rstrip("。")
    return s.rstrip(SENTENCE_TRAILERS).rstrip("。").endswith(POLITE_ENDINGS)


def validate_translation(summary_ja, en_record):
    """Return (errors, warnings) for one Japanese summary.

    `en_record` is the English dataset record: {reference, summary, commands}.
    """
    errors, warnings = [], []
    if not isinstance(summary_ja, str) or len(summary_ja.strip()) < 10:
        return ["summary missing or too short"], warnings
    text = summary_ja.strip()
    en = en_record["summary"]

    # Links: same link texts, same targets moved under /docs/ja/.
    expected = collections.Counter((t, to_ja_url(u)) for t, u in LINK_RE.findall(en))
    actual = _links(text)
    for (t, u), n in (expected - actual).items():
        errors.append(f"missing link [{t}]({u})")
    for (t, u), n in (actual - expected).items():
        if not u.startswith(ALLOWED_LINK_PREFIX):
            errors.append(f"link href not on developer.4d.com: {u}")
        elif u.startswith(DOCS_PREFIX) and not u.startswith(DOCS_JA_PREFIX):
            errors.append(f"link not localized to /docs/ja/: {u}")
        else:
            errors.append(f"unexpected link [{t}]({u})")

    missing_code = _code_spans(en) - _code_spans(text)
    for code in missing_code:
        errors.append(f"inline code span not preserved: `{code}`")

    for name in en_record.get("commands", []):
        # Only names the English text itself contains verbatim; a few English
        # summaries word a listed command differently, and the translation
        # should not have to invent a mention the English does not make.
        if name in en and name not in text:
            errors.append(f"command {name!r} not mentioned verbatim")

    if set(ACI_RE.findall(text)) != set(ACI_RE.findall(en)):
        errors.append("ACI references differ from the English summary")

    if "**" in text or "```" in text or re.search(r"(^|\n)\s*(#|[-*+] |\d+\. |\|)", text):
        errors.append("disallowed markdown (bold, heading, list, table or fence)")
    if "\n" in text:
        errors.append("summary must be a single paragraph")

    plain = _strip_markup(text)
    ja_chars = len(JA_CHAR_RE.findall(plain))
    letters = len(LETTER_RE.findall(plain))
    if ja_chars < 10 or (letters and ja_chars / letters < 0.4):
        errors.append("summary does not look like Japanese")

    if not text.endswith(("。", "）", ")")):
        warnings.append("summary does not end with 。")
    impolite = [s for s in _sentences(text) if not is_polite(s)]
    if impolite:
        warnings.append(f"sentence not in polite form: {impolite[0][-30:]!r}")

    en_numbers = set(DIGITS_RE.findall(_strip_markup(en)))
    ja_numbers = set(DIGITS_RE.findall(_strip_markup(text)))
    lost = sorted(en_numbers - ja_numbers)
    if lost:
        warnings.append(f"numbers from the English summary missing: {lost[:5]}")

    leftover = ASCII_WORDS_RE.search(plain)
    if leftover:
        warnings.append(f"long untranslated English run: {leftover.group(0)[:60]!r}")

    return errors, warnings
