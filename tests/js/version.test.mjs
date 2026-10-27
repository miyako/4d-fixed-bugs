import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersionIntent, bugMatchesIntent, describeIntent } from "../../docs/src/version.js";

const parse = (q) => parseVersionIntent(q, 13, 21);

test("English phrasings are unchanged", () => {
  assert.deepEqual(parse("crash in v20"), { type: "exact", major: 20 });
  assert.deepEqual(parse("around v18"), { type: "approx", major: 18 });
  assert.deepEqual(parse("18 or thereabouts"), { type: "approx", major: 18 });
  assert.deepEqual(parse("before 17"), { type: "before", major: 17 });
  assert.deepEqual(parse("after 20"), { type: "after", major: 20 });
  assert.deepEqual(parse("19 R8"), { type: "r-release", major: 19, rNum: 8 });
  assert.deepEqual(parse("20.1 printing"), { type: "exact", major: 20 });
  assert.equal(parse("no version here"), null);
});

test("Japanese approximate", () => {
  for (const q of ["v18前後の印刷", "18頃のバグ", "18あたり", "18 ごろ", "約18", "およそv18"]) {
    assert.deepEqual(parse(q), { type: "approx", major: 18 }, q);
  }
});

test("Japanese before/after, strict vs inclusive", () => {
  assert.deepEqual(parse("17より前"), { type: "before", major: 17, inclusive: false });
  assert.deepEqual(parse("17未満"), { type: "before", major: 17, inclusive: false });
  assert.deepEqual(parse("v17以前で"), { type: "before", major: 17, inclusive: true });
  assert.deepEqual(parse("20より後"), { type: "after", major: 20, inclusive: false });
  assert.deepEqual(parse("v20以降の印刷"), { type: "after", major: 20, inclusive: true });
});

test("Japanese exact and full-width input", () => {
  assert.deepEqual(parse("バージョン19の印刷"), { type: "exact", major: 19 });
  assert.deepEqual(parse("Ｖ２０でクラッシュ"), { type: "exact", major: 20 });
  assert.deepEqual(parse("v19 R8で"), { type: "r-release", major: 19, rNum: 8 });
});

test("out-of-range numbers are ignored", () => {
  assert.equal(parse("99以降"), null);
  assert.equal(parse("エラー50件"), null);
});

test("French approximate and exact versions", () => {
  for (const q of ["autour de v18", "autour de la version 18", "environ 18", "vers v18", "aux alentours de 18", "approximativement 18"]) {
    assert.deepEqual(parse(q), { type: "approx", major: 18 }, q);
  }
  assert.deepEqual(parse("plantage dans la version 20"), { type: "exact", major: 20 });
  assert.deepEqual(parse("version 20.1"), { type: "exact", major: 20 });
  assert.deepEqual(parse("depuis la version 19 R8"), { type: "r-release", major: 19, rNum: 8 });
});

test("French before/after distinguish exclusive and inclusive bounds", () => {
  for (const [query, type, major, inclusive] of [
    ["avant 17", "before", 17, false],
    ["avant la version 17", "before", 17, false],
    ["après v20", "after", 20, false],
    ["APRÈS LA VERSION 20", "after", 20, false],
    ["depuis 20", "after", 20, true],
    ["depuis la version 20", "after", 20, true],
    ["à partir de v20", "after", 20, true],
    ["plantage à partir de la version 20", "after", 20, true],
    ["jusqu'à 17", "before", 17, true],
    ["jusqu’à la version 17", "before", 17, true],
    ["jusqu’à Ｖ１７", "before", 17, true],
  ]) {
    const intent = { type, major, inclusive };
    assert.deepEqual(parse(query), intent, query);
    assert.equal(bugMatchesIntent({ versions: [`${major}.1_hf1`] }, parse(query)), inclusive, query);
    assert.equal(bugMatchesIntent({ versions: [`${major - 1}`] }, intent), type === "before", query);
    assert.equal(bugMatchesIntent({ versions: [`${major + 1}`] }, intent), type === "after", query);
  }
  assert.equal(parse("avant 99"), null);
  assert.equal(parse("depuis 50"), null);
  assert.equal(parse("jusqu’à 99"), null);
});

test("French intent descriptions cover all intent types", () => {
  const describe = (intent) => describeIntent(intent, "fr");
  assert.equal(describe({ type: "exact", major: 20 }), "la version 20 (y compris ses mises à jour et correctifs)");
  assert.equal(describe({ type: "approx", major: 18 }), "les versions autour de 18 (versions majeures 17-19)");
  assert.equal(describe({ type: "before", major: 17 }), "les versions avant 17");
  assert.equal(describe({ type: "before", major: 17, inclusive: true }), "les versions jusqu’à 17 inclus");
  assert.equal(describe({ type: "after", major: 20 }), "les versions après 20");
  assert.equal(describe({ type: "after", major: 20, inclusive: true }), "la version 20 et les suivantes");
  assert.equal(describe({ type: "r-release", major: 19, rNum: 8 }), "19_r8 et toute la version 20 (les versions R préfigurent la version majeure suivante)");
  assert.equal(describe(null), null);
  assert.equal(describe({ type: "unknown", major: 20 }), null);
});

test("inclusive bounds match the boundary major", () => {
  const bug = { versions: ["17.3"] };
  assert.equal(bugMatchesIntent(bug, { type: "before", major: 17, inclusive: true }), true);
  assert.equal(bugMatchesIntent(bug, { type: "before", major: 17, inclusive: false }), false);
  assert.equal(bugMatchesIntent(bug, { type: "before", major: 17 }), false);
  assert.equal(bugMatchesIntent({ versions: ["20_r2"] }, { type: "after", major: 20, inclusive: true }), true);
  assert.equal(bugMatchesIntent({ versions: ["20_r2"] }, { type: "after", major: 20 }), false);
});

test("describeIntent in both languages", () => {
  assert.equal(describeIntent({ type: "before", major: 17 }), "versions before 17");
  assert.equal(describeIntent({ type: "before", major: 17, inclusive: true }), "versions up to and including 17");
  assert.equal(describeIntent({ type: "after", major: 20, inclusive: true }, "ja"), "v20 以降");
  assert.equal(describeIntent({ type: "approx", major: 18 }, "ja"), "v18 前後（v17〜v19）");
  assert.equal(describeIntent(null, "ja"), null);
});
