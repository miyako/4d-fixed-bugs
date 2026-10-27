import { SEARCH_CONFIG, queryText, normalizedVector, textOnlyConfig } from "./search-config.js";
import { TRANSFORMERS_URL, ORT_BASE_URL } from "./runtime-config.js";

let model, tokenizer;

async function load() {
  const { AutoConfig, AutoModel, AutoTokenizer, env } = await import(TRANSFORMERS_URL);
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  // Transformers' tokenizer metadata probe does not always forward revision.
  env.remotePathTemplate = `{model}/resolve/${SEARCH_CONFIG.revision}/`;
  env.backends.onnx.wasm.wasmPaths = ORT_BASE_URL;
  env.backends.onnx.wasm.numThreads = 1;
  const options = {
    revision: SEARCH_CONFIG.revision,
    progress_callback: (progress) => self.postMessage({
      type: "progress", file: progress.file, progress: progress.progress ?? null,
    }),
  };
  const config = textOnlyConfig(await AutoConfig.from_pretrained(SEARCH_CONFIG.model, options));
  model = await AutoModel.from_pretrained(SEARCH_CONFIG.model, {
    ...options, config, device: "webgpu", dtype: SEARCH_CONFIG.precision,
  });
  tokenizer = await AutoTokenizer.from_pretrained(SEARCH_CONFIG.model, options);
  self.postMessage({ type: "ready" });
}

async function encode({ id, query }) {
  if (!model || !tokenizer) throw new Error("Search model is not ready");
  const output = await model(await tokenizer(queryText(query), {
    truncation: true, max_length: SEARCH_CONFIG.maxTokens,
  }));
  const vector = normalizedVector(output.sentence_embedding?.data);
  self.postMessage({ type: "vector", id, vector }, [vector.buffer]);
}

let queue = Promise.resolve();
self.onmessage = ({ data }) => {
  queue = queue.then(() => data.type === "load" ? load() : encode(data))
    .catch((error) => self.postMessage({ type: "error", id: data.id, error: String(error.message || error) }));
};
