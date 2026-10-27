import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCommandIndex, extractCommandMentions } from "../../docs/src/commands.js";

const index = buildCommandIndex([
  { commands: ["GOTO OBJECT", "OBJECT SET VISIBLE", "Print form", "QUERY"] },
  { commands: ["OB"] },
]);

test("command names are found inside Japanese text", () => {
  assert.deepEqual(extractCommandMentions("GOTO OBJECTでフォーカスが移動しない", index), ["GOTO OBJECT"]);
  assert.deepEqual(extractCommandMentions("Print formを使うとクラッシュ", index), ["Print form"]);
  assert.deepEqual(extractCommandMentions("「QUERY」の結果が空", index), ["QUERY"]);
});

test("matching stays case-sensitive and longest-first", () => {
  assert.deepEqual(extractCommandMentions("print formで印刷", index), []);
  assert.deepEqual(extractCommandMentions("OBJECT SET VISIBLEが効かない", index), ["OBJECT SET VISIBLE"]);
});

test("French prose keeps canonical English command matching", () => {
  assert.deepEqual(extractCommandMentions("Un plantage avec Print form depuis v20", index), ["Print form"]);
  assert.deepEqual(extractCommandMentions("GOTO OBJECT ne déplace pas le focus", index), ["GOTO OBJECT"]);
  assert.deepEqual(extractCommandMentions("Un plantage avec print form", index), []);
  assert.deepEqual(extractCommandMentions("ALLER À OBJET ne fonctionne pas", index), []);
});

test("full-width input matches once NFKC-normalized (as app.js does)", () => {
  assert.deepEqual(extractCommandMentions("ＧＯＴＯ　ＯＢＪＥＣＴ".normalize("NFKC"), index), ["GOTO OBJECT"]);
});
