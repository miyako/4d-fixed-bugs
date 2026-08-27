/**
 * Chat engine backed by LiquidAI's LFM2.5-1.2B-Thinking (ONNX export),
 * run client-side over WebGPU via `@huggingface/transformers`.
 *
 * Unlike WebLLM's high-level `engine.chat.completions.create()`, this model
 * isn't wired up to a turnkey chat runtime — `@huggingface/transformers`
 * gives us `tokenizer` + `model.generate()` primitives and we drive the
 * chat-template application and streaming/state-tracking ourselves, mirroring
 * the reference implementation (github.com/sitammeur/lfm2.5-thinking-web,
 * `src/worker.js`). Its `model.generate()` internally runs the step-by-step
 * autoregressive ONNX Runtime Web session loop (feeding input_ids/
 * attention_mask/KV-cache tensors in and reading `present.*` tensors back out
 * each step) — we don't need to hand-roll that plumbing ourselves since the
 * library already implements it for exactly this kind of model.
 *
 * The model emits a `<think>...</think>` block ahead of its actual answer.
 * We track start/end-of-thinking token ids via a token-level callback (same
 * approach as the reference `worker.js`) to split the streamed output into
 * `thinking` and `text` (the final answer), so callers can show/hide the
 * reasoning separately instead of dumping it into the visible reply.
 *
 * Deliberate simplification vs. the reference implementation: the reference
 * app persists a `past_key_values` cache across turns of one continuous
 * conversation. Our app rebuilds the *system* message (retrieved bug
 * context) from scratch every turn, so the prompt isn't a simple append to
 * the previous turn's tokens — reusing a KV cache across turns would be
 * incorrect here. We re-encode the full conversation each turn instead
 * (same tradeoff the WebLLM engine already makes), trading some latency for
 * correctness.
 */

// Deliberately the "web" build, not `dist/transformers.min.js` (the
// universal/isomorphic build that `main`/package exports resolve to by
// default for bundlers). Loading the universal build directly as a bare
// ESM import from a CDN — outside of a bundler that applies the
// package's "browser"/"default" export condition — leaves ONNX Runtime
// Web's WebGPU backend mis-wired, producing a
// "webgpuInit is not a function" error at model load time even on a
// WebGPU-capable browser. `dist/transformers.web.min.js` is the exact
// browser build the package.json `exports.default` field points bundlers
// at, and works correctly when imported directly like this too.
const TRANSFORMERS_CDN_URL =
  "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.web.min.js";
const MODEL_ID = "LiquidAI/LFM2.5-1.2B-Thinking-ONNX";
const MAX_NEW_TOKENS = 2048;

export const engineLabel = "LFM2.5-1.2B-Thinking (ONNX/WebGPU)";

/** Feature-detect WebGPU the same way the reference worker does. */
export async function isWebGPUAvailable() {
  if (!("gpu" in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

export function createEngine() {
  let tokenizer = null;
  let model = null;

  return {
    label: engineLabel,

    /** @param {(text: string) => void} onProgress */
    async init(onProgress) {
      const gpuOk = await isWebGPUAvailable();
      if (!gpuOk) {
        throw new Error("WebGPU is not available in this browser (no adapter found).");
      }

      onProgress("Loading LFM2.5-Thinking tokenizer + model files…");
      const { AutoTokenizer, AutoModelForCausalLM } = await import(TRANSFORMERS_CDN_URL);

      const progress_callback = (p) => {
        if (p && p.status === "progress" && p.file) {
          const pct = p.progress != null ? ` ${Math.round(p.progress)}%` : "";
          onProgress(`Downloading ${p.file}${pct}…`);
        } else if (p && p.status) {
          onProgress(`${p.status}…`);
        }
      };

      [tokenizer, model] = await Promise.all([
        AutoTokenizer.from_pretrained(MODEL_ID, { progress_callback }),
        AutoModelForCausalLM.from_pretrained(MODEL_ID, {
          dtype: "q4",
          device: "webgpu",
          progress_callback,
        }),
      ]);

      onProgress("Compiling shaders and warming up model…");
      const warmup = tokenizer("a");
      await model.generate({ ...warmup, max_new_tokens: 1 });
    },

    /**
     * @param {{role: string, content: string}[]} messages
     * @returns {Promise<{text: string, thinking: string|null}>}
     */
    async chat(messages) {
      const { TextStreamer } = await import(TRANSFORMERS_CDN_URL);

      const inputs = tokenizer.apply_chat_template(messages, {
        add_generation_prompt: true,
        return_dict: true,
      });

      const [startThinkId, endThinkId] = tokenizer.encode("<think></think>", {
        add_special_tokens: false,
      });

      let state = "thinking";
      let thinkingText = "";
      let answerText = "";

      const token_callback_function = (tokens) => {
        switch (Number(tokens[0])) {
          case startThinkId:
            state = "thinking";
            break;
          case endThinkId:
            state = "answering";
            break;
        }
      };
      const callback_function = (output) => {
        if (state === "thinking") thinkingText += output;
        else answerText += output;
      };

      const streamer = new TextStreamer(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function,
        token_callback_function,
      });

      await model.generate({
        ...inputs,
        do_sample: true,
        temperature: 0.05,
        top_p: 0.1,
        repetition_penalty: 1.05,
        max_new_tokens: MAX_NEW_TOKENS,
        streamer,
        return_dict_in_generate: true,
      });

      // Defensive fallback: if the model never emitted an
      // end-of-thinking token (so everything landed in `thinkingText`),
      // strip any literal <think>...</think> block out of it instead of
      // showing an empty answer.
      let text = answerText.trim();
      let thinking = thinkingText.trim() || null;
      if (!text && thinking) {
        text = thinking.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
      }
      if (!text) text = "(the model produced no answer text)";

      return { text, thinking };
    },

    reset() {
      // No cross-turn KV cache is kept (see file header note), so there's
      // nothing to clear between turns.
    },
  };
}
