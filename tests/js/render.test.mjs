import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummary } from "../../docs/src/render.js";

test("Japanese summaries keep /docs/ja/ links", () => {
  const html = renderSummary(
    "[Print form](https://developer.4d.com/docs/ja/commands/print-form)で印刷するとクラッシュしていました。"
  );
  assert.match(html, /<a href="https:\/\/developer\.4d\.com\/docs\/ja\/commands\/print-form"[^>]*>Print form<\/a>で印刷/);
});

test("code spans and escaping work next to Japanese text", () => {
  assert.equal(renderSummary("`&nbsp;`を含む<b>テキスト</b>"), "<code>&amp;nbsp;</code>を含む&lt;b&gt;テキスト&lt;/b&gt;");
});

test("French summaries preserve English command names and documentation links", () => {
  const html = renderSummary(
    "Un plantage pouvait survenir avec [`Print form`](https://developer.4d.com/docs/commands/print-form) lors de l’impression."
  );
  assert.match(html, /href="https:\/\/developer\.4d\.com\/docs\/commands\/print-form"/);
  assert.match(html, /<code>Print form<\/code><\/a> lors de l’impression\./);
  assert.ok(!html.includes("/docs/fr/"));
});

test("non-allowlisted links are de-linked", () => {
  assert.equal(renderSummary("[x](https://example.com/)の件"), "xの件");
});
