import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, getLocale } from "../../docs/src/i18n.js";
import { SEARCH_CONFIG, documentText, queryText } from "../../docs/src/search-config.js";

test("getLocale picks by language prefix, defaults to English", () => {
  assert.equal(getLocale("ja").lang, "ja");
  assert.equal(getLocale("ja-JP").lang, "ja");
  assert.equal(getLocale("fr").lang, "fr");
  assert.equal(getLocale("fr-FR").lang, "fr");
  assert.equal(getLocale("fr-CA").lang, "fr");
  assert.equal(getLocale("de").lang, "en");
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

test("French reply templates preserve canonical command names and references", () => {
  const t = LOCALES.fr.t;
  assert.equal(t.found(1, []), "1 bug trouvé.");
  assert.equal(t.found(2, [t.mentioning(["GOTO OBJECT"])]), "2 bugs trouvés mentionnant GOTO OBJECT.");
  assert.equal(t.foundDirect(["ACI0092218"]), "ACI0092218 trouvé directement — consultez les détails ci-dessous.");
  assert.equal(t.foundDirect(["ACI0092218", "ACI0101931"]), "ACI0092218, ACI0101931 trouvés directement — consultez les détails ci-dessous.");
  assert.match(t.ready(123, 13, 21), /^Prêt\. 123 bugs 4D corrigés chargés \(versions 13-21\)/);
  assert.equal(t.fixedIn("les versions avant 17"), "corrigé(s) dans les versions avant 17");
  assert.equal(t.headers[3], "Résumé");
  assert.match(t.replyLanguage, /French/);
});

test("all locales share the pinned normalized text-only EmbeddingGemma contract", () => {
  assert.equal(SEARCH_CONFIG.model, "onnx-community/embeddinggemma-2-ONNX");
  assert.equal(SEARCH_CONFIG.revision, "daa72c51243991dfcaf9f9137d2c573d8f7790c0");
  assert.equal(SEARCH_CONFIG.precision, "q4");
  assert.equal(SEARCH_CONFIG.dimensions, 768);
  assert.equal(SEARCH_CONFIG.normalization, "l2");
  assert.equal(SEARCH_CONFIG.pooling, "exported sentence_embedding");
  assert.equal(SEARCH_CONFIG.runtime.transformers, "4.3.1");
  for (const [lang, locale] of Object.entries(LOCALES)) {
    assert.ok(!Object.hasOwn(locale, "embedding"), `${lang} must not override the shared encoder`);
    assert.equal(locale.dataDir, lang === "en" ? "../data/" : `../data/${lang}/`);
    assert.ok(locale.scores.min <= locale.scores.medium && locale.scores.medium <= locale.scores.high, lang);
  }
});

test("shared prompts preserve localized summaries, references and English command names", () => {
  for (const [lang, summary] of [
    ["en", "A crash with [Print form](https://developer.4d.com/docs/commands/print-form)."],
    ["fr", "Un plantage avec [Print form](https://developer.4d.com/docs/commands/print-form)."],
    ["ja", "[Print form](https://developer.4d.com/docs/ja/commands/print-form)でクラッシュ。"],
  ]) {
    const stripped = summary.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    assert.equal(documentText({ reference: "ACI0092218", summary, commands: ["Print form", "GOTO OBJECT"] }),
      `title: ACI0092218 | text: ${stripped}\nPrint form · GOTO OBJECT`, lang);
    assert.equal(queryText(summary), `task: search result | query: ${summary}`, lang);
  }
});

test("semantic availability and fallback messages are localized in every locale", () => {
  for (const [lang, { t }] of Object.entries(LOCALES)) {
    for (const key of ["semanticLoading", "semanticReady", "semanticUnavailable", "semanticRetry", "keywordMatch", "filterMatch"]) {
      assert.equal(typeof t[key], "string", `${lang}: ${key}`);
      assert.ok(t[key].length, `${lang}: ${key}`);
      if (lang !== "en") assert.notEqual(t[key], LOCALES.en.t[key], `${lang}: ${key}`);
    }
    assert.ok(t.semanticError("TEST").includes("TEST"), lang);
    assert.ok(t.semanticProgress("model_q4.onnx", 42).includes("42"), lang);
    assert.ok(t.semanticProgress("model_q4.onnx", 42).includes("model_q4.onnx"), lang);
    assert.notEqual(t.keywordMatch, t.exact, lang);
    assert.ok(!t.keywordMatch.includes("%"), lang);
    assert.notEqual(t.filterMatch, t.exact, lang);
    assert.ok(!t.filterMatch.includes("%"), lang);
  }
});

test("all locale pages expose navigation and alternate links for all three languages", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const [lang, page, targets] of [
    ["en", "index.html", { ja: "ja/", fr: "fr/" }],
    ["ja", "ja/index.html", { en: "../", fr: "../fr/" }],
    ["fr", "fr/index.html", { en: "../", ja: "../ja/" }],
  ]) {
    const html = await readFile(new URL(`../../docs/${page}`, import.meta.url), "utf8");
    assert.ok(html.includes(`<html lang="${lang}">`), page);
    for (const other of ["en", "ja", "fr"]) {
      const suffix = other === "en" ? "" : `${other}/`;
      assert.ok(html.includes(`hreflang="${other}" href="https://miyako.github.io/4d-fixed-bugs/${suffix}"`), `${page}: ${other}`);
    }
    for (const [other, href] of Object.entries(targets)) {
      assert.ok(html.includes(`href="${href}" hreflang="${other}"`), `${page}: navigation to ${other}`);
    }
  }
});

test("browser worker and corpus builder import the same shared encoder contract", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of ["docs/src/search-worker.js", "scripts/update/search-encoder.mjs", "scripts/update/generate_embeddings.mjs"]) {
    const src = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.match(src, /import\s*\{[^}]*SEARCH_CONFIG[^}]*\}\s*from\s*["'][^"']*search-config\.js["']/, file);
  }
});
