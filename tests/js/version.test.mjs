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
