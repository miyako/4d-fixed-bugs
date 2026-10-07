import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "update"))

from ja_common import fingerprint, is_polite, to_ja_url, validate_translation  # noqa: E402

EN = {
    "reference": "ACI0000001",
    "summary": "Calling [Print form](https://developer.4d.com/docs/commands/print-form) with a `&nbsp;` entity "
    "could crash the application, raising error 106.",
    "commands": ["Print form"],
}
GOOD = (
    "`&nbsp;`を含む状態で[Print form](https://developer.4d.com/docs/ja/commands/print-form)を呼び出すと、"
    "エラー 106 が発生し、アプリケーションがクラッシュすることがありました。"
)


class ToJaUrl(unittest.TestCase):
    def test_moves_docs_under_ja(self):
        self.assertEqual(
            to_ja_url("https://developer.4d.com/docs/WritePro/commands/wp-new"),
            "https://developer.4d.com/docs/ja/WritePro/commands/wp-new",
        )

    def test_idempotent_and_other_hosts_untouched(self):
        self.assertEqual(to_ja_url("https://developer.4d.com/docs/ja/commands/x"), "https://developer.4d.com/docs/ja/commands/x")
        self.assertEqual(to_ja_url("https://example.com/docs/x"), "https://example.com/docs/x")


class Fingerprint(unittest.TestCase):
    def test_order_insensitive_over_notes(self):
        self.assertEqual(fingerprint("s", ["a", "b"]), fingerprint("s", ["b", "a", "a"]))

    def test_changes_with_either_source(self):
        base = fingerprint("s", ["a"])
        self.assertNotEqual(base, fingerprint("s2", ["a"]))
        self.assertNotEqual(base, fingerprint("s", ["a2"]))


class Polite(unittest.TestCase):
    def test_polite_endings(self):
        for s in ["クラッシュしていました。", "返されませんでした。", "仕様です。", "修正されました（Windows のみ）。"]:
            self.assertTrue(is_polite(s), s)

    def test_plain_endings(self):
        for s in ["クラッシュした。", "Windows版のみ。", "仕様である。"]:
            self.assertFalse(is_polite(s), s)


class Validate(unittest.TestCase):
    def check(self, text):
        return validate_translation(text, EN)

    def test_good_translation_passes_cleanly(self):
        self.assertEqual(self.check(GOOD), ([], []))

    def test_link_must_be_localized(self):
        errors, _ = self.check(GOOD.replace("/docs/ja/", "/docs/"))
        self.assertTrue(any("missing link" in e for e in errors))
        self.assertTrue(any("not localized" in e for e in errors))

    def test_link_text_must_stay_english(self):
        errors, _ = self.check(GOOD.replace("[Print form]", "[フォーム印刷]"))
        self.assertTrue(any("missing link" in e for e in errors))

    def test_foreign_link_rejected(self):
        errors, _ = self.check(GOOD + "[x](https://example.com/)")
        self.assertTrue(any("not on developer.4d.com" in e for e in errors))

    def test_code_span_preserved(self):
        errors, _ = self.check(GOOD.replace("`&nbsp;`", "&nbsp;"))
        self.assertTrue(any("code span" in e for e in errors))

    def test_untranslated_rejected(self):
        errors, _ = self.check(EN["summary"].replace("/docs/", "/docs/ja/"))
        self.assertIn("summary does not look like Japanese", errors)

    def test_markdown_subset(self):
        errors, _ = self.check("**重要** " + GOOD)
        self.assertTrue(any("disallowed markdown" in e for e in errors))
        errors, _ = self.check(GOOD + "\n" + GOOD)
        self.assertIn("summary must be a single paragraph", errors)

    def test_aci_references_must_match(self):
        errors, _ = self.check(GOOD + "ACI0000002 と同じです。")
        self.assertIn("ACI references differ from the English summary", errors)

    def test_warnings(self):
        _, warnings = self.check(GOOD.replace("ありました。", "あった。"))
        self.assertTrue(any("polite" in w for w in warnings))
        _, warnings = self.check(GOOD.replace("106", "百六"))
        self.assertTrue(any("numbers" in w for w in warnings))

    def test_commands_only_required_when_english_mentions_them(self):
        en = dict(EN, commands=["Print form", "WEB Server"])
        self.assertEqual(validate_translation(GOOD, en), ([], []))
        errors, _ = validate_translation(GOOD.replace("[Print form](https://developer.4d.com/docs/ja/commands/print-form)", "印刷"), en)
        self.assertIn("command 'Print form' not mentioned verbatim", errors)

    def test_too_short(self):
        self.assertEqual(self.check("短い")[0], ["summary missing or too short"])


if __name__ == "__main__":
    unittest.main()
