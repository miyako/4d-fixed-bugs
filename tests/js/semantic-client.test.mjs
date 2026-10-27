import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SemanticSearch } from "../../docs/src/semantic-client.js";
import { SEARCH_CONFIG } from "../../docs/src/search-config.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const records = [{ reference: "ACI0000001", summary: "A fixed bug.", commands: [], versions: ["20"] }];
const vector = new Float32Array(768);
vector[0] = 1;
const bytes = Buffer.from(vector.buffer);
const validManifest = {
  contract: SEARCH_CONFIG, count: 1, bytes: bytes.length,
  metadata_sha256: digest(JSON.stringify(records)), vectors_sha256: digest(bytes),
};

async function fixture({ gpu = true, manifest = validManifest, corrupt = false } = {}, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, "gpu");
  const originalFetch = globalThis.fetch;
  const originalWorker = globalThis.Worker;
  const requests = [], workers = [], states = [];
  Object.defineProperty(navigator, "gpu", { configurable: true, value: gpu ? { requestAdapter: async () => ({}) } : undefined });
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return String(url).endsWith("search-index.json")
      ? new Response(JSON.stringify(manifest), { headers: { "content-type": "application/json" } })
      : new Response(corrupt ? new Uint8Array(bytes.length) : bytes);
  };
  class Worker {
    constructor() { workers.push(this); }
    postMessage(data) {
      queueMicrotask(() => this.onmessage({ data: data.type === "load"
        ? { type: "ready" } : { type: "vector", id: data.id, vector } }));
    }
    terminate() { this.terminated = true; }
  }
  globalThis.Worker = Worker;
  const client = new SemanticSearch({
    dataUrl: (name) => `https://example.test/data/${name}`, records, onState: (state) => states.push(state),
  });
  try {
    await fn({ client, requests, workers, states });
  } finally {
    client.worker?.terminate();
    globalThis.fetch = originalFetch;
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
    if (descriptor) Object.defineProperty(navigator, "gpu", descriptor);
    else delete navigator.gpu;
  }
}

test("no WebGPU keeps keyword mode without requesting vectors, runtime or model", async () => {
  await fixture({ gpu: false }, async ({ client, requests, workers, states }) => {
    await client.start();
    assert.equal(client.status, "unavailable");
    assert.deepEqual(states.map((state) => state.status), ["loading", "unavailable"]);
    assert.deepEqual(requests, []);
    assert.equal(workers.length, 0);
    assert.throws(() => client.encode("printing"), /not ready/);
  });
});

test("stale model contract or corrupted vectors explicitly fail before loading a model", async () => {
  for (const options of [{ manifest: { ...validManifest, contract: { ...SEARCH_CONFIG, revision: "stale" } } }, { corrupt: true }]) {
    await fixture(options, async ({ client, workers, states }) => {
      await client.start();
      assert.equal(client.status, "error");
      assert.match(states.at(-1).error, /contract|checksum/);
      assert.equal(workers.length, 0);
    });
  }
});

test("verified model queries use the worker and normalized 768d vectors", async () => {
  await fixture({}, async ({ client, workers, requests }) => {
    await client.start();
    assert.equal(client.status, "ready");
    assert.equal(client.vectors.length, 768);
    assert.deepEqual(await client.encode("printing"), vector);
    assert.equal(client.pending.size, 0);
    assert.equal(workers.length, 1);
    assert.equal(requests.length, 2);
  });
});

test("query-time worker failure rejects the query, retains keyword mode, and retries only on request", async () => {
  await fixture({}, async ({ client, workers, states }) => {
    await client.start();
    workers[0].postMessage = (data) => queueMicrotask(() =>
      workers[0].onmessage({ data: { type: "error", id: data.id, error: "GPU device lost" } }));
    await assert.rejects(client.encode("printing"), /GPU device lost/);
    assert.equal(client.status, "error");
    assert.equal(workers[0].terminated, true);
    assert.equal(client.pending.size, 0);
    assert.equal(workers.length, 1);
    assert.equal(states.at(-1).error, "GPU device lost");
    await client.start();
    assert.equal(client.status, "ready");
    assert.equal(workers.length, 2);
  });
});
