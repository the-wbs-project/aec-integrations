/**
 * Makes a whole table row clickable by forwarding a click on the row to the
 * row's one real link.
 *
 * **Why not a stretched link.** The usual pattern is an `absolute inset-0`
 * overlay link against a `relative` row. It does not work on a `<tr>`: Safari
 * before 27 computes `position: relative` on a table row as `static`, so every
 * row's overlay anchors to the page instead and they stack over the whole
 * viewport (clicking near the page title opened a random integration). No other
 * containing-block trick (`transform`, `contain`, `will-change`, `filter`) fixed
 * it in Safari 26.6, so the row no longer depends on the `<tr>` as an anchor.
 *
 * **What stays the same for keyboard and screen-reader users.** The row link is
 * a real, focusable `<a>` with its own accessible name, rendered in the row's
 * trailing cell. This handler only adds the pointer convenience on top.
 *
 * A click is left alone when it lands on another interactive element in the row
 * (that element's own action wins), when it is not a primary-button click, or
 * when the user has just selected text in the row. A Cmd/Ctrl/Shift click opens
 * the link in a new tab, as it would on the link itself.
 */
export function forwardRowClick(event: MouseEvent, link: HTMLAnchorElement | undefined): void {
  if (!link || event.defaultPrevented || event.button !== 0) return;

  const target = event.target;
  if (
    target instanceof Element &&
    target.closest('a, button, input, select, textarea, label, summary, [role="button"]')
  ) {
    return;
  }

  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (selection && !selection.isCollapsed && selection.toString().trim() !== '') return;

  if (event.metaKey || event.ctrlKey || event.shiftKey) {
    window.open(link.href, '_blank', 'noopener');
    return;
  }
  link.click();
}
