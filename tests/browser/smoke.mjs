#!/usr/bin/env node
/**
 * Browser smoke test for both pages: serves docs/ locally, loads / and /ja/
 * in headless Chromium, waits for the dataset + embedding model to load
 * (fetched from the CDN / Hugging Face, so this needs network), runs a few
 * queries and checks the rendered replies and results tables.
 *
 *   cd scripts && npm install && npx playwright install chromium   (or set PW_CHANNEL=chrome)
 *   node ../tests/browser/smoke.mjs
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = path.join(ROOT, "docs");
// playwright is installed under scripts/node_modules.
const { chromium } = createRequire(path.join(ROOT, "scripts", "package.json"))("playwright");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".bin": "application/octet-stream" };

const server = createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  const file = path.join(DOCS, p);
  if (!file.startsWith(DOCS)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// PW_CHANNEL=chrome uses an installed Chrome instead of a downloaded Chromium.
const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
let failures = 0;

async function check(name, fn) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await fn(page);
    assert.deepEqual(errors, [], "uncaught page errors");
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`not ok - ${name}\n  ${String(err.message).split("\n").join("\n  ")}`);
  } finally {
    await page.close();
  }
}

async function ask(page, query) {
  const before = await page.locator(".chat-message.assistant").count();
  await page.fill("#chat-input", query);
  await page.click("#chat-form button[type=submit]");
  const bubble = page.locator(".chat-message.assistant").nth(before);
  await bubble.waitFor({ timeout: 60_000 });
  return bubble;
}

await check("English page boots and searches", async (page) => {
  await page.goto(`${base}/`);
  await page.waitForFunction(() => document.querySelector("#boot-status").textContent.startsWith("Ready."), null, { timeout: 180_000 });
  const bubble = await ask(page, "printing a form crashes");
  assert.ok((await bubble.locator(".hits-table tbody tr").count()) > 0, "no result rows");
  assert.match(await bubble.locator("thead").innerText(), /Summary/);
  assert.equal(await page.locator(".lang-switch a[href='ja/']").count(), 1);
});

await check("Japanese page boots and searches", async (page) => {
  await page.goto(`${base}/ja/`);
  await page.waitForFunction(() => document.querySelector("#boot-status").textContent.startsWith("準備ができました"), null, { timeout: 180_000 });

  let bubble = await ask(page, "フォームを印刷するとアプリケーションがクラッシュする");
  const rows = bubble.locator(".hits-table tbody tr");
  assert.ok((await rows.count()) > 0, "no result rows");
  assert.match(await bubble.locator("thead").innerText(), /概要/);
  assert.match(await rows.first().locator(".hit-summary").innerText(), /[ぁ-んァ-ン]/, "summary is not Japanese");
  if (process.env.SMOKE_SCREENSHOT) await page.screenshot({ path: process.env.SMOKE_SCREENSHOT, fullPage: true });

  bubble = await ask(page, "v20以降でPrint formを使うとクラッシュ");
  assert.match(await bubble.innerText(), /Print form に関する、v20 以降で修正されたバグが \d+ 件見つかりました。/);
  const hrefs = await bubble.locator(".hit-summary a").evaluateAll((as) => as.map((a) => a.href));
  assert.ok(hrefs.length > 0 && hrefs.every((h) => h.startsWith("https://developer.4d.com/docs/ja/")), `links: ${hrefs}`);

  bubble = await ask(page, "ＡＣＩ００９２２１８について");
  assert.match(await bubble.innerText(), /ACI0092218 が見つかりました/);
  assert.match(await bubble.locator(".match-badge").first().innerText(), /完全一致/);

  // Off-topic queries fall below the calibrated MIN_SCORE.
  bubble = await ask(page, "今日の東京の天気は？");
  assert.match(await bubble.innerText(), /近いバグは見つかりませんでした/);
  assert.equal(await bubble.locator(".hits-table tbody tr").count(), 0);
});

await browser.close();
server.close();
if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll browser smoke tests passed.");
