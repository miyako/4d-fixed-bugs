/**
 * Parses a user's chat message for a 4D version reference and turns it
 * into a filter intent, per these rules (as specified):
 *
 *  - Exact/minor: "v20", "20", "20.1"           -> major 20 (20, 20.*)
 *  - R-release:   "v19 R8", "19r8", "19_r8"     -> exactly 19_r8 (any
 *                  hotfix of it) PLUS all of major 20, since R-releases
 *                  are effectively previews of the next major version.
 *  - Approximate: "around v18", "18 or thereabouts", "about 18"
 *                                                -> majors 17, 18, 19
 *  - Open-ended:  "before 17", "after 20"        -> all majors strictly
 *                  below/above 17/20 that exist in the dataset.
 *
 * Japanese phrasings are recognized too: "v18前後"/"18頃"/"18あたり"
 * (approximate), "17より前"/"17未満" (strictly before), "17以前"/"17以下"
 * (up to and including 17), "20より後"/"20より新しい" (strictly after),
 * "20以降"/"20以上" (20 and later), "バージョン20" (exact). The message is
 * NFKC-normalized first, so full-width digits and letters ("Ｖ２０") work.
 *
 * These patterns cover the phrasings given as examples. Anything else
 * (no recognizable version reference) returns `null`, and the caller
 * falls back to plain semantic search with no version filter.
 */

/** Parse a single version string from the dataset, e.g. "20.1_hf1",
 * "19_r8", "20_r10_hf2", into { major, rNum } (rNum is null for
 * major/minor releases that aren't an R-release). */
export function parseVersionString(v) {
  const rMatch = v.match(/^(\d+)_r(\d+)/);
  if (rMatch) return { major: parseInt(rMatch[1], 10), rNum: parseInt(rMatch[2], 10) };
  const majorMatch = v.match(/^(\d+)/);
  return { major: majorMatch ? parseInt(majorMatch[1], 10) : null, rNum: null };
}

/** Parse a natural-language message for a version-filter intent, given
 * the [min, max] major versions actually present in the dataset (used to
 * avoid treating unrelated numbers in the message as version references). */
export function parseVersionIntent(text, minMajor, maxMajor) {
  const t = text.normalize("NFKC").toLowerCase();
  const inRange = (n) => n >= minMajor && n <= maxMajor;

  // "19 R8", "19r8", "v19_r8" — R-release + implicit next-major preview.
  let m = t.match(/\bv?(\d{2})[\s_]?r\s*(\d+)\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "r-release", major: parseInt(m[1], 10), rNum: parseInt(m[2], 10) };
  }

  // "around v18", "about 18", "approximately 18", "roughly 18".
  m = t.match(/\b(?:around|about|approx(?:imately)?|roughly)\s+v?(\d{2})\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "approx", major: parseInt(m[1], 10) };
  }

  // "18 or thereabouts", "18ish".
  m = t.match(/\bv?(\d{2})\b\s*(?:or\s+thereabouts|ish)\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "approx", major: parseInt(m[1], 10) };
  }

  // Japanese: "v18前後", "18頃", "18あたり", "約18".
  m = t.match(/(?:約|およそ)\s*(?:v|バージョン)?\s*(\d{2})\b/) ||
    t.match(/\bv?(\d{2})\s*(?:前後|付近|あたり|辺り|頃|ごろ|くらい|ぐらい)/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "approx", major: parseInt(m[1], 10) };
  }

  // Japanese: "17より前", "17未満" (strict) / "17以前", "17以下" (inclusive).
  m = t.match(/\bv?(\d{2})\s*(より前|より古い|未満|以前|以下|まで)/);
  if (m && inRange(parseInt(m[1], 10))) {
    const inclusive = /以前|以下|まで/.test(m[2]);
    return { type: "before", major: parseInt(m[1], 10), inclusive };
  }

  // Japanese: "20より後", "20より新しい" (strict) / "20以降", "20以上" (inclusive).
  m = t.match(/\bv?(\d{2})\s*(より後|より新しい|以降|以上|から)/);
  if (m && inRange(parseInt(m[1], 10))) {
    const inclusive = /以降|以上|から/.test(m[2]);
    return { type: "after", major: parseInt(m[1], 10), inclusive };
  }

  // "before 17".
  m = t.match(/\bbefore\s+v?(\d{2})\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "before", major: parseInt(m[1], 10) };
  }

  // "after 20".
  m = t.match(/\bafter\s+v?(\d{2})\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "after", major: parseInt(m[1], 10) };
  }

  // "v20", "version 20", "バージョン20".
  m = t.match(/(?:\bv(?:ersion)?\.?|バージョン)\s*(\d{2})\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "exact", major: parseInt(m[1], 10) };
  }

  // "20.1" (major.minor, distinctive enough without a "v" prefix).
  m = t.match(/\b(\d{2})\.\d+\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "exact", major: parseInt(m[1], 10) };
  }

  // Bare 2-digit number as a last resort (e.g. just "20"). Only accepted
  // within the dataset's known major-version range to limit false
  // positives from unrelated numbers in the message.
  m = t.match(/\b(\d{2})\b/);
  if (m && inRange(parseInt(m[1], 10))) {
    return { type: "exact", major: parseInt(m[1], 10) };
  }

  return null;
}

/** Does a bug (with a `versions` array) satisfy a parsed version intent? */
export function bugMatchesIntent(bug, intent) {
  if (!intent) return true;
  return (bug.versions || []).some((v) => {
    const { major, rNum } = parseVersionString(v);
    if (major === null) return false;
    switch (intent.type) {
      case "exact":
        return major === intent.major;
      case "approx":
        return Math.abs(major - intent.major) <= 1;
      case "before":
        return major < intent.major || (intent.inclusive === true && major === intent.major);
      case "after":
        return major > intent.major || (intent.inclusive === true && major === intent.major);
      case "r-release":
        return (major === intent.major && rNum === intent.rNum) || major === intent.major + 1;
      default:
        return true;
    }
  });
}

/** Human-readable description of an intent, for status/context messages. */
export function describeIntent(intent, lang = "en") {
  if (!intent) return null;
  if (lang === "ja") return describeIntentJa(intent);
  switch (intent.type) {
    case "exact":
      return `version ${intent.major} (and its releases/hotfixes)`;
    case "approx":
      return `around version ${intent.major} (majors ${intent.major - 1}-${intent.major + 1})`;
    case "before":
      return intent.inclusive ? `versions up to and including ${intent.major}` : `versions before ${intent.major}`;
    case "after":
      return intent.inclusive ? `version ${intent.major} and later` : `versions after ${intent.major}`;
    case "r-release":
      return `${intent.major}_r${intent.rNum} and all of version ${intent.major + 1} (R-releases preview the next major)`;
    default:
      return null;
  }
}

function describeIntentJa(intent) {
  const { major } = intent;
  switch (intent.type) {
    case "exact":
      return `v${major}（リリース・ホットフィックスを含む）`;
    case "approx":
      return `v${major} 前後（v${major - 1}〜v${major + 1}）`;
    case "before":
      return intent.inclusive ? `v${major} 以前` : `v${major} より前`;
    case "after":
      return intent.inclusive ? `v${major} 以降` : `v${major} より後`;
    case "r-release":
      return `${major}_r${intent.rNum} および v${major + 1} 全体（R リリースは次のメジャーバージョンの先行版）`;
    default:
      return null;
  }
}
