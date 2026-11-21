import io
import json
import os
import sys
import unittest
import urllib.error
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "update"))

import automate
from automate import ApiError, openai_complete, write_records


def rec(n):
    return {"reference": f"ACI000000{n}", "raw_summary": f"bug {n}"}


class WriteRecords(unittest.TestCase):
    def test_valid_output_is_accepted_first_time(self):
        calls = []

        def ask(batch):
            calls.append(batch)
            return [{"reference": r["reference"], "summary": "ok"} for r in batch]

        ok, bad = write_records([rec(1), rec(2)], ask, lambda item: ([], []))
        self.assertEqual(set(ok), {"ACI0000001", "ACI0000002"})
        self.assertEqual(bad, {})
        self.assertEqual(len(calls), 1)

    def test_failed_record_is_retried_with_its_problems_and_only_that_record(self):
        calls = []

        def ask(batch):
            calls.append(batch)
            return [{"reference": r["reference"], "summary": "bad" if len(calls) == 1 and r["reference"].endswith("2") else "good"}
                    for r in batch]

        check = lambda item: (["summary is bad"], []) if item["summary"] == "bad" else ([], [])
        ok, bad = write_records([rec(1), rec(2)], ask, check)
        self.assertEqual(set(ok), {"ACI0000001", "ACI0000002"})
        self.assertEqual(len(calls), 2)
        self.assertEqual([r["reference"] for r in calls[1]], ["ACI0000002"])
        self.assertEqual(calls[1][0]["problems"], ["summary is bad"])
        self.assertEqual(calls[1][0]["previous_attempt"]["summary"], "bad")

    def test_gives_up_after_the_attempt_limit_and_leaves_it_pending(self):
        ask = lambda batch: [{"reference": r["reference"], "summary": "bad"} for r in batch]
        ok, bad = write_records([rec(1)], ask, lambda item: (["nope"], []), attempts=3)
        self.assertEqual(ok, {})
        self.assertEqual(bad, {"ACI0000001": ["nope"]})

    def test_record_missing_from_the_response_is_retried(self):
        state = {"n": 0}

        def ask(batch):
            state["n"] += 1
            return [] if state["n"] == 1 else [{"reference": r["reference"], "summary": "x"} for r in batch]

        ok, bad = write_records([rec(1)], ask, lambda item: ([], []))
        self.assertEqual(set(ok), {"ACI0000001"})
        self.assertEqual(state["n"], 2)

    def test_warnings_retry_and_are_tolerated_only_on_the_last_attempt_when_allowed(self):
        ask = lambda batch: [{"reference": r["reference"], "summary": "w"} for r in batch]
        check = lambda item: ([], ["a warning"])
        ok, bad = write_records([rec(1)], ask, check, accept_warnings=True, attempts=2)
        self.assertEqual(set(ok), {"ACI0000001"})
        ok, bad = write_records([rec(1)], ask, check, accept_warnings=False, attempts=2)
        self.assertEqual(ok, {})
        self.assertEqual(bad["ACI0000001"], ["a warning"])

    def test_api_error_leaves_everything_pending(self):
        def ask(batch):
            raise ApiError("HTTP 500")

        ok, bad = write_records([rec(1), rec(2)], ask, lambda item: ([], []))
        self.assertEqual(ok, {})
        self.assertEqual(set(bad), {"ACI0000001", "ACI0000002"})
        self.assertIn("API error", bad["ACI0000001"][0])


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def reply(items, tokens=7):
    body = {"choices": [{"message": {"content": json.dumps({"items": items})}}], "usage": {"total_tokens": tokens}}
    return FakeResponse(json.dumps(body).encode())


SCHEMA = {"type": "object", "additionalProperties": False, "required": ["reference"], "properties": {"reference": {"type": "string"}}}


class Client(unittest.TestCase):
    def test_request_shape_and_result(self):
        seen = {}

        def fake(request, timeout=0):
            seen["url"] = request.full_url
            seen["auth"] = request.get_header("Authorization")
            seen["body"] = json.loads(request.data)
            return reply([{"reference": "ACI0000001"}], tokens=42)

        with patch("urllib.request.urlopen", fake):
            items, tokens = openai_complete("SYS", [rec(1)], SCHEMA, key="sk-test", model="some-model")
        self.assertEqual(items, [{"reference": "ACI0000001"}])
        self.assertEqual(tokens, 42)
        self.assertEqual(seen["url"], "https://api.openai.com/v1/chat/completions")
        self.assertEqual(seen["auth"], "Bearer sk-test")
        self.assertEqual(seen["body"]["model"], "some-model")
        self.assertEqual(seen["body"]["messages"][0], {"role": "system", "content": "SYS"})
        schema = seen["body"]["response_format"]["json_schema"]
        self.assertTrue(schema["strict"])
        self.assertEqual(schema["schema"]["required"], ["items"])
        self.assertNotIn("temperature", seen["body"])

    def test_rate_limit_is_retried_then_succeeds(self):
        state = {"n": 0}

        def fake(request, timeout=0):
            state["n"] += 1
            if state["n"] == 1:
                raise urllib.error.HTTPError("u", 429, "slow", {}, io.BytesIO(b'{"error":{"message":"rate"}}'))
            return reply([])

        with patch("urllib.request.urlopen", fake), patch("time.sleep") as sleep:
            items, _ = openai_complete("S", [], SCHEMA, key="sk-test", model="m")
        self.assertEqual(items, [])
        self.assertEqual(state["n"], 2)
        sleep.assert_called_once()

    def test_auth_error_fails_fast_and_never_echoes_the_key(self):
        body = b'{"error":{"message":"Incorrect API key provided: sk-secretvalue123."}}'

        def fake(request, timeout=0):
            raise urllib.error.HTTPError("u", 401, "no", {}, io.BytesIO(body))

        with patch("urllib.request.urlopen", fake), patch("time.sleep") as sleep:
            with self.assertRaises(ApiError) as ctx:
                openai_complete("S", [], SCHEMA, key="sk-secretvalue123", model="m")
        self.assertNotIn("secretvalue", str(ctx.exception))
        self.assertIn("401", str(ctx.exception))
        sleep.assert_not_called()

    def test_refusal_and_bad_shapes_raise(self):
        for content in (
            {"choices": [{"message": {"refusal": "I can't", "content": None}}]},
            {"choices": []},
            {"choices": [{"message": {"content": "not json"}}]},
            {"choices": [{"message": {"content": json.dumps({"items": "nope"})}}]},
        ):
            with patch("urllib.request.urlopen", lambda r, timeout=0, c=content: FakeResponse(json.dumps(c).encode())):
                with self.assertRaises(ApiError):
                    openai_complete("S", [], SCHEMA, key="k", model="m")


class Main(unittest.TestCase):
    def test_not_configured_does_nothing_and_exits_3(self):
        for env in ({}, {"OPENAI_API_KEY": "k"}, {"OPENAI_MODEL": "m"}):
            with patch.dict(os.environ, env, clear=True):
                self.assertEqual(automate.main(), automate.EXIT_NOT_CONFIGURED)


if __name__ == "__main__":
    unittest.main()
