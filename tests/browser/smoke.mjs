#!/usr/bin/env node
/**
 * PW_CHANNEL=chrome node tests/browser/smoke.mjs
 *
 * Requires rebuilt indexes and the checksummed model under
 * .cache/search-model/<revision>/ (or SEARCH_MODEL_PATH). Model requests
 * retain their pinned Hugging Face URLs and are routed to this local cache.
 * Official CDN runtime bytes are verified in .cache/search-runtime/4.3.1/
 * and routed locally, with an additional unrouted public-CDN WebGPU case.
 * Actual app-worker WebGPU vectors are compared with Node CPU inference.
 * SEARCH_BROWSER_MODE=keyword runs only the no-WebGPU checks, without a model.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { LOCALES } from "../../docs/src/i18n.js";
import { SEARCH_CONFIG, queryText } from "../../docs/src/search-config.js";
import { TRANSFORMERS_URL, ORT_BASE_URL, RUNTIME_ARTIFACTS, runtimeUrl } from "../../docs/src/runtime-config.js";
import {
  ROOT, DOCS, chromium, requireScripts, serve, verifyCachedModel, verifyCachedRuntime, instrument,
  waitState, waitBoot, ask, replyText, assertKeyword,
} from "./support.mjs";

const locales = [
  { ...LOCALES.en, path: "/", ready: "Ready.", query: "printing a form crashes", filtered: "after v19 with Print form crashes", offTopic: "What is the weather in Tokyo today?" },
  { ...LOCALES.fr, path: "/fr/", ready: "Prêt.", query: "L’application plante lors de l’impression d’un formulaire", filtered: "depuis v20 avec Print form plantage", offTopic: "Quel temps fait-il à Tokyo aujourd’hui ?" },
  { ...LOCALES.ja, path: "/ja/", ready: "準備ができました", query: "フォームを印刷するとアプリケーションがクラッシュする", filtered: "v20以降でPrint formを使うとクラッシュ", offTopic: "今日の東京の天気は？" },
];
const server = await serve();
let browser;
let encoder;
let failures = 0;
const check = async (name, fn) => {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failures++;
    console.error(`not ok - ${name}\n${error.stack || error}`);
  }
};

async function filters(page, locale, { keyword = false } = {}) {
  let bubble = await ask(page, locale.filtered);
  if (keyword) await assertKeyword(bubble, locale);
  assert.ok(await bubble.locator("tbody tr").count(), "filtered rows");
  const reply = await replyText(bubble);
  assert.ok(reply.includes("Print form"), "canonical command in localized reply");
  assert.ok(reply.includes(locale.lang === "en" ? "19" : "20"), "version criterion in reply");
  const refs = await bubble.locator(".hit-ref").allTextContents();
  const records = JSON.parse(await readFile(path.join(DOCS, locale.lang === "en" ? "data/meta.json" : `data/${locale.lang}/meta.json`)));
  for (const ref of refs) {
    const record = records.find((record) => record.reference === ref);
    assert.ok(record?.commands.includes("Print form"), `command filter: ${ref}`);
    assert.ok(record.versions.some((version) => Number.parseInt(version, 10) >= 20), `version filter: ${ref}`);
  }
  const links = await bubble.locator(".hit-summary a").evaluateAll((as) => as.map((a) => ({ href: a.href, text: a.textContent })));
  assert.ok(links.some((link) => link.text === "Print form"), "canonical command link");
  assert.ok(links.every((link) => link.href.startsWith("https://developer.4d.com/")));
  if (locale.lang === "ja") assert.ok(links.every((link) => link.href.includes("/docs/ja/")));
  else assert.ok(links.every((link) => !/\/docs\/(?:ja|fr)\//.test(link.href)));

  const encodesBeforeFilters = await page.evaluate(() => window.searchTest.workers.reduce(
    (count, worker) => count + worker.sent.filter((message) => message.type === "encode").length, 0
  ));
  for (const [query, predicate] of [
    ["v20", (record) => record.versions.some((version) => Number.parseInt(version, 10) === 20)],
    ["Print form", (record) => record.commands.includes("Print form")],
    [locale.lang === "fr" ? "depuis v20 avec Print form" :
      locale.lang === "ja" ? "v20以降 Print form" : "after v19 with Print form",
    (record) => record.commands.includes("Print form") &&
      record.versions.some((version) => Number.parseInt(version, 10) >= 20)],
  ]) {
    bubble = await ask(page, query);
    const filterRefs = await bubble.locator(".hit-ref").allTextContents();
    assert.ok(filterRefs.length > 0, `${query}: exact filters must survive semantic score floors`);
    for (const ref of filterRefs) {
      assert.ok(predicate(records.find((record) => record.reference === ref)), `${query}: ${ref} respects filters`);
    }
    const filterBadges = await bubble.locator(".match-badge").allTextContents();
    assert.ok(filterBadges.every((badge) => badge === locale.t.filterMatch),
      `${query}: honest localized filter-only labels: ${filterBadges}`);
    assert.equal(await bubble.locator(".match-badge:not(.filter)").count(), 0);
    if (query.includes("Print form")) assert.ok((await replyText(bubble)).includes("Print form"));
  }
  assert.equal(await page.evaluate(() => window.searchTest.workers.reduce(
    (count, worker) => count + worker.sent.filter((message) => message.type === "encode").length, 0
  )), encodesBeforeFilters, "pure filters bypass model inference, even when WebGPU is ready");

  bubble = await ask(page, "ACI0092218");
  assert.equal(await replyText(bubble), locale.t.foundDirect(["ACI0092218"]));
  assert.equal(await bubble.locator("tbody tr").count(), 1);
  assert.equal(await bubble.locator(".match-badge.exact").innerText(), locale.t.exact);
  await page.click("#clear-btn");
  assert.equal(await page.locator(".chat-message").count(), 0);
}

try {
  browser = await chromium.launch({ channel: process.env.PW_CHANNEL || "chrome" });
  for (const locale of locales) {
    await check(`${locale.lang}: no WebGPU keeps localized keyword, ACI and filters without model downloads`, async () => {
      const context = await browser.newContext();
      const traffic = await instrument(context, server.origin, { noGPU: true });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      try {
        await page.goto(server.origin + locale.path);
        await waitBoot(page, locale);
        await waitState(page, "unavailable");
        assert.equal(await page.locator("#search-status").innerText(), locale.t.semanticUnavailable);
        assert.ok(await page.locator("#search-retry").isHidden());
        assert.ok(await page.locator("#search-progress").isHidden());
        assert.equal(await page.locator(".lang-switch a").count(), 2);
        const bubble = await ask(page, locale.query);
        await assertKeyword(bubble, locale);
        assert.ok((await bubble.locator("thead").innerText()).includes(locale.t.headers[3]));
        await filters(page, locale, { keyword: true });
        const irrelevant = await ask(page, "weather after v20");
        assert.equal(await irrelevant.locator("tbody tr").count(), 0, "a version filter must not pad an unrelated keyword query");
        assert.equal(await replyText(irrelevant), locale.t.noResults);
        assert.equal(await page.evaluate(() => window.searchTest.workers.length), 0);
        const forbidden = traffic.requests.filter(({ url }) =>
          /huggingface|cdn\.jsdelivr\.net|\/models\/|\/search-runtime\/|search-worker\.js|embeddings\.bin|search-index\.json/.test(url));
        assert.deepEqual(forbidden, [], "no runtime, model or vector download without GPU");
        assert.deepEqual(traffic.violations, []);
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    });
  }

  if (process.env.SEARCH_BROWSER_MODE !== "keyword") {
    await verifyCachedModel();
    await verifyCachedRuntime();
    const transformersPackage = JSON.parse(await readFile(path.resolve(
      path.dirname(requireScripts.resolve("@huggingface/transformers")), "../package.json"
    )));
    assert.equal(transformersPackage.version, SEARCH_CONFIG.runtime.transformers, "Node and browser Transformers versions");
    const vendored = JSON.parse(await readFile(path.join(DOCS, "search-runtime", SEARCH_CONFIG.runtime.transformers, "versions.json")));
    assert.deepEqual(vendored, SEARCH_CONFIG.runtime, "runtime attribution matches the pinned contract");
    const { loadEncoder } = await import("../../scripts/update/search-encoder.mjs");
    encoder = await loadEncoder({ localPath: process.env.SEARCH_MODEL_PATH || path.join(ROOT, ".cache/search-model", SEARCH_CONFIG.revision) });
    const context = await browser.newContext();
    const traffic = await instrument(context, server.origin);
    try {
      for (const locale of locales) {
        await check(`${locale.lang}: actual WebGPU, loading fallback, download progress and full CPU vector parity`, async () => {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          let release;
          let markGateHit;
          const gateHit = new Promise((resolve) => { markGateHit = resolve; });
          const gate = new Promise((resolve) => { release = resolve; });
          const route = async (request) => { markGateHit(); await gate; await request.continue(); };
          await context.route("**/search-worker.js", route);
          try {
            await page.goto(server.origin + locale.path);
            await waitBoot(page, locale);
            await waitState(page, "loading");
            await page.waitForFunction(() => window.searchTest.workers.length === 1);
            await Promise.race([gateHit, new Promise((_, reject) =>
              setTimeout(() => reject(new Error("worker network was not gated")), 10_000))]);
            assert.equal(await page.locator("#search-status").innerText(), locale.t.semanticLoading);
            assert.ok(await page.locator("#search-progress").isVisible());
            assert.ok(await page.locator("#search-retry").isHidden());
            await assertKeyword(await ask(page, locale.query), locale);
            release();
            await context.unroute("**/search-worker.js", route);
            await waitState(page, "ready");
            assert.equal(await page.locator("#search-status").innerText(), locale.t.semanticReady);
            assert.ok(await page.locator("#search-progress").isHidden());
            assert.ok(await page.locator("#search-retry").isHidden());
            assert.equal(await page.evaluate(() => window.searchTest.workers.length), 1);
            if (locale.lang === "en") {
              const progress = await page.evaluate(() => window.searchTest.progress);
              assert.ok(progress.some(({ value }) => Number.isFinite(value) && value > 0 && value <= 100),
                "real model download displays numeric progress");
              assert.ok(traffic.requests.some(({ url }) => url.startsWith(`https://huggingface.co/${SEARCH_CONFIG.model}/resolve/${SEARCH_CONFIG.revision}/`)));
            }
            const before = traffic.requests.length;
            const bubble = await ask(page, locale.query);
            const captured = await page.evaluate((query) =>
              window.searchTest.vectors.findLast((entry) => entry.query === query), locale.query);
            assert.ok(captured?.typed, "actual application worker returns Float32Array");
            assert.equal(captured.vector.length, 768);
            assert.ok(captured.vector.every(Number.isFinite));
            assert.ok(Math.abs(Math.hypot(...captured.vector) - 1) < 1e-6);
            const cpu = await encoder.encode(queryText(locale.query));
            assert.equal(cpu.length, 768);
            const cosine = cpu.reduce((sum, value, i) => sum + value * captured.vector[i], 0) /
              (Math.hypot(...cpu) * Math.hypot(...captured.vector));
            const maxDiff = Math.max(...cpu.map((value, i) => Math.abs(value - captured.vector[i])));
            assert.ok(cosine > 0.9999 && maxDiff < 0.001, `CPU/WebGPU full-vector parity: cosine=${cosine}, maxDiff=${maxDiff}`);
            console.log(`  ${locale.lang} parity: cosine=${cosine}, maxDiff=${maxDiff}`);
            await check(`${locale.lang}: off-topic queries are rejected, not padded with irrelevant hits`, async () => {
              const unrelated = await ask(page, locale.offTopic);
              assert.equal(await replyText(unrelated), locale.t.noRelevant);
              assert.equal(await unrelated.locator("tbody tr").count(), 0);
            });
            assert.ok(await bubble.locator("tbody tr").count(), "semantic result rows");
            const badges = await bubble.locator(".match-badge").allTextContents();
            assert.ok(badges.every((badge) => /^\d+%$/.test(badge)), `semantic percentages: ${badges}`);
            assert.equal(await bubble.locator(".match-badge.keyword").count(), 0);
            await filters(page, locale);
            assert.equal(traffic.requests.length, before, "queries and filters perform no network requests");
            assert.deepEqual(traffic.violations, []);
            assert.deepEqual(errors, []);
          } finally {
            release();
            await context.unroute("**/search-worker.js", route);
            await page.close();
          }
        });
      }
      await check("unrouted official public CDN supports worker CORS, dynamic ORT imports and CPU parity", async () => {
        const publicContext = await browser.newContext();
        // Only model weights are routed locally; no jsDelivr route is registered.
        const publicTraffic = await instrument(publicContext, server.origin, { localRuntime: false });
        const responses = [];
        publicContext.on("response", (response) => {
          if (response.url().startsWith("https://cdn.jsdelivr.net/")) {
            responses.push({ url: response.url(), status: response.status() });
          }
        });
        const page = await publicContext.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        try {
          await page.goto(server.origin + "/");
          await waitBoot(page, locales[0]);
          await waitState(page, "ready");
          assert.ok(publicTraffic.requests.some(({ url }) => url === TRANSFORMERS_URL));
          const ortModule = publicTraffic.requests.map(({ url }) => url).find((url) =>
            url.startsWith(ORT_BASE_URL) && /ort-wasm-simd-threaded\.(?:jsep|asyncify|jspi)\.mjs$/.test(url));
          assert.ok(ortModule, "dynamic ORT module imports directly from public CDN");
          const ortWasm = ortModule.replace(/\.mjs$/, ".wasm");
          assert.ok(publicTraffic.requests.some(({ url }) => url === ortWasm),
            "matching WebGPU ORT WASM fetched directly from public CDN");
          const before = publicTraffic.requests.length;
          const bubble = await ask(page, locales[0].query);
          assert.ok(await bubble.locator("tbody tr").count(), "public-CDN semantic results");
          const captured = await page.evaluate((query) =>
            window.searchTest.vectors.findLast((entry) => entry.query === query), locales[0].query);
          assert.ok(captured?.typed);
          assert.equal(captured.vector.length, 768);
          assert.ok(Math.abs(Math.hypot(...captured.vector) - 1) < 1e-6);
          const cpu = await encoder.encode(queryText(locales[0].query));
          const cosine = cpu.reduce((sum, value, i) => sum + value * captured.vector[i], 0) /
            (Math.hypot(...cpu) * Math.hypot(...captured.vector));
          const maxDiff = Math.max(...cpu.map((value, i) => Math.abs(value - captured.vector[i])));
          assert.ok(cosine > 0.9999 && maxDiff < 0.001, `public CDN parity: cosine=${cosine}, maxDiff=${maxDiff}`);
          console.log(`  public CDN parity: cosine=${cosine}, maxDiff=${maxDiff}, runtime=${ortModule.slice(ORT_BASE_URL.length)}`);
          assert.equal(publicTraffic.requests.length, before, "public-CDN runtime performs no query network requests");
          assert.deepEqual(publicTraffic.violations, []);
          assert.deepEqual(errors, []);
          const files = responses.map(({ url, status }) => {
            const file = Object.keys(RUNTIME_ARTIFACTS).find((file) => runtimeUrl(file) === url);
            assert.ok(file, `only exact pinned runtime URLs: ${url}`);
            assert.equal(status, 200, url);
            return file;
          });
          assert.ok(files.includes("transformers.min.js") &&
            files.includes(ortModule.slice(ORT_BASE_URL.length)) &&
            files.includes(ortWasm.slice(ORT_BASE_URL.length)), "official runtime responses observed");
          // Read bytes through browser CORS fetch, not Chromium's size-limited inspector cache.
          for (const file of [...new Set(files)]) {
            const hash = await page.evaluate(async (url) => {
              const response = await fetch(url);
              if (!response.ok) throw new Error(`Runtime verification HTTP ${response.status}`);
              const bytes = await response.arrayBuffer();
              return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
                (value) => value.toString(16).padStart(2, "0")).join("");
            }, runtimeUrl(file));
            assert.equal(hash, RUNTIME_ARTIFACTS[file], `unmodified official public CDN bytes: ${file}`);
          }
          assert.deepEqual(publicTraffic.violations, []);
        } finally {
          await publicContext.close();
        }
      });
    } finally {
      await context.close();
      await encoder.dispose();
      encoder = null;
    }

    await check("explicit worker load failure remains usable and manual retry starts exactly once", async () => {
      const context = await browser.newContext();
      const traffic = await instrument(context, server.origin);
      const page = await context.newPage();
      let loads = 0;
      const route = async (request) => {
        loads++;
        if (loads === 1) await request.fulfill({
          contentType: "text/javascript",
          body: "self.onmessage = () => self.postMessage({type:'error', error:'TEST_LOAD_FAILURE'});",
        });
        else await request.continue();
      };
      await context.route("**/search-worker.js", route);
      try {
        await page.goto(server.origin + "/fr/");
        await waitBoot(page, locales[1]);
        await waitState(page, "error");
        assert.equal(await page.locator("#search-status").innerText(), LOCALES.fr.t.semanticError("TEST_LOAD_FAILURE"));
        assert.equal(await page.locator("#search-retry").innerText(), LOCALES.fr.t.semanticRetry);
        assert.ok(await page.locator("#search-retry").isVisible());
        await assertKeyword(await ask(page, locales[1].query), locales[1]);
        assert.equal(loads, 1, "no automatic retries during keyword search");
        await page.click("#search-retry");
        await waitState(page, "ready");
        assert.equal(loads, 2, "one manual retry");
        assert.equal(await page.evaluate(() => window.searchTest.workers.length), 2);
        assert.ok(await page.locator("#search-retry").isHidden());
        assert.deepEqual(traffic.violations, []);
      } finally { await context.close(); }
    });

    for (const kind of ["stale contract", "changed metadata", "corrupt vectors"]) {
      await check(`${kind}: index failure is localized and nonfatal, with keyword results`, async () => {
        const context = await browser.newContext();
        const traffic = await instrument(context, server.origin);
        const page = await context.newPage();
        if (kind === "corrupt vectors") {
          await context.route("**/data/embeddings.bin", async (route) => {
            const bytes = Buffer.from(await readFile(path.join(DOCS, "data/embeddings.bin")));
            bytes[0] ^= 0xff;
            await route.fulfill({ contentType: "application/octet-stream", body: bytes });
          });
        } else {
          await context.route("**/data/search-index.json", async (route) => {
            const manifest = JSON.parse(await readFile(path.join(DOCS, "data/search-index.json")));
            if (kind === "stale contract") manifest.contract.revision = "stale";
            else manifest.metadata_sha256 = "0".repeat(64);
            await route.fulfill({ contentType: "application/json", body: JSON.stringify(manifest) });
          });
        }
        try {
          await page.goto(server.origin + "/");
          await waitBoot(page, locales[0]);
          await waitState(page, "error");
          assert.match(await page.locator("#search-status").innerText(), /^Semantic search failed:/);
          assert.ok(await page.locator("#search-retry").isVisible());
          await assertKeyword(await ask(page, locales[0].query), locales[0]);
          await filters(page, locales[0], { keyword: true });
          assert.equal(await page.evaluate(() => window.searchTest.workers.length), 0);
          assert.ok(!traffic.requests.some(({ url }) => /huggingface|cdn\.jsdelivr\.net|\/search-runtime\//.test(url)));
          assert.deepEqual(traffic.violations, []);
        } finally { await context.close(); }
      });
    }
  }
} finally {
  if (encoder) await encoder.dispose();
  if (browser) await browser.close();
  await server.close();
}
if (failures) process.exitCode = 1;
else console.log("\nAll browser smoke tests passed.");
