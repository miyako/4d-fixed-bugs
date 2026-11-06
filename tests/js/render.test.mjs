import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSummary, renderVersions } from "../../docs/src/render.js";
import { BETA_ONLY_VERSIONS } from "../../docs/src/beta-versions.js";

test("release and hotfix links use canonical case and trailing slashes", () => {
  const html = renderVersions(["21.2", "21.1_hf2", "20_r10_hf1"]);
  for (const version of ["21.2", "21.1_HF2", "20_R10_HF1"]) {
    assert.ok(html.includes(`href="https://developer.4d.com/FixedBugsList/versions/${version}/"`));
  }
  assert.ok(html.includes(">21.1_hf2</a>"));
  assert.ok(!html.includes("bugs.4d.com"));
});

test("nightly-only versions use the nightly path", () => {
  const version = "99_r4";
  BETA_ONLY_VERSIONS.add(version);
  try {
    assert.match(renderVersions([version]), /href="https:\/\/developer\.4d\.com\/FixedBugsList\/nightly\/99_R4\/"/);
  } finally {
    BETA_ONLY_VERSIONS.delete(version);
  }
});

test("version links preserve escaping and empty-list behavior", () => {
  assert.equal(renderVersions([]), "—");
  assert.equal(renderVersions(null), "—");
  assert.ok(renderVersions(['21/<"']).includes("21%2F%3C%22/"));
  assert.ok(renderVersions(['21/<"']).includes(">21/&lt;&quot;</a>"));
});

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
