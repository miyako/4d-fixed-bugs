import { renderSummary } from "./render.js";

/**
 * Optional, fully local RAG layer using WebLLM (@mlc-ai/web-llm).
 *
 * Never auto-downloads the model — only starts on explicit user click of
 * "Enable local AI answers". Once loaded, everything (retrieval + prompt +
 * generation) runs in-browser; no network calls carry the user's question
 * or the bug data anywhere.
 *
 * The chat assumes the conversation is about whichever bugs are currently
 * displayed in the results list (the user's subset if they made one,
 * otherwise the full search result set — see main.js's `getActiveBugs()`).
 * Conversation history persists across new searches/subset changes; it is
 * only cleared by the explicit "Clear conversation" button.
 */

// Pin an exact web-llm version for reproducibility.
const WEBLLM_CDN_URL = "https://esm.run/@mlc-ai/web-llm@0.2.79";
const MODEL_ID = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

const enableBtn = document.getElementById("rag-enable-btn");
const ragStatus = document.getElementById("rag-status");
const ragForm = document.getElementById("rag-form");
const ragInput = document.getElementById("rag-input");
const chatEl = document.getElementById("rag-chat");
const clearBtn = document.getElementById("rag-clear-btn");
const copyBtn = document.getElementById("rag-copy-btn");

let engine = null;
/** Persisted conversation turns: [{role: 'user'|'assistant', content, bugsContext}] */
let conversation = [];

function setStatus(msg) {
  ragStatus.textContent = msg;
}

function stripLinks(text) {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function getActiveBugs() {
  return window.__bugSearch?.getActiveBugs() ?? [];
}

/** Render an assistant message's ACI references as clickable citations
 * that scroll to the matching result card. Runs on top of renderSummary's
 * already-safe (HTML-escaped) output, so it just needs a plain-text regex
 * over the rendered markup. */
function linkifyCitations(html, bugs) {
  return html.replace(/\b(ACI\d+)\b/g, (m, ref) => {
    const known = bugs.some((h) => h.reference === ref);
    return known ? `<span class="citation" data-ref="${ref}">${ref}</span>` : ref;
  });
}

function appendBubble(role, text, bugs) {
  const bubble = document.createElement("div");
  bubble.className = `chat-message ${role}`;
  // Both user and assistant text pass through the same safe markdown
  // renderer used for bug summaries (handles links/code/italics and
  // HTML-escapes everything else), so formatting the model may echo back
  // from a bug summary renders consistently instead of showing raw
  // markdown syntax.
  const html = renderSummary(text);
  bubble.innerHTML = role === "assistant" ? linkifyCitations(html, bugs) : html;
  bubble.querySelectorAll?.(".citation").forEach((el) => {
    el.addEventListener("click", () => {
      document
        .getElementById(`result-${el.dataset.ref}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  chatEl.appendChild(bubble);
  chatEl.scrollTop = chatEl.scrollHeight;
  return bubble;
}

function renderConversation() {
  chatEl.innerHTML = "";
  for (const turn of conversation) {
    appendBubble(turn.role, turn.content, turn.bugsContext);
  }
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
    chatEl.hidden = false;
  } catch (err) {
    console.error(err);
    setStatus(`Failed to load local AI: ${err.message}`);
    enableBtn.disabled = false;
  }
}

function buildSystemMessage(bugs) {
  const context = bugs
    .map((h) => `[${h.reference}] ${stripLinks(h.summary)}`)
    .join("\n\n");
  return {
    role: "system",
    content:
      "You are a helpful assistant answering questions about 4D software bug fixes. " +
      "Answer ONLY using the bug reports provided below (the user's currently selected " +
      "subset/list of bugs). Always cite the ACI reference (e.g. ACI0092218) for any claim " +
      "you make. If the provided reports don't answer the question, say so plainly instead " +
      "of guessing.\n\nBug reports:\n\n" +
      context,
  };
}

ragForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const question = ragInput.value.trim();
  if (!question || !engine) return;
  ragInput.value = "";

  const bugs = getActiveBugs();
  conversation.push({ role: "user", content: question, bugsContext: bugs });
  appendBubble("user", question, bugs);

  setStatus("Generating answer locally…");
  try {
    // Rebuild the system message from the *current* active bug list each
    // turn (the user may have changed the subset since the last question),
    // but keep the full prior conversation for context.
    const messages = [
      buildSystemMessage(bugs),
      ...conversation.map((t) => ({ role: t.role, content: t.content })),
    ];
    const reply = await engine.chat.completions.create({ messages });
    const text = reply.choices[0].message.content;
    conversation.push({ role: "assistant", content: text, bugsContext: bugs });
    appendBubble("assistant", text, bugs);
    setStatus("Done.");
  } catch (err) {
    console.error(err);
    setStatus(`Error: ${err.message}`);
  }
});

clearBtn.addEventListener("click", () => {
  conversation = [];
  renderConversation();
  setStatus("Conversation cleared.");
});

copyBtn.addEventListener("click", async () => {
  if (conversation.length === 0) {
    setStatus("Nothing to copy yet.");
    return;
  }
  const lastBugs = conversation[conversation.length - 1].bugsContext ?? [];
  const bugsSection = lastBugs
    .map((b) => `[${b.reference}] ${stripLinks(b.summary)} (Fixed in: ${(b.versions || []).join(", ") || "—"})`)
    .join("\n");
  const chatSection = conversation
    .map((t) => `${t.role === "user" ? "You" : "AI"}: ${t.content}`)
    .join("\n\n");
  const text =
    `Bug subset discussed (${lastBugs.length} bugs):\n${bugsSection}\n\n` +
    `Conversation:\n${chatSection}`;
  try {
    await navigator.clipboard.writeText(text);
    setStatus("Conversation copied to clipboard.");
  } catch (err) {
    console.error(err);
    setStatus(`Failed to copy: ${err.message}`);
  }
});

enableBtn.addEventListener("click", enableLocalAI);
