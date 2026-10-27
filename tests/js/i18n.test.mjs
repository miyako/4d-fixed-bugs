import { test } from "node:test";
import assert from "node:assert/strict";
import { LOCALES, getLocale } from "../../docs/src/i18n.js";

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

test("French embedding settings use the multilingual corpus and pinned Xenova runtime", () => {
  const locale = LOCALES.fr;
  assert.equal(locale.dataDir, "../data/fr/");
  assert.equal(locale.embedding.library, LOCALES.en.embedding.library);
  assert.equal(locale.embedding.library, "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js");
  assert.equal(locale.embedding.model, "Xenova/multilingual-e5-small");
  assert.deepEqual(locale.embedding.options, { quantized: true });
  assert.equal(locale.embedding.dim, 384);
  assert.equal(locale.embedding.queryPrefix, "query: ");
  assert.deepEqual(locale.scores, { min: 0.85, high: 0.90, medium: 0.88 });
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

test("embedding settings match the corpus build", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(new URL("../../scripts/update/generate_embeddings.mjs", import.meta.url), "utf8");
  const prefixes = {
    en: { query: "", document: "" },
    ja: { query: "検索クエリ: ", document: "検索文書: " },
    fr: { query: "query: ", document: "passage: " },
  };
  for (const locale of Object.values(LOCALES)) {
    const config = src.match(new RegExp(`\\b${locale.lang}: \\{([\\s\\S]*?)\\n  \\},`))?.[1];
    assert.ok(config, `${locale.lang} corpus configuration`);
    assert.ok(config.includes(`"${locale.embedding.model}"`), `${locale.lang} model id`);
    assert.ok(config.includes(`dim: ${locale.embedding.dim}`), `${locale.lang} dim`);
    if (locale.embedding.options.revision) assert.ok(config.includes(locale.embedding.options.revision));
    assert.equal(locale.embedding.queryPrefix, prefixes[locale.lang].query, `${locale.lang} query prefix`);
    assert.ok(config.includes(`docPrefix: "${prefixes[locale.lang].document}"`), `${locale.lang} document prefix`);
  }
});
