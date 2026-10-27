import contextlib
import copy
import io
import os
import sys
import unittest
from unittest.mock import mock_open, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "update"))

import build_translation
import bump_cache_bust
import check_links
import merge_translation
import split_pending
from common import (
    CONTEXT_PATH, DATA_DIR, ENRICHED_PATH, FR_PATH, JA_PATH,
    PENDING_TRANSLATION_FR_PATH, PENDING_TRANSLATION_PATH,
)
from fr_common import fingerprint, validate_translation
from ja_common import fingerprint as ja_fingerprint

EN = {
    "reference": "ACI0000001",
    "summary": "Calling [Print form](https://developer.4d.com/docs/commands/print-form) "
    "with `&nbsp;` could crash with error 106, as in ACI0000002.",
    "commands": ["Print form"],
}
GOOD = (
    "L'appel de [Print form](https://developer.4d.com/docs/commands/print-form) "
    "avec `&nbsp;` pouvait provoquer un plantage avec l'erreur 106, comme dans ACI0000002."
)


class FrenchValidation(unittest.TestCase):
    def test_good_and_no_accents(self):
        self.assertEqual(validate_translation(GOOD, EN), ([], []))
        en = dict(EN, summary="The server could crash.", commands=[])
        self.assertEqual(validate_translation("Le serveur pouvait planter.", en), ([], []))

    def test_legacy_write_crash_with_elision_and_no_accents(self):
        link = "[WP New](https://developer.4d.com/docs/WritePro/commands/wp-new)"
        en = {
            "reference": "ACI0102698",
            "summary": f"Passing some legacy 4D Write documents to {link} crashed the application.",
            "commands": ["WP New"],
        }
        summary = f"Passer certains anciens documents 4D Write à {link} faisait planter l'application."
        self.assertEqual(validate_translation(summary, en), ([], []))
        self.assertEqual(validate_translation(
            f"Passer certains anciens documents 4D Write via {link} faisait planter l'application.", en
        ), ([], []))
        # A French elision alone can be the language signal; accents are irrelevant.
        self.assertEqual(validate_translation(
            "Impossible d'ouvrir Windows.", dict(en, summary="Cannot open Windows.", commands=[])
        ), ([], []))
        self.assertEqual(validate_translation(
            "Impossible d’ouvrir Windows.", dict(en, summary="Cannot open Windows.", commands=[])
        ), ([], []))
        self.assertTrue(any("identical" in e for e in validate_translation(en["summary"], en)[0]))

    def test_project_mode_export_crash(self):
        link = "[EXPORT DIF](https://developer.4d.com/docs/commands/export-dif)"
        en = {
            "reference": "ACI0100300",
            "summary": f"In Project mode only, executing {link} crashed the application.",
            "commands": ["EXPORT DIF"],
        }
        summary = f"En mode Projet uniquement, exécuter {link} faisait planter l'application."
        self.assertEqual(validate_translation(summary, en), ([], []))
        self.assertEqual(validate_translation(
            "En mode Projet uniquement, export impossible.",
            dict(en, summary="In Project mode only, export is impossible.", commands=[]),
        ), ([], []))

    def test_identical_english_even_with_french_homographs(self):
        en = dict(EN, summary="A bug in la documentation could crash the server.", commands=[])
        errors, _ = validate_translation(en["summary"], en)
        self.assertTrue(any("identical" in e for e in errors))
        errors, _ = validate_translation(en["summary"].upper(), en)
        self.assertTrue(any("identical" in e for e in errors))

    def test_non_french_and_missing(self):
        for value in (None, {}, "", "x", "サーバーがクラッシュすることがありました。", "The server would unexpectedly crash."):
            self.assertTrue(validate_translation(value, dict(EN, summary="The server could crash.", commands=[]))[0])

    def test_exact_links_and_command_names(self):
        for text in (
            GOOD.replace("/docs/", "/docs/fr/"),
            GOOD.replace("/docs/", "/docs/ja/"),
            GOOD.replace("[Print form]", "[Imprimer formulaire]"),
            GOOD + " [extra](https://example.com/)",
            GOOD + " [extra](https://developer.4d.com/docs/commands/x)",
        ):
            self.assertTrue(validate_translation(text, EN)[0], text)
        errors, _ = validate_translation(GOOD.replace("Print form", "Imprimer formulaire"), EN)
        self.assertIn("command 'Print form' not mentioned verbatim", errors)
        self.assertEqual(validate_translation(GOOD, dict(EN, commands=["Print form", "WEB Server"])), ([], []))

    def test_duplicate_links_preserved(self):
        en = dict(EN, summary=EN["summary"] + " [Print form](https://developer.4d.com/docs/commands/print-form)")
        self.assertTrue(any("missing link" in e for e in validate_translation(GOOD, en)[0]))

    def test_structural_invariants(self):
        for text, expected in (
            (GOOD.replace("`&nbsp;`", "&nbsp;"), "code span"),
            (GOOD.replace("ACI0000002", "ACI0000003"), "ACI references"),
            ("**Attention** " + GOOD, "disallowed markdown"),
            (GOOD + "\n" + GOOD, "single paragraph"),
            ("- " + GOOD, "disallowed markdown"),
        ):
            self.assertTrue(any(expected in e for e in validate_translation(text, EN)[0]), text)
        errors, warnings = validate_translation(GOOD.replace("106", "cent six"), EN)
        self.assertFalse(errors)
        self.assertTrue(any("numbers" in w for w in warnings))

    def test_fingerprint_english_and_commands(self):
        base = fingerprint("English", ["Print form", "WEB Server"])
        self.assertEqual(base, fingerprint("English", ["WEB Server", "Print form", "Print form"]))
        self.assertNotEqual(base, fingerprint("Changed", ["Print form", "WEB Server"]))
        self.assertNotEqual(base, fingerprint("English", ["Print form"]))


class TranslationPipeline(unittest.TestCase):
    """Run CLI entry points with an in-memory filesystem; never touch datasets."""

    def setUp(self):
        self.files = {
            ENRICHED_PATH: [copy.deepcopy(EN)],
            CONTEXT_PATH: [{"reference": EN["reference"], "jp_notes": ["原文"]}],
            JA_PATH: [{"reference": "JA_SENTINEL", "summary": "untouched"}],
            PENDING_TRANSLATION_PATH: [{"reference": "JA_PENDING_SENTINEL"}],
        }
        self.writes = []

    def run_cli(self, module, *args):
        def load(path, default=None):
            return copy.deepcopy(self.files.get(path, default))

        def write(path, value):
            self.files[path] = copy.deepcopy(value)
            self.writes.append(path)

        with patch.object(sys, "argv", [module.__name__, *args]), \
                patch.object(module, "load_json", side_effect=load), \
                patch.object(module, "write_json", side_effect=write), \
                contextlib.redirect_stdout(io.StringIO()) as output:
            result = module.main()
        self.output = output.getvalue()
        return result

    def queue(self):
        self.assertEqual(self.run_cli(build_translation, "--lang", "fr"), 0)

    def batch(self, *items):
        self.files["batch.json"] = list(items) if items else [{"reference": EN["reference"], "summary": GOOD}]

    def test_new_merge_noop_and_language_isolation(self):
        original_ja = copy.deepcopy(self.files[JA_PATH])
        self.queue()
        pending = self.files[PENDING_TRANSLATION_FR_PATH]
        self.assertNotIn("jp_notes", pending[0])
        self.assertNotIn("previous_summary_ja", pending[0])
        self.assertIsNone(pending[0]["previous_summary_fr"])
        self.batch()
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json", "--strict"), 0)
        self.assertEqual(self.files[FR_PATH][0]["summary"], GOOD)
        self.assertEqual(self.files[FR_PATH][0]["source_fingerprint"], pending[0]["fingerprint"])
        self.assertEqual(self.files[PENDING_TRANSLATION_FR_PATH], [])
        self.files[CONTEXT_PATH][0]["jp_notes"] = ["Changed JP notes"]
        self.queue()
        self.assertEqual(self.files[PENDING_TRANSLATION_FR_PATH], [])
        self.assertEqual(self.files[JA_PATH], original_ja)
        self.assertNotIn(JA_PATH, self.writes)
        self.assertNotIn(PENDING_TRANSLATION_PATH, self.writes)

    def test_command_change_requeues_and_guard_is_atomic(self):
        self.queue()
        self.batch()
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json"), 0)
        self.files[ENRICHED_PATH][0]["commands"].append("WEB Server")
        before = copy.deepcopy(self.files)
        self.assertEqual(self.run_cli(build_translation, "--lang", "fr", "--max-pending", "0"), 1)
        self.assertEqual(self.files, before)
        self.queue()
        pending = self.files[PENDING_TRANSLATION_FR_PATH]
        self.assertEqual(pending[0]["reason"], "source-changed")
        self.assertEqual(pending[0]["previous_summary_fr"], GOOD)
        self.assertEqual(self.run_cli(build_translation, "--lang", "fr", "--force-all", "--max-pending", "0"), 0)

    def test_stale_records_removed(self):
        self.files[FR_PATH] = [{"reference": "ACI9999999", "summary": GOOD}]
        self.queue()
        self.assertEqual(self.files[FR_PATH], [])

    def test_stale_pending_rejected_after_summary_or_command_change(self):
        for field, value in (("summary", EN["summary"] + " Changed."), ("commands", ["Different"])):
            with self.subTest(field=field):
                self.files[ENRICHED_PATH] = [copy.deepcopy(EN)]
                self.queue()
                self.batch()
                self.files[ENRICHED_PATH][0][field] = value
                before = copy.deepcopy(self.files)
                self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json"), 1)
                self.assertEqual(self.files, before)

    def test_removed_english_record_rejected_without_traceback(self):
        self.queue()
        self.batch()
        self.files[ENRICHED_PATH] = []
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json"), 1)
        self.assertNotIn(FR_PATH, self.files)

    def test_duplicate_unknown_invalid_batches_are_atomic(self):
        self.queue()
        valid = {"reference": EN["reference"], "summary": GOOD}
        for items in (
            [valid, valid], [{"reference": "ACI9999999", "summary": GOOD}],
            [None], [{"reference": [], "summary": GOOD}], [],
            [dict(valid, summary=EN["summary"])],
        ):
            self.files["batch.json"] = items
            before = copy.deepcopy(self.files)
            self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json"), 1)
            self.assertEqual(self.files, before)

    def test_partial_dry_run_and_strict(self):
        second = dict(EN, reference="ACI0000003")
        self.files[ENRICHED_PATH].append(second)
        self.queue()
        self.batch()
        before = copy.deepcopy(self.files)
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json"), 1)
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json", "--partial", "--dry-run"), 0)
        self.assertEqual(self.files, before)
        self.batch({"reference": EN["reference"], "summary": GOOD.replace("106", "cent six")})
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json", "--partial", "--strict"), 1)
        self.assertEqual(self.files[FR_PATH] if FR_PATH in self.files else [], [])
        self.batch()
        self.assertEqual(self.run_cli(merge_translation, "--lang", "fr", "batch.json", "--partial"), 0)
        self.assertEqual([p["reference"] for p in self.files[PENDING_TRANSLATION_FR_PATH]], [second["reference"]])

    def test_default_japanese_fingerprint_and_context_unchanged(self):
        self.assertEqual(self.run_cli(build_translation), 0)
        pending = self.files[PENDING_TRANSLATION_PATH][0]
        self.assertEqual(pending["jp_notes"], ["原文"])
        self.assertEqual(pending["fingerprint"], ja_fingerprint(EN["summary"], ["原文"]))
        self.assertIn("previous_summary_ja", pending)
        self.assertNotIn(PENDING_TRANSLATION_FR_PATH, self.files)

    def test_default_japanese_merge_unchanged(self):
        self.assertEqual(self.run_cli(build_translation), 0)
        summary = (
            "[Print form](https://developer.4d.com/docs/ja/commands/print-form)で`&nbsp;`を使用すると、"
            "ACI0000002 と同様にエラー 106 が発生してクラッシュすることがありました。"
        )
        self.batch({"reference": EN["reference"], "summary": summary})
        self.assertEqual(self.run_cli(merge_translation, "batch.json", "--strict"), 0)
        self.assertEqual(self.files[JA_PATH][0]["summary"], summary)
        self.assertEqual(self.files[PENDING_TRANSLATION_PATH], [])
        self.assertNotIn(FR_PATH, self.files)

    def test_french_split_uses_own_queue_directory_and_prompt(self):
        self.queue()
        with patch.object(split_pending.os, "makedirs"):
            self.assertEqual(self.run_cli(split_pending, "--kind", "translation", "--lang", "fr"), 0)
        chunk = os.path.join(DATA_DIR, "translation_fr", "chunk_1.json")
        self.assertEqual(self.files[chunk], self.files[PENDING_TRANSLATION_FR_PATH])
        self.assertIn("TRANSLATION_PROMPT_FR.md", self.output)
        self.assertIn("--lang fr", self.output)


class SharedUtilities(unittest.TestCase):
    def test_cache_buster_includes_french_and_uses_shared_maximum(self):
        self.assertTrue(any(p.endswith("docs/fr/index.html") for p in bump_cache_bust.PAGES))
        handles = {}
        for i, path in enumerate(bump_cache_bust.PAGES):
            handles[path] = mock_open(read_data=f'<script src="../src/app.js?v={i + 1}">')

        def open_page(path, *args, **kwargs):
            return handles[path](path, *args, **kwargs)

        with patch.object(bump_cache_bust.os.path, "exists", return_value=True), \
                patch("builtins.open", side_effect=open_page), \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(bump_cache_bust.main(), 0)
        for handle in handles.values():
            handle().write.assert_called_once_with('<script src="../src/app.js?v=4">')

    def test_link_check_uses_french_original_english_urls_and_cache(self):
        url = "https://developer.4d.com/docs/commands/print-form"
        french_only = "https://developer.4d.com/docs/commands/other"
        datasets = {
            ENRICHED_PATH: [EN],
            JA_PATH: [],
            FR_PATH: [{"reference": EN["reference"], "summary": GOOD + f" [other]({french_only})"}],
        }
        state = {"link_checks": {url: 200}}
        with patch.object(sys, "argv", ["check_links"]), \
                patch.object(check_links, "load_json", side_effect=lambda p, d=None: datasets.get(p, d)), \
                patch.object(check_links, "load_state", return_value=state), \
                patch.object(check_links, "save_state") as save, \
                patch.object(check_links, "check", return_value=200) as check, \
                contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(check_links.main(), 0)
        check.assert_called_once_with(french_only)
        self.assertEqual(save.call_args.args[0]["link_checks"], {url: 200, french_only: 200})


if __name__ == "__main__":
    unittest.main()
