import { mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { SEARCH_CONFIG } from "../docs/src/search-config.js";
import { RUNTIME_ARTIFACTS, runtimeUrl } from "../docs/src/runtime-config.js";

const require = createRequire(import.meta.url);
const transformersRequire = createRequire(require.resolve("@huggingface/transformers"));
const output = new URL(`../docs/search-runtime/${SEARCH_CONFIG.runtime.transformers}/`, import.meta.url);
const cache = new URL(`../.cache/search-runtime/${SEARCH_CONFIG.runtime.transformers}/`, import.meta.url);
const transformers = new URL("../", pathToFileURL(require.resolve("@huggingface/transformers")));
const ort = new URL("../", pathToFileURL(transformersRequire.resolve("onnxruntime-web")));
const versions = {
  transformers: JSON.parse(await readFile(new URL("package.json", transformers))).version,
  onnxruntime: JSON.parse(await readFile(new URL("package.json", ort))).version,
};
if (JSON.stringify(versions) !== JSON.stringify(SEARCH_CONFIG.runtime)) {
  throw new Error(`Incompatible search runtime: ${JSON.stringify(versions)}`);
}
await mkdir(output, { recursive: true });
await mkdir(cache, { recursive: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
for (const [file, expected] of Object.entries(RUNTIME_ARTIFACTS)) {
  const source = file === "transformers.min.js"
    ? new URL(`dist/${file}`, transformers) : new URL(`dist/${file}`, ort);
  const packageBytes = await readFile(source);
  if (hash(packageBytes) !== expected) throw new Error(`npm runtime checksum mismatch: ${file}`);
  if (file === "transformers.min.js" && !packageBytes.toString("utf8").includes(versions.onnxruntime)) {
    throw new Error("Official browser distribution embeds an incompatible ONNX Runtime");
  }
  const target = new URL(file, cache);
  let bytes;
  try {
    bytes = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!bytes || hash(bytes) !== expected) {
    execFileSync("curl", [
      "--fail", "--location", "--silent", "--show-error", "--retry", "2",
      "--max-time", "180", runtimeUrl(file), "--output", fileURLToPath(target),
    ], { stdio: "inherit" });
    bytes = await readFile(target);
  }
  if (hash(bytes) !== expected) throw new Error(`CDN runtime checksum mismatch: ${file}`);
}
for (const [directory, source, name] of [
  [transformers, "LICENSE", "LICENSE-transformers.txt"],
  [new URL("../", pathToFileURL(transformersRequire.resolve("@huggingface/tokenizers"))), "LICENSE", "LICENSE-tokenizers.txt"],
  [new URL("../", pathToFileURL(transformersRequire.resolve("@huggingface/jinja"))), "LICENSE", "LICENSE-jinja.txt"],
  [ort, "README.md", "README-onnxruntime.txt"],
]) {
  await copyFile(new URL(source, directory), new URL(name, output));
}
await writeFile(new URL("versions.json", output), JSON.stringify(versions) + "\n");
await copyFile(new URL("./ONNX-LICENSE.txt", import.meta.url), new URL("LICENSE-onnxruntime.txt", output));
console.log(`Verified npm/CDN runtime ${versions.transformers} / ONNX Runtime ${versions.onnxruntime}; executables cached outside Git.`);
