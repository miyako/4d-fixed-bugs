import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, getLocale } from "../../docs/src/i18n.js";

test("getLocale picks by language prefix, defaults to English", () => {
  assert.equal(getLocale("ja").lang, "ja");
  assert.equal(getLocale("ja-JP").lang, "ja");
  assert.equal(getLocale("fr").lang, "en");
  assert.equal(getLocale(undefined).lang, "en");
});

test("every locale defines the same UI strings", () => {
  const keys = Object.keys(LOCALES.en.t).sort();
  for (const [lang, locale] of Object.entries(LOCALES)) {
    assert.deepEqual(Object.keys(locale.t).sort(), keys, lang);
    assert.equal(locale.t.headers.length, 4, lang);
  }
});

test("English reply templates are unchanged", () => {
  const t = LOCALES.en.t;
  assert.equal(t.found(1, []), "Found 1 bug.");
  assert.equal(
    t.found(8, ["mentioning GOTO OBJECT", "fixed in version 20 (and its releases/hotfixes)"]),
    "Found 8 bugs mentioning GOTO OBJECT and fixed in version 20 (and its releases/hotfixes)."
  );
  assert.equal(t.fallback(["a"]), " No exact match for that — showing the closest overall matches instead.");
  assert.equal(t.foundDirect(["ACI0101931"]), "Found ACI0101931 directly — see the details below.");
});

test("Japanese reply templates", () => {
  const t = LOCALES.ja.t;
  assert.equal(t.found(3, [t.mentioning(["GOTO OBJECT"])]), "GOTO OBJECT に関するバグが 3 件見つかりました。");
  assert.equal(t.found(2, []), "バグが 2 件見つかりました。");
});

test("embedding settings match the corpus build", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../scripts/update/generate_embeddings.mjs", import.meta.url), "utf8");
  for (const locale of Object.values(LOCALES)) {
    assert.ok(src.includes(`"${locale.embedding.model}"`), `${locale.lang} model id`);
    assert.ok(src.includes(`dim: ${locale.embedding.dim}`), `${locale.lang} dim`);
    if (locale.embedding.options.revision) assert.ok(src.includes(locale.embedding.options.revision));
  }
});
