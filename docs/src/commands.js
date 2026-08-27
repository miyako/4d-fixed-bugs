/**
 * Classic (exact-phrase) command-name matching, as a complement to
 * semantic search. A query that literally names a 4D command (e.g.
 * "GOTO OBJECT" or "Print form") should reliably surface bugs whose
 * `commands` array contains that exact name, even if the surrounding
 * wording of the query doesn't otherwise resemble any bug summary
 * closely enough for embedding similarity alone to rank it highly.
 */

/** Build a longest-name-first list of every distinct command name that
 * appears in the dataset's `commands` arrays (already sourced from the
 * 4D command docs, so casing matches developer.4d.com exactly). Names
 * shorter than 3 characters are dropped: a few single/double-letter
 * entries exist as scraping artifacts and would match almost anything. */
export function buildCommandIndex(meta) {
  const set = new Set();
  for (const bug of meta) {
    for (const c of bug.commands || []) {
      if (c.length >= 3) set.add(c);
    }
  }
  // Longest first, so a multi-word name (e.g. "GOTO OBJECT") is matched
  // before a shorter overlapping name (e.g. "OBJECT") could steal part
  // of the same span.
  return [...set].sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Find which known command names (if any) are literally mentioned in
 * a user's query. Matching is intentionally case-SENSITIVE (exact
 * casing as stored, e.g. "GOTO OBJECT", "Print form"): many command
 * names double as ordinary English words when lowercased (e.g. "Date",
 * "Choose", "QUERY"), so case-insensitive matching would trigger a hard
 * classic-search filter on completely unrelated casual queries. Typing
 * a command's exact documented name/casing is a deliberate, recognizable
 * signal, much like citing an ACI reference ID. Matched spans are
 * blanked out of the working copy of the query before continuing, so a
 * shorter name can't double-match inside a longer one already found. */
export function extractCommandMentions(query, commandIndex) {
  const found = [];
  let remaining = query;
  for (const cmd of commandIndex) {
    const re = new RegExp(`\\b${escapeRegExp(cmd)}\\b`);
    const m = remaining.match(re);
    if (m) {
      found.push(cmd);
      remaining =
        remaining.slice(0, m.index) +
        " ".repeat(m[0].length) +
        remaining.slice(m.index + m[0].length);
    }
  }
  return found;
}
