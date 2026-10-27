import { assertIndexContract } from "./search-config.js";

const hash = async (bytes) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
  .map((value) => value.toString(16).padStart(2, "0")).join("");

async function fetchAsset(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Search asset HTTP ${response.status}`);
  return response;
}

export class SemanticSearch {
  constructor({ dataUrl, records, onState }) {
    this.dataUrl = dataUrl;
    this.records = records;
    this.onState = onState;
    this.status = "loading";
    this.vectors = null;
    this.worker = null;
    this.pending = new Map();
    this.generation = 0;
    this.sequence = 0;
  }

  state(status, detail = {}) {
    this.status = status;
    this.onState({ status, ...detail });
  }

  fail(error) {
    console.warn("Semantic search unavailable; using keyword search.", error);
    this.generation++;
    this.worker?.terminate();
    this.worker = null;
    this.vectors = null;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.state("error", { error: error.message });
  }

  async start() {
    const generation = ++this.generation;
    this.worker?.terminate();
    this.worker = null;
    this.vectors = null;
    this.state("loading");
    try {
      if (!navigator.gpu || !await navigator.gpu.requestAdapter()) {
        if (generation === this.generation) this.state("unavailable");
        return;
      }
      const manifest = await (await fetchAsset(this.dataUrl("search-index.json"))).json();
      assertIndexContract(manifest, this.records.length);
      if (manifest.metadata_sha256 !== await hash(new TextEncoder().encode(JSON.stringify(this.records)))) {
        throw new Error("Search corpus changed; rebuild the index");
      }
      const bytes = await (await fetchAsset(this.dataUrl("embeddings.bin"))).arrayBuffer();
      if (bytes.byteLength !== manifest.bytes || await hash(bytes) !== manifest.vectors_sha256) {
        throw new Error("Search index checksum mismatch");
      }
      const view = new DataView(bytes);
      const vectors = Float32Array.from({ length: bytes.byteLength / 4 },
        (_, i) => view.getFloat32(i * 4, true));
      if (generation !== this.generation) return;
      this.vectors = vectors;
      const worker = new Worker(new URL("./search-worker.js", import.meta.url), { type: "module" });
      this.worker = worker;
      await new Promise((resolve, reject) => {
        let initialized = false;
        const timer = setTimeout(() => reject(new Error("Search model loading timed out")), 300_000);
        worker.onmessage = ({ data }) => {
          if (generation !== this.generation) return;
          if (data.type === "progress") this.onState({ status: "loading", ...data });
          if (data.type === "ready") {
            initialized = true;
            clearTimeout(timer);
            resolve();
          }
          if (data.type === "error") {
            const error = new Error(data.error);
            if (!initialized) {
              clearTimeout(timer);
              reject(error);
            } else {
              this.fail(error);
            }
          }
          if (data.type === "vector") {
            const request = this.pending.get(data.id);
            if (request) {
              this.pending.delete(data.id);
              request.resolve(data.vector);
            }
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          const error = new Error(event.message || "Search worker failed");
          clearTimeout(timer);
          if (!initialized) reject(error);
          else this.fail(error);
        };
        worker.postMessage({ type: "load" });
      });
      if (generation === this.generation) this.state("ready");
    } catch (error) {
      if (generation === this.generation) this.fail(error);
    }
  }

  encode(query) {
    if (this.status !== "ready") throw new Error("Semantic search is not ready");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error("Search query timed out")), 60_000);
      this.pending.set(id, {
        resolve: (vector) => { clearTimeout(timer); resolve(vector); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.worker.postMessage({ type: "encode", id, query });
    });
  }
}
