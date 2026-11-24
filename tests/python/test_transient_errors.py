"""HTTP 5xx from GitHub (Pages, api.github.com) must not end a dataset run.

developer.4d.com is served by GitHub Pages, which answers 503 under load — a
weekly run used to die when a single one of ~700 listings did. These tests pin
down the policy: a page that says "busy" is retried, then reported as
*unresolved* and left alone, and only a site-wide outage fails the crawl.
"""
import io
import os
import sys
import tempfile
import unittest
import unittest.mock
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "update"))

import check_links
import crawl
import sync_jp

RELEASE = """<h1>All Products 21.2 <span>- Fixed bugs</span></h1>
<th class="title 4D">ACI0106220</th>
<td class="description">Bad display of &#39;user and groups&#39; editor.</td>
<td class="version"><a href="../../versions/21_R4/">21 R4</a></td>"""


class TransientFailures(unittest.TestCase):
    def setUp(self):
        crawl._cooldown_until = 0.0

    def test_5xx_is_transient_and_other_statuses_are_not(self):
        for code in (429, 500, 502, 503, 504):
            with self.subTest(code=code), self.assertRaises(crawl.TransientError):
                crawl.classify("version", "busy", code)
        for code in (301, 401, 403, 410):
            with self.subTest(code=code), self.assertRaises(RuntimeError) as ctx:
                crawl.classify("version", "nope", code)
            self.assertNotIsInstance(ctx.exception, crawl.TransientError)
        # Unrecognized HTML is a source-format problem, never transient.
        with self.assertRaises(RuntimeError) as ctx:
            crawl.classify("version", "<h1>Service unavailable</h1>")
        self.assertNotIsInstance(ctx.exception, crawl.TransientError)

    def test_curl_that_never_answers_is_transient(self):
        with patch("crawl.subprocess.run") as run, patch("crawl.time.sleep"):
            run.return_value = unittest.mock.Mock(
                returncode=28, stdout=b"", stderr=b"curl: (28) timed out")
            with self.assertRaises(crawl.TransientError):
                crawl.fetch("version", "21.2", attempts=2)

    def test_probe_reports_a_busy_page_without_touching_the_files(self):
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(crawl, "EXISTS_DIR", os.path.join(tmp, "exists")),
            patch.object(crawl, "NOTFOUND_DIR", os.path.join(tmp, "notfound")),
            patch.object(crawl, "fetch", return_value=(503, "Service unavailable")),
        ):
            result = crawl.probe(("version", "21.2"))
            self.assertEqual(result["status"], "unresolved")
            self.assertIn("503", result["error"])
            self.assertEqual(os.listdir(tmp), [])

    def test_unresolved_page_keeps_its_previous_state(self):
        state = {
            "pages": {"version:21.2": {"status": "found", "hash": "abc", "bug_count": 40}},
            "counts": {},
        }
        with (
            tempfile.TemporaryDirectory() as tmp,
            patch.object(crawl, "EXISTS_DIR", os.path.join(tmp, "exists")),
            patch.object(crawl, "NOTFOUND_DIR", os.path.join(tmp, "notfound")),
            patch.object(crawl, "load_state", return_value=state),
            patch.object(crawl, "select_candidates",
                         return_value=[("version", "21.2"), ("version", "21.1")]),
            patch.object(crawl, "fetch", side_effect=[(503, "busy"), (200, RELEASE)]),
            patch.object(crawl, "retry_unresolved", side_effect=lambda results: results),
            patch.object(crawl, "save_state"),
            patch.object(crawl, "write_log") as log,
        ):
            crawl.crawl(full=False, workers=1)

        # The throttled page is untouched — a page we could not read did not
        # disappear, and its 40 bugs must stay in the dataset.
        self.assertEqual(state["pages"]["version:21.2"],
                         {"status": "found", "hash": "abc", "bug_count": 40})
        self.assertEqual(state["last_crawl"]["unresolved"], ["version:21.2"])
        self.assertEqual(state["pages"]["version:21.1"]["status"], "found")
        # The carried-over page still counts as published content.
        self.assertEqual(state["counts"]["pages_found"], 2)
        self.assertEqual([r["version"] for r in log.call_args.args[0]], ["21.1"])

    def test_retry_pass_recovers_pages_one_at_a_time(self):
        results = [
            {"source": "version", "version": "21.1", "status": "found", "bug_count": 1},
            {"source": "version", "version": "21.2", "status": "unresolved", "error": "HTTP 503"},
        ]
        recovered = {"source": "version", "version": "21.2", "status": "found",
                     "bug_count": 2, "http_code": 200, "bytes": 10, "hash": "h"}
        with patch.object(crawl, "probe", return_value=recovered) as probe, \
             patch("crawl.time.sleep") as sleep:
            out = crawl.retry_unresolved(results, delays=(20, 60))
        self.assertEqual([r["status"] for r in out], ["found", "found"])
        self.assertEqual(out[1]["bug_count"], 2)
        probe.assert_called_once_with(("version", "21.2"), attempts=4)
        sleep.assert_called_once_with(20)

    def test_a_dead_site_trips_the_breaker_instead_of_grinding(self):
        crawl.reset_breaker()
        busy = {"source": "version", "version": "21.2", "status": "unresolved",
                "error": "HTTP 503"}
        with patch.object(crawl, "fetch",
                          side_effect=crawl.TransientError("failed to fetch: HTTP 503")) as fetch:
            for _ in range(crawl.FAILURE_PATIENCE):
                self.assertEqual(crawl.probe(("version", "21.2"))["status"], "unresolved")
            self.assertTrue(crawl._abort.is_set())
            calls = fetch.call_count
            # Once tripped, the remaining candidates cost nothing: no request,
            # no backoff — the run fails fast and reports an outage.
            blocked = crawl.probe(("version", "21.3"))
        self.assertEqual(blocked["status"], "unresolved")
        self.assertIn("not attempted", blocked["error"])
        self.assertEqual(fetch.call_count, calls)
        crawl.reset_breaker()

    def test_verdict_warns_for_a_few_pages_and_fails_an_outage(self):
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            self.assertEqual(crawl.verdict(719, []), 0)
            self.assertEqual(crawl.verdict(719, ["version:21.2"]), 0)
            self.assertIn("WARNING", err.getvalue())
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            self.assertEqual(crawl.verdict(719, [f"version:21.{i}" for i in range(144)]), 1)
            self.assertIn("ERROR", err.getvalue())


class LinkCheckResilience(unittest.TestCase):
    def test_busy_link_is_retried_then_accepted(self):
        bad = unittest.mock.Mock(stdout="503")
        good = unittest.mock.Mock(stdout="200")
        with patch("check_links.subprocess.run", side_effect=[bad, good]) as run, \
             patch("check_links.time.sleep") as sleep:
            self.assertEqual(check_links.check("https://developer.4d.com/x"), 200)
        self.assertEqual(run.call_count, 2)
        sleep.assert_called_once()

    def test_definitive_404_is_not_retried(self):
        with patch("check_links.subprocess.run",
                   return_value=unittest.mock.Mock(stdout="404")) as run, \
             patch("check_links.time.sleep"):
            self.assertEqual(check_links.check("https://developer.4d.com/x"), 404)
        self.assertEqual(run.call_count, 1)

    def test_busy_links_are_not_cached_and_do_not_break_the_build(self):
        links = {"ok": ["ACI0000001"], "gone": ["ACI0000002"], "busy": ["ACI0000003"]}
        results = {"ok": 200, "gone": 404, "busy": 503}
        broken, unverified, cache = check_links.classify_results(links, results)
        self.assertEqual(broken, [("gone", 404)])
        self.assertEqual(unverified, ["busy"])
        self.assertEqual(cache, {"ok": 200, "gone": 404})


class JapanSyncResilience(unittest.TestCase):
    def test_git_command_is_retried(self):
        ok = unittest.mock.Mock(returncode=0, stdout="deadbeef\n", stderr="")
        bad = unittest.mock.Mock(returncode=128, stdout="", stderr="HTTP 503")
        with patch("sync_jp.subprocess.run", side_effect=[bad, bad, ok]) as run, \
             patch("sync_jp.time.sleep") as sleep:
            self.assertEqual(sync_jp.run(["git", "fetch"], attempts=3, delays=(5, 15)),
                             "deadbeef")
        self.assertEqual(run.call_count, 3)
        self.assertEqual(sleep.call_count, 2)

    def test_unreachable_github_falls_back_to_the_existing_checkout(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, "blog", ".git"))
            def fake_run(cmd, cwd=None, attempts=1, delays=()):
                if "fetch" in cmd:
                    raise RuntimeError("git fetch failed: HTTP 503")
                return "deadbeef"
            with patch.object(sync_jp, "VENDOR_DIR", tmp), \
                 patch.object(sync_jp, "run", side_effect=fake_run), \
                 patch("sys.stderr", new_callable=io.StringIO) as err:
                self.assertEqual(sync_jp.sync_repo("blog", "https://example.invalid"), "deadbeef")
            self.assertIn("WARNING", err.getvalue())


if __name__ == "__main__":
    unittest.main()
