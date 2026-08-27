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
  const t = text.toLowerCase();
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

  // "v20", "version 20".
  m = t.match(/\bv(?:ersion)?\.?\s*(\d{2})\b/);
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
        return major < intent.major;
      case "after":
        return major > intent.major;
      case "r-release":
        return (major === intent.major && rNum === intent.rNum) || major === intent.major + 1;
      default:
        return true;
    }
  });
}

/** Human-readable description of an intent, for status/context messages. */
export function describeIntent(intent) {
  if (!intent) return null;
  switch (intent.type) {
    case "exact":
      return `version ${intent.major} (and its releases/hotfixes)`;
    case "approx":
      return `around version ${intent.major} (majors ${intent.major - 1}-${intent.major + 1})`;
    case "before":
      return `versions before ${intent.major}`;
    case "after":
      return `versions after ${intent.major}`;
    case "r-release":
      return `${intent.major}_r${intent.rNum} and all of version ${intent.major + 1} (R-releases preview the next major)`;
    default:
      return null;
  }
}
