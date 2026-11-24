// Footer credits ("data sources & credits") are folded behind a <details>
// toggle on phones so the always-visible footer bar stays compact, and read
// as plain text on wider screens. The markup ships with `open` so the
// credits are readable without JS; this module only collapses them on
// narrow viewports and re-syncs if the viewport crosses the breakpoint.
const NARROW = "(max-width: 640px)";

/**
 * Collapse the footer credits on narrow viewports, expand them otherwise.
 * A manual toggle on the same side of the breakpoint is left alone: the
 * listener only reacts to viewport changes.
 */
export function initFooterCredits(details, media = null) {
  if (!details || typeof window.matchMedia !== "function") return;
  const query = media || window.matchMedia(NARROW);
  const sync = () => {
    details.open = !query.matches;
  };
  sync();
  query.addEventListener?.("change", sync);
}
