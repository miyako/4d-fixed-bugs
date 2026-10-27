/**
 * Per-language configuration and UI strings.
 *
 * The same app.js serves the English, Japanese and French pages;
 * the page's <html lang> picks the locale.
 * A locale decides which dataset is loaded (each has its own summaries and
 * its own embeddings), relevance thresholds, and every
 * user-visible string app.js produces.
 *
 * All three languages share the pinned encoder in search-config.js.
 */

const EN = {
  lang: "en",
  dataDir: "../data/",
  // Cosine-similarity floor below which a match is dropped, and the bands
  // used to color the "Match" badge. Calibrated per model: scores from
  // different models are not on the same scale.
  // Calibrated against 43 bug queries and 12 unrelated queries per language;
  // see tests/eval/embeddinggemma-comparison.json.
  scores: { min: 0.705, high: 0.841, medium: 0.799 },
  t: {
    loadingData: "Loading bug database…",
    loadingModel: "Loading semantic search model…",
    semanticLoading: "Loading semantic search. Keyword search is available while the model downloads.",
    semanticProgress: (file, n) => `Loading ${file}: ${n}%. Keyword search is available.`,
    semanticReady: "Semantic search ready — EmbeddingGemma 2 (WebGPU).",
    semanticUnavailable: "WebGPU is unavailable. Keyword search is active; ACI, command, and version filters still work.",
    semanticError: (msg) => `Semantic search failed: ${msg}. Keyword search remains available.`,
    semanticRetry: "Retry semantic search",
    keywordMatch: "Keyword",
    filterMatch: "Filter",
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
  scores: { min: 0.715, high: 0.845, medium: 0.798 },
  t: {
    loadingData: "バグデータベースを読み込んでいます…",
    loadingModel: "検索モデルを読み込んでいます…",
    semanticLoading: "意味検索モデルを読み込んでいます。ダウンロード中もキーワード検索を利用できます。",
    semanticProgress: (file, n) => `${file} を読み込み中: ${n}%。キーワード検索を利用できます。`,
    semanticReady: "意味検索の準備ができました — EmbeddingGemma 2（WebGPU）。",
    semanticUnavailable: "WebGPU を利用できないため、キーワード検索を使用しています。ACI・コマンド名・バージョンでの絞り込みも利用できます。",
    semanticError: (msg) => `意味検索を開始できませんでした: ${msg}。キーワード検索は引き続き利用できます。`,
    semanticRetry: "意味検索を再試行",
    keywordMatch: "キーワード",
    filterMatch: "条件一致",
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

const FR = {
  lang: "fr",
  dataDir: "../data/fr/",
  scores: { min: 0.702, high: 0.841, medium: 0.800 },
  t: {
    loadingData: "Chargement de la base de bugs…",
    loadingModel: "Chargement du modèle de recherche sémantique…",
    semanticLoading: "Chargement de la recherche sémantique. La recherche par mots-clés reste disponible pendant le téléchargement.",
    semanticProgress: (file, n) => `Chargement de ${file} : ${n} %. La recherche par mots-clés reste disponible.`,
    semanticReady: "Recherche sémantique prête — EmbeddingGemma 2 (WebGPU).",
    semanticUnavailable: "WebGPU est indisponible. La recherche par mots-clés est active ; les filtres ACI, commande et version restent disponibles.",
    semanticError: (msg) => `Échec de la recherche sémantique : ${msg}. La recherche par mots-clés reste disponible.`,
    semanticRetry: "Réessayer la recherche sémantique",
    keywordMatch: "Mot-clé",
    filterMatch: "Filtre",
    loadingChat: "Téléchargement du modèle d’IA local… cela peut prendre du temps la première fois.",
    loadingChatShort: "Chargement du modèle d’IA local…",
    ready: (n, min, max) => `Prêt. ${n} bugs 4D corrigés chargés (versions ${min}-${max}). Décrivez un bug pour lancer la recherche.`,
    failed: (msg) => `Échec du démarrage : ${msg}`,
    searching: "Recherche dans la base de bugs…",
    thinking: "Réflexion en cours…",
    error: (msg) => `Erreur : ${msg}`,
    showReasoning: "Afficher le raisonnement",
    exact: "Exact",
    headers: ["ACI", "Pertinence", "Versions", "Résumé"],
    foundDirect: (refs) => `${refs.join(", ")} trouvé${refs.length > 1 ? "s" : ""} directement — consultez les détails ci-dessous.`,
    notFoundWithResults: (refs) =>
      `${refs.join(", ")} : aucune référence correspondante dans la base. Voici les résultats les plus proches :`,
    notFoundNoResults: (refs) =>
      `${refs.join(", ")} : aucune référence correspondante dans la base et aucun bug similaire trouvé.`,
    noRelevant: "Aucun bug ne correspond suffisamment à cette recherche — reformulez votre demande ou décrivez le bug plus en détail.",
    noResults: "Aucun bug ne correspond à cette recherche.",
    mentioning: (cmds) => `mentionnant ${cmds.join(", ")}`,
    fixedIn: (desc) => `corrigé(s) dans ${desc}`,
    noExactMatchFor: (what) => `aucune correspondance exacte pour ${what}`,
    found: (n, criteria) =>
      `${n} bug${n === 1 ? "" : "s"} trouvé${n === 1 ? "" : "s"}${criteria.length ? " " + criteria.join(" et ") : ""}.`,
    fallback: (notes) =>
      ` Aucune correspondance exacte${notes.length > 1 ? " (" + notes.join(" ; ") + ")" : ""} — les résultats globalement les plus proches sont affichés.`,
    nothingToCopy: "Aucun résultat à copier pour le moment.",
    copied: "Tableau des résultats copié dans le presse-papiers.",
    copyFailed: (msg) => `Échec de la copie : ${msg}`,
    copyRejected: "La copie a été refusée par le navigateur.",
    replyLanguage: "Write your reply in French.\n\n",
  },
};

export const LOCALES = { en: EN, ja: JA, fr: FR };

export function getLocale(lang) {
  return LOCALES[(lang || "en").slice(0, 2)] || EN;
}
