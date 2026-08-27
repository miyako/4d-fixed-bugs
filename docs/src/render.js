/**
 * Minimal, safe renderer for bug summaries.
 *
 * Summaries use a small, fixed subset of markdown (confirmed by scanning
 * the dataset): links `[text](url)` pointing at developer.4d.com command
 * docs, inline code spans `` `code` ``, and italics `*text*`. No bold or
 * fenced code blocks appear anywhere in the data, so those aren't handled.
 * We do not pull in a general markdown library — instead: HTML-escape the
 * raw text first (so no stray HTML/JS from the data can ever execute),
 * then convert just these three inline patterns, restricting link hrefs
 * to an allowlisted domain as defense-in-depth.
 */

const ALLOWED_HREF_PREFIX = "https://developer.4d.com/";

function escapeHtml(str) {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Matches, in priority order: a markdown link, an inline code span, or an
// italic span. Applied as a single alternation pass so the three inline
// constructs don't interfere with each other's delimiters.
const INLINE_PATTERN = /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*([^*\n]+)\*/g;

/** Render a raw summary string (markdown links/code/italics) to safe HTML. */
export function renderSummary(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(
    INLINE_PATTERN,
    (match, linkText, href, code, italic) => {
      if (linkText !== undefined) {
        // escapeHtml turns `"` into `&quot;`, so the URL inside () is
        // untouched except for `&` -> `&amp;`, which we undo here.
        const realHref = href.replace(/&amp;/g, "&");
        if (!realHref.startsWith(ALLOWED_HREF_PREFIX)) {
          // Not an allowlisted link target: render as plain text, no <a>.
          return linkText;
        }
        return `<a href="${escapeHtml(realHref)}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
      }
      if (code !== undefined) {
        return `<code>${code}</code>`;
      }
      if (italic !== undefined) {
        return `<em>${italic}</em>`;
      }
      return match;
    }
  );
}

const BUGS_LIST_URL = "https://bugs.4d.com/fixedbugslist?version=";

/** Render a bug's `versions` array as a comma-separated list of links to
 * the matching bugs.4d.com fixed-bugs list (`?version=<version>`). */
export function renderVersions(versions) {
  if (!versions || versions.length === 0) return "—";
  return versions
    .map((v) => {
      const safe = escapeHtml(v);
      const href = BUGS_LIST_URL + encodeURIComponent(v);
      return `<a href="${href}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
    })
    .join(", ");
}
