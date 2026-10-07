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

test("non-allowlisted links are de-linked", () => {
  assert.equal(renderSummary("[x](https://example.com/)の件"), "xの件");
});
