import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeywordSearch } from "../../docs/src/keyword-search.js";

const records = [
  { reference: "ACI0000001", summary: "Printing a form crashes.", commands: ["Print form"] },
  { reference: "ACI0000002", summary: "Backup fails with a broken symbolic link.", commands: [] },
  { reference: "ACI0000003", summary: "L’application plante pendant l’impression d’un formulaire.", commands: ["Print form"] },
  { reference: "ACI0000004", summary: "フォームの印刷時にクラッシュしました。", commands: ["Print form"] },
];

test("keyword fallback works without vectors and excludes unrelated documents", () => {
  const search = createKeywordSearch(records, "en");
  assert.equal(search.rank("printing forms crashes", [0, 1])[0].index, 0);
  assert.deepEqual(search.rank("weather tomorrow", [0, 1]), []);
  assert.deepEqual(search.rank("the and of", [0, 1]), []);
});

test("French accents and Japanese word boundaries are usable", () => {
  assert.equal(createKeywordSearch(records, "fr").rank("impression formulaire", [1, 2])[0].index, 2);
  assert.equal(createKeywordSearch(records, "fr").rank("application", [1, 2])[0].index, 2);
  assert.equal(createKeywordSearch(records, "ja").rank("フォームを印刷するとクラッシュ", [1, 3])[0].index, 3);
});

test("English stemming retains original words and common plural matches", () => {
  const search = createKeywordSearch([{ reference: "ACI0000001", summary: "Two processes crash.", commands: [] }], "en");
  assert.equal(search.rank("process", [0])[0].index, 0);
  assert.equal(search.rank("processes", [0])[0].index, 0);
});

test("keyword ranking never escapes exact filters, even with no remaining lexical terms", () => {
  const search = createKeywordSearch(records, "en");
  assert.deepEqual(search.rank("v20", [1], { filtered: true }), [{ index: 1, score: 0 }]);
  assert.deepEqual(search.rank("printing a form", [1]), []);
  assert.deepEqual(search.rank("weather after v20", [1], { filtered: true }), []);
  assert.ok(search.rank("Print form", [0]).every((hit) => hit.index === 0 && hit.score > 0));
});

test("exact filter-only queries are independent of semantic relevance and remaining symptom words are not discarded", () => {
  const en = createKeywordSearch(records, "en");
  assert.equal(en.isFilterOnly("v20"), true);
  assert.equal(en.isFilterOnly("Print form", ["Print form"]), true);
  assert.equal(en.isFilterOnly("Print form fixed after v20", ["Print form"]), true);
  assert.equal(en.isFilterOnly("printing crashes after v20"), false);
  assert.equal(en.isFilterOnly("weather after v20"), false);
  assert.equal(createKeywordSearch(records, "fr").isFilterOnly("depuis v20 avec Print form", ["Print form"]), true);
  assert.equal(createKeywordSearch(records, "ja").isFilterOnly("v20以降のバグ"), true);
});

test("filter syntax and already-matched commands cannot supply unrelated keyword hits", () => {
  const search = createKeywordSearch([{
    reference: "ACI0000001", summary: "On After Edit ran after Print form crashed.", commands: ["Print form"],
  }], "en");
  assert.deepEqual(search.rank("weather after v20", [0], { filtered: true }), []);
  assert.deepEqual(search.rank("weather after v20 Print form", [0], {
    filtered: true, versionFilter: true, commands: ["Print form"],
  }), []);
  assert.equal(search.rank("crashes after v20 Print form", [0], {
    filtered: true, versionFilter: true, commands: ["Print form"],
  })[0].index, 0);
  assert.equal(search.rank("On After Edit", [0])[0].index, 0);
});
