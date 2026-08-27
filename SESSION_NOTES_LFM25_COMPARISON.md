# Session Notes: LFM2.5-1.2B-Thinking Engine Comparison

Tracked by GitHub issue #3. This is exploratory work on the
`miyako-lfm25-thinking-engine-experiment` branch, stacked on top of the
working WebLLM-based chat from `miyako-jubilant-carnival` (see
`SESSION_NOTES_SEMANTIC_SEARCH.md`). **Nothing about the shipped WebLLM
path was removed or changed in behavior** — this branch only adds an
alternative engine behind a flag, for direct comparison.

## What was built

A pluggable "chat engine" abstraction so `docs/src/app.js` doesn't need to
know which local-model runtime is powering the chat:

```
docs/src/engines/
  webllm-engine.js   <- wraps the existing @mlc-ai/web-llm logic (unchanged behavior)
  lfm25-engine.js    <- new: LiquidAI/LFM2.5-1.2B-Thinking via @huggingface/transformers (ONNX/WebGPU)
```

Both export `createEngine()` returning an object with:

- `init(onProgress)` — loads/downloads the model, reporting boot-status text.
- `chat(messages) -> Promise<{text, thinking}>` — `text` is the final
  answer; `thinking` is the model's reasoning (or `null` if the engine
  doesn't produce one, e.g. WebLLM/Llama).
- `reset()` — no-op for both today (see "Design decisions" below).

`app.js` selects the engine via a single constant, `DEFAULT_CHAT_ENGINE`
(`"webllm"` by default), near the top of the file, and lets it be
overridden per-session with a `?engine=lfm25` URL query param purely as a
manual/automated testing convenience (no other app code needs to change to
try the other engine).

Assistant chat bubbles now optionally render a collapsible
`<details class="reasoning">Show reasoning</details>` block above the
answer when `thinking` is non-null, styled distinctly (dashed border,
muted text) in `docs/style.css`. For WebLLM this block simply never
appears, since it doesn't emit reasoning text.

## Design decisions / deviations from the reference implementation

- **Reference implementation studied:**
  [sitammeur/lfm2.5-thinking-web](https://github.com/sitammeur/lfm2.5-thinking-web)
  (`src/worker.js`). Its `generate()` calls `model.generate()` from
  `@huggingface/transformers`, which itself drives the token-by-token
  ONNX Runtime Web session loop (feeding `input_ids`/`attention_mask`/
  KV-cache tensors in, reading `present.*` tensors back out) — the library
  already implements exactly the "manual" loop described in issue #3, so
  `lfm25-engine.js` calls that same high-level `model.generate()` API
  rather than re-implementing raw `onnxruntime-web` tensor plumbing by
  hand. This matches what the reference app itself does; it is not a
  shortcut around the hard part, the hard part is already solved by
  `@huggingface/transformers`.
- **No cross-turn KV-cache reuse.** The reference app reuses
  `past_key_values` across turns of one continuous conversation. Our
  system prompt (retrieved bug context) is rebuilt from scratch every
  turn based on the latest message, so the prompt isn't a simple
  append-only continuation of the previous turn's tokens — reusing a
  cached KV state across turns would be incorrect here. `lfm25-engine.js`
  re-encodes and regenerates from the full conversation every turn
  instead (the same tradeoff the WebLLM engine already makes via
  `chat.completions.create({messages})`), trading latency for
  correctness.
- **`<think>` parsing:** mirrors the reference's token-callback approach
  (watching for the `<think>`/`</think>` token ids via
  `tokenizer.encode("<think></think>", {add_special_tokens:false})` and
  a `TextStreamer` `token_callback_function`/`callback_function` pair) to
  split streamed output into `thinking` vs. `text` buffers. A defensive
  fallback strips a literal `<think>...</think>` span if the model never
  emits an end token, so the UI never shows an empty answer.
- **No Web Worker.** The reference app runs generation in a dedicated
  worker (`src/worker.js`) to keep the UI thread responsive during
  long generations. This prototype runs both engines on the main thread,
  same as the existing WebLLM integration, to keep the abstraction change
  minimal — a real product decision to ship LFM2.5 should move heavy
  inference off the main thread.

## Testing performed

**Real end-to-end (with actual model downloads) was not possible in this
environment.** Verified directly with Playwright + headless Chromium
(`chromium.launch()`, with and without
`--enable-unsafe-webgpu`/`--enable-features=Vulkan,Metal` flags, headed
and headless):

```js
await page.evaluate(() => !!navigator.gpu) // => false, always
```

`navigator.gpu` is `undefined` in every configuration tried on this
sandboxed macOS arm64 host (no Vulkan/Metal GPU passthrough is available
to the browser process; `chrome://gpu` isn't even reachable —
`net::ERR_FAILED`). This blocks real inference for **both** engines
equally (WebGPU is required either way, per issue #3's compatibility
table) — it's an environment limitation, not something specific to
LFM2.5. Real-model comparison (answer quality, groundedness, refusal
behavior on the "tab control" prompts) needs to happen in an actual
WebGPU-capable browser (e.g. the user's own machine/Chrome), not in this
sandbox.

What **was** verified here, via `page.route()` CDN interception (the same
mocking technique the parent session used for WebLLM, applied to both
engines this time for a fair comparison):

- Both `webllm-engine.js` and `lfm25-engine.js` boot correctly behind
  their respective `?engine=` flag, driving `app.js`'s boot-status line
  via `onProgress`, and enable the chat input once ready.
- `navigator.gpu`/`requestAdapter` was stubbed via `page.addInitScript`
  so `lfm25-engine.js`'s `isWebGPUAvailable()` preflight check passes,
  exercising the real code path up to (but not including) actual
  `onnxruntime-web` execution.
- Retrieval → system-prompt construction → `engine.chat(messages)` →
  rendering works identically for both engines: the deterministic hits
  table renders, citations get highlighted, and conversation state
  (`bugsContext`, now also `thinking`) round-trips correctly.
- For the LFM2.5 mock: simulated streamed output that starts in "thinking"
  state then switches to "answering" after a fake end-of-think token
  correctly splits into the collapsible `<details class="reasoning">`
  block (containing only the "thinking" text) and the visible answer
  (containing only the post-think text) — confirming the `<think>` tag
  handling and UI wiring work end-to-end at the code-path level.
- Zero console/page errors in either engine's flow.

**Not verified (needs a real WebGPU browser):** actual `model_q4.onnx`
download size/time, real tokenizer/model compatibility with the pinned
`@huggingface/transformers@4.2.0` CDN build, and — most importantly —
answer quality/groundedness/refusal-avoidance differences between the two
real models on the "tab control" prompts from issue #3.

## Recommendation

**Keep WebLLM as the shipped default; keep LFM2.5 behind the flag as an
opt-in comparison path, not a switch.** Rationale:

1. The core question issue #3 was raised to answer — does LFM2.5's
   "thinking" training actually reduce spurious refusals / improve
   groundedness versus Llama-3.2-1B-Instruct — **could not be evaluated
   in this sandbox** (no WebGPU). That comparison needs to happen in a
   real browser before any default-switching decision is justified.
2. Code complexity added is real but contained: ~180 lines
   (`lfm25-engine.js`) plus a small, clean interface seam in `app.js`
   (~15 lines) and CSS. The abstraction itself is a net positive
   regardless of which model wins — it's low-risk, doesn't touch the
   working WebLLM path's behavior, and makes future model experiments
   (e.g. Phi-3.5-mini, mentioned as a follow-up in
   `SESSION_NOTES_SEMANTIC_SEARCH.md`) cheaper to try.
3. LFM2.5's ~1.2GB (q4) model is somewhat larger than WebLLM's current
   ~700MB-1GB Llama-3.2-1B-Instruct (q4f16), a real download-time/UX cost
   for a static, no-backend page whose whole pitch is "runs entirely in
   your browser" — worth it only if the quality difference is clearly
   better in real testing, not assumed.
4. Given (1)-(3): merge this branch's abstraction as infrastructure
   (pluggable engines) without changing the default, then have someone
   run the real side-by-side comparison in an actual WebGPU browser
   before deciding whether to switch the default or expose a
   user-facing model picker.

## Update: comparison build abandoned/removed

After publishing `/lfm25/` on GitHub Pages, real-browser testing hit a
persistent `webgpuInit is not a function` / "does not resolve to a
valid URL" error that survived three different fix attempts:

1. A hand-written `<script type="importmap">` pinning the bare
   specifiers `onnxruntime-web/webgpu` and `onnxruntime-common` to
   specific jsdelivr dist files (matching `@huggingface/transformers`'s
   own pinned dependency versions).
2. Forcing `env.backends.onnx.wasm.numThreads = 1` to avoid the
   `SharedArrayBuffer`/cross-origin-isolation requirement that GitHub
   Pages can't satisfy (no custom response headers available).
3. Replacing the raw CDN dist file + import map with jsdelivr's `+esm`
   endpoint, which performs full bundler-style "exports"-map and
   nested-dependency resolution automatically.

Each fix addressed a real, verifiable problem (confirmed in headless
Chromium up to the point our sandbox's lack of a GPU adapter stops
further testing), but the underlying `webgpuInit` wiring inside
onnxruntime-web's WebGPU/JSEP backend kept failing on the user's real
GPU-capable browser regardless. Given transformers.js's own GitHub
issues confirm this exact error is a known, currently-unresolved
upstream fragility in onnxruntime-web's WebGPU backend when loaded
outside of a from-scratch bundled app (its own official demo apps hit
variants of this too, e.g. huggingface/transformers.js#1604, #1678),
further CDN/import-map/threading workarounds were not a productive use
of time without a real WebGPU-capable browser + devtools to iterate in
directly.

**Decision: abandon the LFM2.5 comparison build.** Removed
`docs/lfm25/`, `docs/src/engines/lfm25-engine.js`, and all references
to them from `docs/src/app.js`. The pluggable chat-engine abstraction
itself (the `{init, chat, reset}` interface, `webllm-engine.js`, and
the `CHAT_ENGINE`/`?engine=` seam) is kept — it's low-risk, generic,
and still valuable if a different local-LLM engine is tried in the
future via a real bundler (Vite/webpack) rather than raw CDN ESM, which
would very likely sidestep this whole class of bug. WebLLM remains the
only LLM engine option (deterministic search stays the default), and
is unaffected by any of this.
