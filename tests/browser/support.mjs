import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { SEARCH_CONFIG } from "../../docs/src/search-config.js";
import { RUNTIME_ARTIFACTS, runtimeUrl } from "../../docs/src/runtime-config.js";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const DOCS = path.join(ROOT, "docs");
export const requireScripts = createRequire(path.join(ROOT, "scripts/package.json"));
export const { chromium } = requireScripts("playwright");
const modelRoot = process.env.SEARCH_MODEL_PATH || path.join(ROOT, ".cache/search-model", SEARCH_CONFIG.revision);
const runtimeRoot = path.join(ROOT, ".cache/search-runtime", SEARCH_CONFIG.runtime.transformers);
const runtimeFiles = new Map(Object.keys(RUNTIME_ARTIFACTS).map((file) => [runtimeUrl(file), file]));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".png": "image/png", ".wasm": "application/wasm",
};

export async function verifyCachedModel() {
  for (const [file, hash] of Object.entries(SEARCH_CONFIG.artifacts)) {
    assert.equal(digest(await readFile(path.join(modelRoot, file))), hash, `cached artifact: ${file}`);
  }
}

export async function verifyCachedRuntime() {
  for (const [file, hash] of Object.entries(RUNTIME_ARTIFACTS)) {
    assert.equal(digest(await readFile(path.join(runtimeRoot, file))), hash, `cached runtime artifact: ${file}`);
  }
}

export async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith("/models/")) {
        const prefix = `/models/${SEARCH_CONFIG.revision}/`;
        const file = pathname.slice(prefix.length);
        if (!pathname.startsWith(prefix) || !Object.hasOwn(SEARCH_CONFIG.artifacts, file)) {
          res.writeHead(404).end();
          return;
        }
        const bytes = await readFile(path.join(modelRoot, file));
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range");
        if (req.headers.range === "bytes=0-0") {
          res.writeHead(206, { "Content-Range": `bytes 0-0/${bytes.length}` });
          res.end(bytes.subarray(0, 1));
        } else {
          res.writeHead(200, { "Content-Length": bytes.length });
          res.end(bytes);
        }
        return;
      }
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.resolve(DOCS, `.${pathname}`);
      if (!file.startsWith(`${DOCS}${path.sep}`)) {
        res.writeHead(403).end();
        return;
      }
      const bytes = await readFile(file);
      res.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      }).end(bytes);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

export async function instrument(context, origin, { noGPU = false, localModel = true, localRuntime = true } = {}) {
  const requests = [];
  const violations = [];
  context.on("request", (request) => {
    requests.push({ url: request.url(), method: request.method(), body: request.postData() });
    const url = new URL(request.url());
    if (request.method() !== "GET" || request.postData() !== null) {
      violations.push(`Unexpected request method/body: ${request.method()} ${request.url()}`);
    }
    if (url.origin !== origin && !runtimeFiles.has(request.url()) && !(url.origin === "https://huggingface.co" &&
      url.pathname.startsWith(`/${SEARCH_CONFIG.model}/resolve/${SEARCH_CONFIG.revision}/`))) {
      violations.push(`Unpinned or unexpected network request: ${request.url()}`);
    }
  });
  await context.addInitScript(({ noGPU }) => {
    if (noGPU) Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
    window.searchTest = { workers: [], vectors: [], progress: [] };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        if (!String(url).includes("/search-worker.js")) return;
        const record = { url: String(url), sent: [], received: [] };
        window.searchTest.workers.push(record);
        const send = this.postMessage.bind(this);
        this.postMessage = (data, ...rest) => {
          record.sent.push(data);
          return send(data, ...rest);
        };
        this.addEventListener("message", ({ data }) => {
          record.received.push(data.type);
          if (data.type === "vector") {
            const query = record.sent.find((message) => message.type === "encode" && message.id === data.id)?.query;
            window.searchTest.vectors.push({
              id: data.id, query, typed: data.vector instanceof Float32Array, vector: Array.from(data.vector),
            });
          }
        });
      }
    };
    new MutationObserver(() => {
      const progress = document.querySelector("#search-progress");
      if (progress && !progress.hidden && progress.hasAttribute("value")) {
        window.searchTest.progress.push({
          value: progress.value,
          text: document.querySelector("#search-status")?.textContent,
        });
      }
    }).observe(document, { subtree: true, childList: true, attributes: true });
  }, { noGPU });
  if (localRuntime) {
    await context.route("https://cdn.jsdelivr.net/**", async (route) => {
      const file = runtimeFiles.get(route.request().url());
      if (!file) {
        violations.push(`Unexpected runtime download: ${route.request().url()}`);
        await route.abort();
        return;
      }
      const bytes = await readFile(path.join(runtimeRoot, file));
      assert.equal(digest(bytes), RUNTIME_ARTIFACTS[file], `runtime served to browser: ${file}`);
      await route.fulfill({
        contentType: file.endsWith(".wasm") ? "application/wasm" : "text/javascript",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: bytes,
      });
    });
  }
  if (localModel) {
    await context.route("https://huggingface.co/**", async (route) => {
      const url = new URL(route.request().url());
      const prefix = `/${SEARCH_CONFIG.model}/resolve/${SEARCH_CONFIG.revision}/`;
      const file = url.pathname.slice(prefix.length);
      if (!url.pathname.startsWith(prefix) || !Object.hasOwn(SEARCH_CONFIG.artifacts, file)) {
        violations.push(`Unexpected model artifact: ${url.pathname}`);
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 302, body: "",
        headers: {
          location: `${origin}/models/${SEARCH_CONFIG.revision}/${file}`,
          "Access-Control-Allow-Origin": "*",
        },
      });
    });
  }
  return { requests, violations };
}

export async function waitState(page, state, timeout = 300_000) {
  await page.waitForFunction((expected) => {
    const status = document.querySelector("#search-status");
    if (expected !== "error" && status?.dataset.state === "error") throw new Error(status.textContent);
    return status?.dataset.state === expected;
  }, state, { timeout });
}

export async function waitBoot(page, locale) {
  await page.waitForFunction((prefix) =>
    document.querySelector("#boot-status")?.textContent.startsWith(prefix), locale.ready, { timeout: 60_000 });
  assert.equal(await page.locator("#chat-input").isEnabled(), true);
  assert.equal(await page.locator("#search-status").getAttribute("role"), "status");
}

export async function ask(page, query) {
  await page.locator("#chat-input").waitFor();
  const before = await page.locator(".chat-message.assistant").count();
  await page.fill("#chat-input", query);
  await page.click("#chat-form button[type=submit]");
  const bubble = page.locator(".chat-message.assistant").nth(before);
  await bubble.waitFor({ timeout: 90_000 });
  return bubble;
}

export async function replyText(bubble) {
  return bubble.evaluate((element) => {
    const prose = element.cloneNode(true);
    prose.querySelectorAll(".hits-table, .reasoning").forEach((node) => node.remove());
    return prose.textContent.trim();
  });
}

export async function assertKeyword(bubble, locale) {
  const badges = await bubble.locator(".match-badge").allTextContents();
  assert.ok(badges.length > 0, "keyword result rows exist");
  assert.ok(badges.every((text) => text === locale.t.keywordMatch), `keyword labels: ${badges}`);
  assert.equal(await bubble.locator(".match-badge:not(.keyword)").count(), 0);
  assert.equal(await bubble.locator(".match-badge.exact").count(), 0);
}
