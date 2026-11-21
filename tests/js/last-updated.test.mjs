import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { formatLastUpdated, showLastUpdated } from "../../docs/src/last-updated.js";
import { LOCALES } from "../../docs/src/i18n.js";

const ISO = "2026-11-21T06:02:47.000Z";

test("formats date and time per locale, in the requested time zone", () => {
  assert.equal(formatLastUpdated(ISO, "en", "UTC"), "Nov 21, 2026, 6:02 AM");
  assert.match(formatLastUpdated(ISO, "ja", "UTC"), /2026/);
  assert.match(formatLastUpdated(ISO, "fr", "UTC"), /^21 nov\. 2026/);
  assert.equal(formatLastUpdated(ISO, "en", "Asia/Tokyo"), "Nov 21, 2026, 3:02 PM");
});

test("missing or invalid timestamps give null", () => {
  for (const bad of [undefined, null, "", "not a date", 12345, {}]) {
    assert.equal(formatLastUpdated(bad, "en", "UTC"), null);
  }
});

test("every locale has a lastUpdated template that includes the date", () => {
  for (const [lang, locale] of Object.entries(LOCALES)) {
    assert.match(locale.t.lastUpdated("X"), /X/, lang);
  }
});

test("the shipped last-updated.json is valid", async () => {
  const { crawled_at: iso } = JSON.parse(await readFile(new URL("../../docs/data/last-updated.json", import.meta.url)));
  assert.ok(formatLastUpdated(iso, "en", "UTC"));
});

test("showLastUpdated fills and reveals the element, and stays hidden on failure", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const el = { hidden: true, textContent: "", title: "" };
    globalThis.fetch = async () => new Response(JSON.stringify({ crawled_at: ISO }));
    await showLastUpdated(el, "https://example.test/x.json", "en", (d) => `Data last updated: ${d}`);
    assert.equal(el.hidden, false);
    assert.match(el.textContent, /^Data last updated: .*2026/);
    assert.equal(el.title, ISO);

    for (const fetchImpl of [
      async () => new Response("nope", { status: 404 }),
      async () => new Response("{not json"),
      async () => { throw new Error("offline"); },
      async () => new Response(JSON.stringify({ crawled_at: "garbage" })),
    ]) {
      const quiet = { hidden: true, textContent: "", title: "" };
      globalThis.fetch = fetchImpl;
      await showLastUpdated(quiet, "https://example.test/x.json", "en", (d) => d);
      assert.equal(quiet.hidden, true);
      assert.equal(quiet.textContent, "");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
