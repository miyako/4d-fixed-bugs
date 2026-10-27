"""Language-specific translation configuration; Japanese remains the default."""
from common import JA_PATH, FR_PATH, PENDING_TRANSLATION_PATH, PENDING_TRANSLATION_FR_PATH
import fr_common
import ja_common


def config(lang):
    if lang == "ja":
        return JA_PATH, PENDING_TRANSLATION_PATH, ja_common
    if lang == "fr":
        return FR_PATH, PENDING_TRANSLATION_FR_PATH, fr_common
    raise ValueError(f"Unknown translation language: {lang}")
