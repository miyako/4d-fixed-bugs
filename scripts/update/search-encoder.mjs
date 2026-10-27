import { AutoConfig, AutoModel, AutoTokenizer, env } from "@huggingface/transformers";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SEARCH_CONFIG, normalizedVector, textOnlyConfig } from "../../docs/src/search-config.js";

const cache = new URL("../../.cache/search-model/", import.meta.url);

export async function downloadModel() {
  const directory = new URL(`${SEARCH_CONFIG.revision}/`, cache);
  for (const [file, expected] of Object.entries(SEARCH_CONFIG.artifacts)) {
    const target = new URL(file, directory);
    await mkdir(new URL("./", target), { recursive: true });
    let bytes;
    try {
      bytes = await readFile(target);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== expected) {
      execFileSync("curl", [
        "--fail", "--location", "--silent", "--show-error", "--retry", "2",
        "--max-time", "300",
        `https://huggingface.co/${SEARCH_CONFIG.model}/resolve/${SEARCH_CONFIG.revision}/${file}`,
        "--output", fileURLToPath(target),
      ], { stdio: "inherit" });
      bytes = await readFile(target);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error(`Model checksum mismatch: ${file}`);
    }
  }
  return fileURLToPath(directory);
}

export async function verifyModel(directory) {
  const base = pathToFileURL(directory.endsWith("/") ? directory : directory + "/");
  for (const [file, expected] of Object.entries(SEARCH_CONFIG.artifacts)) {
    const bytes = await readFile(new URL(file, base));
    if (createHash("sha256").update(bytes).digest("hex") !== expected) {
      throw new Error(`Model checksum mismatch: ${file}`);
    }
  }
}

export async function loadEncoder({ localPath, progress } = {}) {
  const directory = localPath || process.env.SEARCH_MODEL_PATH || await downloadModel();
  await verifyModel(directory);
  env.cacheDir = fileURLToPath(cache);
  const config = textOnlyConfig(await AutoConfig.from_pretrained(directory));
  const model = await AutoModel.from_pretrained(directory, {
    config, device: "cpu", dtype: SEARCH_CONFIG.precision, progress_callback: progress,
  });
  const tokenizer = await AutoTokenizer.from_pretrained(directory);
  return {
    async encode(text) {
      const inputs = await tokenizer(text, { truncation: true, max_length: SEARCH_CONFIG.maxTokens });
      const output = await model(inputs);
      return normalizedVector(output.sentence_embedding?.data);
    },
    async encodeMany(texts) {
      const inputs = await tokenizer(texts, { padding: true, truncation: true, max_length: SEARCH_CONFIG.maxTokens });
      const output = await model(inputs);
      const data = output.sentence_embedding?.data;
      if (data?.length !== texts.length * SEARCH_CONFIG.dimensions) {
        throw new Error("Invalid batched sentence_embedding shape");
      }
      return texts.map((_, i) => normalizedVector(data.subarray(
        i * SEARCH_CONFIG.dimensions, (i + 1) * SEARCH_CONFIG.dimensions
      )));
    },
    dispose: () => model.dispose(),
  };
}
