/**
 * Optional, fully local RAG layer using WebLLM (@mlc-ai/web-llm).
 *
 * Never auto-downloads the model — only starts on explicit user click of
 * "Enable local AI answers". Once loaded, everything (retrieval + prompt +
 * generation) runs in-browser; no network calls carry the user's question
 * or the bug data anywhere.
 */

// Pin an exact web-llm version for reproducibility.
const WEBLLM_CDN_URL = "https://esm.run/@mlc-ai/web-llm@0.2.79";
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";
const TOP_K_FOR_CONTEXT = 8;

const enableBtn = document.getElementById("rag-enable-btn");
const ragStatus = document.getElementById("rag-status");
const ragForm = document.getElementById("rag-form");
const ragInput = document.getElementById("rag-input");
const ragAnswer = document.getElementById("rag-answer");

let engine = null;

function setStatus(msg) {
  ragStatus.textContent = msg;
}

async function enableLocalAI() {
  enableBtn.disabled = true;
  setStatus("Downloading local AI model… this can take a while the first time.");
  try {
    const webllm = await import(WEBLLM_CDN_URL);
    engine = await webllm.CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (progress) => {
        setStatus(progress.text || "Loading model…");
      },
    });
    setStatus("Local AI ready. Ask a question below.");
    ragForm.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load local AI: ${err.message}`);
    enableBtn.disabled = false;
  }
}

function buildPrompt(question, hits) {
  const context = hits
    .map((h) => `[${h.reference}] ${h.summary.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are a helpful assistant answering questions about 4D software bug fixes. " +
        "Answer ONLY using the bug reports provided below. Always cite the ACI reference " +
        "(e.g. ACI0092218) for any claim you make. If the provided reports don't answer the " +
        "question, say so plainly instead of guessing.",
    },
    {
      role: "user",
      content: `Bug reports:\n\n${context}\n\nQuestion: ${question}`,
    },
  ];
}

function renderAnswer(text, hits) {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const linked = escaped.replace(/\b(ACI\d+)\b/g, (m, ref) => {
    const known = hits.some((h) => h.reference === ref);
    return known ? `<span class="citation" data-ref="${ref}">${ref}</span>` : ref;
  });
  ragAnswer.innerHTML = linked;
  ragAnswer.querySelectorAll(".citation").forEach((el) => {
    el.addEventListener("click", () => {
      document
        .getElementById(`result-${el.dataset.ref}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

ragForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = ragInput.value.trim();
  if (!question || !engine) return;
  setStatus("Retrieving relevant bug reports…");
  ragAnswer.textContent = "";
  try {
    const hits = await window.__bugSearch.search(question, TOP_K_FOR_CONTEXT);
    setStatus("Generating answer locally…");
    const messages = buildPrompt(question, hits);
    const reply = await engine.chat.completions.create({ messages });
    const text = reply.choices[0].message.content;
    renderAnswer(text, hits);
    setStatus("Done.");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
});

enableBtn.addEventListener("click", enableLocalAI);
