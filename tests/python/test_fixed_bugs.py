import os
import sys
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "update"))

import crawl
import parse
from common import BASE_URL, build_candidates, listing_url


RELEASE = """<h1>All Products 21.2 <span>- Fixed bugs</span></h1>
<th class="title 4D">ACI0106220</th>
<td class="description">Bad display of &#39;user and groups&#39; editor.</td>
<td class="version"><a href="../../versions/21_R4/">21 R4</a>
<a href="../../versions/21.1_HF2/">21.1 HF2</a></td>"""

NIGHTLY = """<h1>Nightly builds 4D 21 R4: <span>11 bugs fixed</span></h1>
<td class="title">100222</td><td class="title">30/10/2026</td>
<td class="title">ACI0106657</td>
<td class="description">Form objects flicker.</td>
<td class="description"><a href="../../nightly/21/">21</a></td>"""


class ListingURLs(unittest.TestCase):
    def setUp(self):
        crawl._cooldown_until = 0.0

    def test_release_and_nightly_paths(self):
        for source, version, path in [
            ("version", "21.2", "versions/21.2/"),
            ("version", "21.1_hf2", "versions/21.1_HF2/"),
            ("version", "20_r10_hf1", "versions/20_R10_HF1/"),
            ("branch", "21", "nightly/21/"),
            ("branch", "21_r4", "nightly/21_R4/"),
        ]:
            with self.subTest(source=source, version=version):
                self.assertEqual(listing_url(source, version), f"{BASE_URL}/{path}")

    def test_fetch_uses_new_url_and_follows_redirects(self):
        with patch("crawl.subprocess.run") as run:
            run.return_value.returncode = 0
            run.return_value.stdout = (NIGHTLY + "\n200").encode()
            self.assertEqual(crawl.fetch("branch", "21_r4"), (200, NIGHTLY))
            args = run.call_args.args[0]
            self.assertIn("-L", args)
            self.assertEqual(args[-1], f"{BASE_URL}/nightly/21_R4/")

    def test_fetch_retries_transient_http_errors(self):
        def result(body, code):
            return unittest.mock.Mock(returncode=0, stdout=f"{body}\n{code}".encode())
        with patch("crawl.subprocess.run") as run, patch("crawl.time.sleep") as sleep:
            run.side_effect = [result("busy", 503), result("busy", 429), result(NIGHTLY, 200)]
            self.assertEqual(crawl.fetch("branch", "21_r4"), (200, NIGHTLY))
            self.assertEqual(run.call_count, 3)
            self.assertEqual(sleep.call_count, 2)

    def test_fetch_returns_persistent_transient_error(self):
        with patch("crawl.subprocess.run") as run, patch("crawl.time.sleep"):
            run.return_value.returncode = 0
            run.return_value.stdout = b"busy\n503"
            self.assertEqual(crawl.fetch("version", "21.1", attempts=3), (503, "busy"))
            self.assertEqual(run.call_count, 3)

    def test_transient_error_pauses_every_worker(self):
        with patch("crawl.time.monotonic", return_value=100.0), patch("crawl.time.sleep") as sleep:
            crawl._start_cooldown(8)
            crawl._wait_for_cooldown()
            sleep.assert_called_once_with(8.0)

    def test_fetch_does_not_retry_404(self):
        with patch("crawl.subprocess.run") as run, patch("crawl.time.sleep") as sleep:
            run.return_value.returncode = 0
            run.return_value.stdout = b"<h1>404</h1>\n404"
            self.assertEqual(crawl.fetch("version", "21.9"), (404, "<h1>404</h1>"))
            self.assertEqual(run.call_count, 1)
            sleep.assert_not_called()


class ListingParsing(unittest.TestCase):
    def test_release_cross_version_links(self):
        rows, malformed = parse.parse_file("version", "21.2", RELEASE)
        self.assertEqual(malformed, [])
        self.assertEqual(rows, [{
            "reference": "ACI0106220",
            "summary": "Bad display of 'user and groups' editor.",
            "versions": {"21.2", "21_r4", "21.1_hf2"},
        }])

    def test_nightly_layout_and_links(self):
        rows, malformed = parse.parse_file("branch", "21_r4", NIGHTLY)
        self.assertEqual(malformed, [])
        self.assertEqual(rows[0]["reference"], "ACI0106657")
        self.assertEqual(rows[0]["versions"], {"21_r4", "21"})

    def test_legacy_cached_and_absolute_links(self):
        links = """<a href="/fixes?version=20_r10_hf1">legacy</a>
        <a href="/FixedBugsList/versions/21.1_HF2/">root relative</a>
        <a href="https://developer.4d.com/FixedBugsList/nightly/21_R4/">absolute</a>
        <a href="../../versions/18.3_nb_257605/">internal artifact</a>"""
        content = RELEASE[:RELEASE.index('<td class="version">')]
        content += f'<td class="version">{links}</td>'
        rows, _ = parse.parse_file("version", "21.2", content)
        self.assertEqual(rows[0]["versions"], {"21.2", "20_r10_hf1", "21.1_hf2", "21_r4"})


class CrawlDiscovery(unittest.TestCase):
    def test_classifies_real_and_empty_listings(self):
        self.assertEqual(crawl.classify("version", RELEASE), (True, 1))
        self.assertEqual(crawl.classify("branch", NIGHTLY), (True, 1))
        self.assertEqual(crawl.classify("version", "<h1>All Products 21.2</h1>"), (True, 0))
        self.assertEqual(crawl.classify("branch", "<h1>Nightly builds 4D 21:</h1>"), (True, 0))

    def test_404_is_not_a_valid_listing_even_with_a_heading(self):
        for source in ("version", "branch"):
            self.assertEqual(crawl.classify(source, "<h1>404</h1>", 404), (False, 0))

    def test_legacy_missing_page(self):
        self.assertEqual(crawl.classify("version", '<div class="standard_error">Missing</div>'), (False, 0))
        beta = ("<h1>Information</h1><p>The v21 R5 version is still in Beta. "
                "A bug list will be available when this version will be released.</p>")
        self.assertEqual(crawl.classify("version", beta), (False, 0))
        with self.assertRaises(RuntimeError):
            crawl.classify("version", "<h1>Information</h1><p>Something else.</p>")
        self.assertEqual(crawl.classify("branch", ""), (False, 0))

    def test_http_and_unexpected_html_errors_are_explicit(self):
        for source in ("version", "branch"):
            for code in (301, 403, 429, 500, 503):
                with self.subTest(source=source, code=code), self.assertRaises(RuntimeError):
                    crawl.classify(source, RELEASE, code)
            with self.assertRaises(RuntimeError):
                crawl.classify(source, "<h1>Service unavailable</h1>")
        with self.assertRaises(RuntimeError):
            crawl.classify("version", "")

    def test_migration_reprobes_cached_negative_results_once(self):
        state = {
            "majors": [21],
            "pages": {"version:21.9": {"status": "not_found"}},
        }
        self.assertEqual(crawl.select_candidates(state, False), build_candidates([21]))
        state["listing_base_url"] = BASE_URL
        self.assertNotIn(("version", "21.9"), crawl.select_candidates(state, False))
        self.assertEqual(crawl.select_candidates(state, True), build_candidates([21]))

    def test_404_removes_stale_html_and_persists_migration_marker(self):
        state = {"pages": {}, "counts": {}}
        with tempfile.TemporaryDirectory() as tmp:
            exists = os.path.join(tmp, "exists")
            missing = os.path.join(tmp, "notfound")
            os.makedirs(os.path.join(exists, "version"))
            stale = os.path.join(exists, "version", "21.2.html")
            with open(stale, "w") as f:
                f.write(RELEASE)
            with (
                patch.object(crawl, "EXISTS_DIR", exists),
                patch.object(crawl, "NOTFOUND_DIR", missing),
                patch.object(crawl, "load_state", return_value=state),
                patch.object(crawl, "select_candidates", return_value=[("version", "21.2")]),
                patch.object(crawl, "fetch", return_value=(404, "<h1>404</h1>")),
                patch.object(crawl, "save_state") as save,
                patch.object(crawl, "write_log"),
            ):
                crawl.crawl(full=False, workers=1)
            self.assertFalse(os.path.exists(stale))
            self.assertTrue(os.path.exists(os.path.join(missing, "version", "21.2.html")))
            self.assertEqual(state["pages"]["version:21.2"]["status"], "not_found")
            self.assertEqual(save.call_args.args[0]["listing_base_url"], BASE_URL)


class KeepPreviousData(unittest.TestCase):
    def old(self, ref, versions, variants=("old text",)):
        return {"reference": ref, "raw_summary": variants[0],
                "raw_summary_variants": list(variants), "versions": versions}

    def test_bug_missing_from_crawl_is_carried_over(self):
        records = {}
        carried, extended = parse.merge_previous(records, [self.old("ACI0000001", ["18_r5", "18.3"])])
        self.assertEqual((carried, extended), (1, 0))
        self.assertEqual(records["ACI0000001"]["versions"], {"18_r5", "18.3"})
        self.assertEqual(records["ACI0000001"]["summaries"], {"old text"})

    def test_crawled_bug_keeps_new_text_and_gains_old_versions(self):
        records = {"ACI0000002": {"versions": {"21.2"}, "summaries": {"new text"}}}
        carried, extended = parse.merge_previous(
            records, [self.old("ACI0000002", ["18.2", "21.2"], ("old text",))])
        self.assertEqual((carried, extended), (0, 1))
        self.assertEqual(records["ACI0000002"]["versions"], {"18.2", "21.2"})
        self.assertEqual(records["ACI0000002"]["summaries"], {"new text"})

    def test_invalid_references_and_versions_are_dropped(self):
        records = {}
        parse.merge_previous(records, [
            self.old("NOT-AN-ACI", ["18"]),
            self.old("ACI0000003", ["18", "18.3_nb_257605"]),
        ])
        self.assertEqual(list(records), ["ACI0000003"])
        self.assertEqual(records["ACI0000003"]["versions"], {"18"})

    def test_missing_or_corrupt_previous_file_is_empty(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(parse.load_previous(os.path.join(d, "none.json")), [])
            bad = os.path.join(d, "bad.json")
            open(bad, "w").write("{not json")
            self.assertEqual(parse.load_previous(bad), [])
