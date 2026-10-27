"""French translation fingerprints and validation against canonical English."""
from __future__ import annotations

import json
import re
import unicodedata

from common import sha256_text
from ja_common import DIGITS_RE, _strip_markup, validate_structure

# Function words provide a conservative language signal without requiring accents.
FRENCH_WORDS = {
    "le", "la", "les", "un", "une", "des", "du", "de", "dans", "avec", "sans",
    "lors", "lorsque", "si", "ne", "pas", "plus", "pouvait", "pouvaient",
    "et", "ou", "sur", "pour", "est", "sont", "était", "étaient", "être",
    "provoquait", "renvoyait", "affichait", "après", "avant", "sous",
    "à", "au", "aux", "en", "par", "entre", "vers", "depuis", "pendant",
    "ce", "ces", "cet", "cette", "son", "sa", "ses", "leur", "leurs",
    "chaque", "certains", "certaines", "tout", "toute", "tous", "toutes",
    "qui", "que", "se", "peut", "fait", "faisait", "faisaient",
    # Elided articles/prepositions, as in l'application or d'ouvrir.
    "l", "d", "qu", "lorsqu", "puisqu", "jusqu",
}


def fingerprint(summary_en: str, commands: list) -> str:
    """Cover English prose and the command set, never Japanese release notes."""
    return sha256_text(json.dumps(
        [summary_en, sorted(set(commands or []))], ensure_ascii=False, separators=(",", ":")
    ))


def _words(text):
    return re.findall(r"[^\W\d_]+", unicodedata.normalize("NFKC", text).casefold())


def validate_translation(summary_fr, en_record):
    errors, warnings = validate_structure(summary_fr, en_record, localize_url=lambda u: u)
    if not isinstance(summary_fr, str) or len(summary_fr.strip()) < 10:
        return errors, warnings
    text = summary_fr.strip()
    en = en_record["summary"]
    plain = _strip_markup(text)
    words = _words(plain)
    if words == _words(_strip_markup(en)):
        errors.append("summary is identical to the English summary")
    elif not (set(words) & FRENCH_WORDS):
        errors.append("summary does not look like French")

    lost = sorted(set(DIGITS_RE.findall(_strip_markup(en))) - set(DIGITS_RE.findall(plain)))
    if lost:
        warnings.append(f"numbers from the English summary missing: {lost[:5]}")
    return errors, warnings
