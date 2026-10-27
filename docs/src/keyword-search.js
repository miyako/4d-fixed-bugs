const STOP = new Set((
  "a an and are as at be by can could do does for from how i in into is it its my of on or that the this to was were when which with " +
  "au aux avec ce ces dans de des du en et il la le les leur ne nos notre ou par pas pour que qui se ses son sur un une " +
  "の は が を に と で も へ な です ます する した して いる ある なる でき ない"
).split(/\s+/));
const FILTER_TERMS = new Set((
  "before after around about approximately roughly version versions fix fixed bug bugs later " +
  "avant apres autour environ depuis jusqu version corrige corriges bug bugs " +
  "前 後 前後 頃 以前 以下 以降 以上 より バージョン 修正 バグ"
).split(/\s+/));

function tokens(text, lang) {
  const plain = text.normalize("NFKC").toLowerCase().replace(/['’]/g, " ");
  const words = new Intl.Segmenter(lang, { granularity: "word" }).segment(plain);
  return [...words].filter((part) => part.isWordLike).flatMap(({ segment }) => {
    const token = segment.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
    const stem = lang === "en" && token.length > 4 ? token.replace(/(?:ing|ed|es|s)$/, "") : token;
    return stem === token ? [token] : [token, stem];
  }).filter((token) => !STOP.has(token) && (token.length > 1 || /[\u3040-\u9fff]/u.test(token)));
}

export function createKeywordSearch(records, lang) {
  const documents = records.map((record) => new Set(tokens(
    `${record.reference} ${record.summary.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")} ${(record.commands || []).join(" ")}`,
    lang
  )));
  const frequency = new Map();
  for (const document of documents) {
    for (const token of document) frequency.set(token, (frequency.get(token) || 0) + 1);
  }
  const queryTerms = (query, commands = []) => {
    let remaining = query.normalize("NFKC");
    for (const command of commands) remaining = remaining.split(command).join(" ");
    return [...new Set(tokens(remaining, lang))];
  };
  const isVersionTerm = (term) => FILTER_TERMS.has(term) || /^(?:v(?:ersion)?[._]?)?\d{2}(?:[._r]\w*)?$/u.test(term);
  const isFilterOnly = (query, commands = []) => {
    const terms = queryTerms(query, commands);
    return (terms.length > 0 || commands.length > 0) && terms.every(isVersionTerm);
  };
  return {
    isFilterOnly,
    rank(query, pool, { filtered = false, commands = [], versionFilter = filtered } = {}) {
      const terms = queryTerms(query, commands).filter((term) => !versionFilter || !isVersionTerm(term));
      const weight = (term) => Math.log(1 + records.length / (1 + (frequency.get(term) || 0)));
      const total = terms.reduce((sum, term) => sum + weight(term), 0);
      const scored = pool.map((index) => ({
        index,
        score: total ? terms.reduce((sum, term) =>
          sum + (documents[index].has(term) ? weight(term) : 0), 0
        ) / total : 0,
      })).sort((a, b) => b.score - a.score || a.index - b.index);
      const matches = scored.filter((hit) => hit.score > 0);
      return matches.length || !filtered || !isFilterOnly(query, commands) ? matches : scored;
    },
  };
}
