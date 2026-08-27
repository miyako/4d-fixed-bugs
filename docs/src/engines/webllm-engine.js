/**
 * Chat engine backed by WebLLM (@mlc-ai/web-llm), running
 * `Llama-3.2-1B-Instruct-q4f16_1-MLC` fully client-side over WebGPU.
 *
 * This is the shipped, working engine (see SESSION_NOTES_SEMANTIC_SEARCH.md).
 * It implements the shared engine interface documented in `engine.js`.
 */

const WEBLLM_CDN_URL = "https://esm.run/@mlc-ai/web-llm@0.2.79";
const CHAT_MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

export const engineLabel = "WebLLM (Llama-3.2-1B-Instruct)";

export function createEngine() {
  let engine = null;

  return {
    label: engineLabel,

    /** @param {(text: string) => void} onProgress */
    async init(onProgress) {
      const webllm = await import(WEBLLM_CDN_URL);
      engine = await webllm.CreateMLCEngine(CHAT_MODEL_ID, {
        initProgressCallback: (progress) => {
          onProgress(progress.text || "Loading local AI model…");
        },
      });
    },

    /**
     * @param {{role: string, content: string}[]} messages
     * @returns {Promise<{text: string, thinking: string|null}>}
     */
    async chat(messages) {
      const reply = await engine.chat.completions.create({ messages });
      return { text: reply.choices[0].message.content, thinking: null };
    },

    reset() {
      // WebLLM's chat.completions.create is stateless per-call (we resend
      // the whole conversation every turn), so there's no engine-side
      // state to clear.
    },
  };
}
