#!/usr/bin/env python3
"""
Candidate 4D command detection in free text.

This is deliberately a *candidate* generator, not ground truth: the enrichment
step is told to judge each candidate's relevance before linking it.

Two matching regimes, because naive matching fails in both directions:

  multi-word names ("SELECTION TO ARRAY", "Print form")
      Matched freely by scanning every 1..7-word phrase of the text against the
      command index. False positives are rare because the phrases are long.
      A purely "quoted / backticked / ALL-CAPS" matcher misses plain Title Case
      names that appear in ordinary prose (e.g. "Maximize Window").

  single-word names ("QUERY", "Date", "Choose", "File")
      ~105 of these are also ordinary English words, so a free scan matched
      them constantly (2,137 of 2,420 bugs picked up spurious hits). They are
      matched *only* when the source text marks them as code: backticked,
      quote-marked, or written in strict ALL-CAPS. Single-character legacy
      commands (A, C, D, E, F, G, I, M, N, O, P, R, S) are excluded outright.

Tokenization gotcha: a regex that doesn't strip leading/trailing quote
characters leaves stray `'`/`"` glued to tokens ('License, usage'), silently
breaking multi-word phrase matches that would otherwise be exact.
"""
from __future__ import annotations

import re

MAX_PHRASE_WORDS = 7
TOKEN_STRIP = ".,;:()'\"‘’“”「」`*"
CODE_SPAN_RE = re.compile(
    r"`{1,3}([^`\n]+?)`{1,3}"                        # `NAME` / ``NAME`` / ```NAME```
    r"|\"([^\"\n]+?)\""                               # "NAME"
    r"|'([^'\n]+?)'"                                  # 'NAME'
    r"|\u300c([^\u300d\n]+?)\u300d"                   # 「NAME」
)
QUOTED_RE = CODE_SPAN_RE
ALLCAPS_RE = re.compile(r"\b([A-Z][A-Z0-9_]{2,}(?:\s+[A-Z][A-Z0-9_]*)*)\b")
WORD_RE = re.compile(r"[A-Za-z0-9_.]+")
# Japanese prose runs command names straight into surrounding text with no
# spaces ("`SET PRINT OPTION`コマンド"), which would otherwise glue the trailing
# kana onto the last word and break the phrase match.
NON_LATIN_RE = re.compile(r"[^\x00-\x7f]+")


def build_lookup(command_index: dict) -> dict:
    """{normalized name -> canonical index key} for fast phrase lookup."""
    return {name.upper(): name for name in command_index}


def code_spans(text: str) -> list[str]:
    spans = []
    for m in CODE_SPAN_RE.finditer(text):
        value = next(g for g in m.groups() if g is not None).strip()
        if value:
            spans.append(value)
    return spans


def tokenize(text: str) -> list[str]:
    tokens = []
    for raw in NON_LATIN_RE.sub(" ", text).split():
        token = raw.strip(TOKEN_STRIP)
        if token:
            tokens.append(token)
    return tokens


def match_multiword(text: str, lookup: dict) -> set:
    tokens = tokenize(text)
    hits = set()
    for i in range(len(tokens)):
        for n in range(2, MAX_PHRASE_WORDS + 1):
            if i + n > len(tokens):
                break
            phrase = " ".join(tokens[i : i + n]).upper()
            key = lookup.get(phrase)
            if key:
                hits.add(key)
    # A code span is an explicit "this is a command" signal, so accept it whole
    # even when it is a single word.
    for span in code_spans(text):
        key = lookup.get(" ".join(tokenize(span)).upper())
        if key:
            hits.add(key)
    return hits


def match_singleword(text: str, lookup: dict) -> set:
    """Single-word names only count when the text marks them as code."""
    hits = set()
    candidates = set(code_spans(text))
    candidates.update(ALLCAPS_RE.findall(text))

    for candidate in candidates:
        words = tokenize(candidate)
        if len(words) != 1 or len(words[0]) < 2:
            continue
        key = lookup.get(words[0].upper())
        if key:
            hits.add(key)
    return hits


def match_commands(texts, command_index: dict, lookup: dict | None = None) -> list:
    """Return [{title, url}] candidates for the concatenation of `texts`.

    Both the English source summary and the Japanese notes are scanned: the JP
    notes routinely name commands the terse English text omits.
    """
    lookup = lookup if lookup is not None else build_lookup(command_index)
    blob = "\n".join(t for t in texts if t)
    if not blob:
        return []

    keys = set()
    for key in match_multiword(blob, lookup) | match_singleword(blob, lookup):
        if len(key) <= 1:  # legacy single-character commands (A, C, D, …)
            continue
        keys.add(key)

    # Longest name first: blank each match out of a working copy of the text so
    # a shorter name can't double-count inside an already-matched longer one
    # ("OBJECT" inside "GOTO OBJECT") — but a shorter name that also occurs
    # independently elsewhere is still kept.
    working = NON_LATIN_RE.sub(" ", blob).upper()
    result = []
    for key in sorted(keys, key=lambda k: (-len(k), k)):
        pattern = re.compile(rf"(?<![A-Z0-9_]){re.escape(key.upper())}(?![A-Z0-9_])")
        if not pattern.search(working):
            continue
        working = pattern.sub(" ", working)
        entry = command_index[key]
        result.append({"title": entry["title"], "url": entry["url"]})
    result.sort(key=lambda e: e["title"])
    return result
