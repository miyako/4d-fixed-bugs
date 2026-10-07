/**
 * Per-language configuration and UI strings.
 *
 * The same app.js serves both docs/index.html (English) and
 * docs/ja/index.html (Japanese); the page's <html lang> picks the locale.
 * A locale decides which dataset is loaded (each has its own summaries and
 * its own embeddings), which embedding model encodes the query, and every
 * user-visible string app.js produces.
 *
 * The embedding settings here must stay identical to the ones used to build
 * the corpus in scripts/update/generate_embeddings.mjs, or query and corpus
 * vectors stop being comparable.
 */

const EN = {
  lang: "en",
  dataDir: "../data/",
  embedding: {
    library: "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js",
    model: "Xenova/all-MiniLM-L6-v2",
    options: { quantized: true },
    dim: 384,
    queryPrefix: "",
  },
  // Cosine-similarity floor below which a match is dropped, and the bands
  // used to color the "Match" badge. Calibrated per model: scores from
  // different models are not on the same scale.
  scores: { min: 0.35, high: 0.55, medium: 0.45 },
  t: {
    loadingData: "Loading bug database…",
    loadingModel: "Loading semantic search model…",
    loadingChat: "Downloading local AI model… this can take a while the first time.",
    loadingChatShort: "Loading local AI model…",
    ready: (n, min, max) => `Ready. ${n} fixed 4D bugs loaded (versions ${min}-${max}). Describe a bug to search.`,
    failed: (msg) => `Failed to start: ${msg}`,
    searching: "Searching the bug database…",
    thinking: "Thinking…",
    error: (msg) => `Error: ${msg}`,
    showReasoning: "Show reasoning",
    exact: "Exact",
    headers: ["ACI", "Match", "Versions", "Summary"],
    foundDirect: (refs) => `Found ${refs.join(", ")} directly — see the details below.`,
    notFoundWithResults: (refs) =>
      `${refs.join(", ")} doesn't exist in the database. Here are the closest matches by search instead:`,
    notFoundNoResults: (refs) => `${refs.join(", ")} doesn't exist in the database, and no similar bugs were found either.`,
    noRelevant: "No bugs closely matched that search — try rephrasing, or describing the bug in more detail.",
    noResults: "No bugs matched that search.",
    mentioning: (cmds) => `mentioning ${cmds.join(", ")}`,
    fixedIn: (desc) => `fixed in ${desc}`,
    noExactMatchFor: (what) => `no exact match for ${what}`,
    found: (n, criteria) => `Found ${n} bug${n === 1 ? "" : "s"}${criteria.length ? " " + criteria.join(" and ") : ""}.`,
    fallback: (notes) =>
      ` No exact match for that${notes.length > 1 ? " (" + notes.join("; ") + ")" : ""} — showing the closest overall matches instead.`,
    nothingToCopy: "No results to copy yet.",
    copied: "Results table copied to clipboard.",
    copyFailed: (msg) => `Failed to copy: ${msg}`,
    copyRejected: "Copy command was rejected by the browser.",
    replyLanguage: "",
  },
};

const JA = {
  lang: "ja",
  dataDir: "../data/ja/",
  embedding: {
    library: "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js",
    // Japanese-specific (cl-nagoya/ruri-v3-30m), ONNX export pinned to a
    // commit so a re-upload can't silently change the vectors.
    model: "sirasagi62/ruri-v3-30m-ONNX",
    options: { dtype: "q8", revision: "cdf9391f1ff2198daa8f63f7ccf97d7b3e7415a0" },
    dim: 256,
    queryPrefix: "検索クエリ: ",
  },
  // ruri scores sit high: off-topic queries and greetings top out around
  // 0.80-0.81, one-word queries (印刷) around 0.84, and correct hits in
  // tests/eval/ja_queries.json score 0.87-0.96 (median 0.93).
  scores: { min: 0.82, high: 0.9, medium: 0.86 },
  t: {
    loadingData: "バグデータベースを読み込んでいます…",
    loadingModel: "検索モデルを読み込んでいます…",
    loadingChat: "ローカル AI モデルをダウンロードしています… 初回は時間がかかります。",
    loadingChatShort: "ローカル AI モデルを読み込んでいます…",
    ready: (n, min, max) =>
      `準備ができました。修正済みの 4D バグ ${n} 件（v${min}〜v${max}）を読み込みました。調べたいバグの内容を入力してください。`,
    failed: (msg) => `起動に失敗しました: ${msg}`,
    searching: "バグデータベースを検索しています…",
    thinking: "考えています…",
    error: (msg) => `エラー: ${msg}`,
    showReasoning: "推論を表示",
    exact: "完全一致",
    headers: ["ACI", "一致度", "バージョン", "概要"],
    foundDirect: (refs) => `${refs.join("、")} が見つかりました。詳細は下の表をご覧ください。`,
    notFoundWithResults: (refs) =>
      `${refs.join("、")} はデータベースに存在しません。代わりに検索で近いものを表示します。`,
    notFoundNoResults: (refs) => `${refs.join("、")} はデータベースに存在せず、似たバグも見つかりませんでした。`,
    noRelevant: "検索内容に近いバグは見つかりませんでした。言い換えるか、バグの内容をもう少し詳しく入力してください。",
    noResults: "検索に一致するバグはありませんでした。",
    mentioning: (cmds) => `${cmds.join("、")} に関する`,
    fixedIn: (desc) => `${desc}で修正された`,
    noExactMatchFor: (what) => `${what} に完全に一致するものなし`,
    found: (n, criteria) => `${criteria.join("、")}バグが ${n} 件見つかりました。`,
    fallback: (notes) =>
      `完全に一致するものがなかったため${notes.length > 1 ? "（" + notes.join("、") + "）" : ""}、全体で近いものを表示します。`,
    nothingToCopy: "コピーできる結果がまだありません。",
    copied: "結果の表をクリップボードにコピーしました。",
    copyFailed: (msg) => `コピーに失敗しました: ${msg}`,
    copyRejected: "ブラウザーがコピーを拒否しました。",
    replyLanguage: "Write your reply in Japanese (polite form).\n\n",
  },
};

export const LOCALES = { en: EN, ja: JA };

export function getLocale(lang) {
  return LOCALES[(lang || "en").slice(0, 2)] || EN;
}
