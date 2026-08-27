/**
 * Minimal, safe renderer for bug summaries.
 *
 * Summaries only ever use markdown *link* syntax: `[text](url)`, pointing
 * at developer.4d.com command docs. We do not pull in a general markdown
 * library — instead: HTML-escape the raw text first (so no stray HTML/JS
 * from the data can ever execute), then linkify `[text](url)` patterns,
 * restricting the href to an allowlisted domain as defense-in-depth.
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

/** Render a raw summary string (with `[text](url)` links) to safe HTML. */
export function renderSummary(text) {
  const escaped = escapeHtml(text);
  // escapeHtml turns `"` into `&quot;`, so the URL inside () is untouched
  // except for `&` -> `&amp;`, which we undo only within captured URLs.
  return escaped.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (match, linkText, href) => {
      const realHref = href.replace(/&amp;/g, "&");
      if (!realHref.startsWith(ALLOWED_HREF_PREFIX)) {
        // Not an allowlisted link target: render as plain text, no <a>.
        return linkText;
      }
      return `<a href="${escapeHtml(realHref)}" target="_blank" rel="noopener noreferrer">${linkText}</a>`;
    }
  );
}
