import { isReplayedEvent } from '../core/event-replay';

/**
 * The path to route in the app for a click on a plain menu link, or `null` when
 * the click belongs to the browser (AECI-1774, AECI-1775).
 *
 * The Browse panel and the mobile menu render their destinations as plain
 * `<a href>` with no listener, so a link works before its lazy block hydrates.
 * Each menu's eager host listens for clicks and calls this. A non-null result
 * means: prevent the default, close the menu, and navigate in the app.
 *
 * It returns `null`, and leaves the click alone, when:
 * - the event is a replay (the native default already ran, a full page load);
 * - something already prevented the default (a `RouterLink` did its own routing);
 * - the target is not inside a link matched by `selector`;
 * - the href is not a same-origin path (`/x`, never `//host` or `https:`);
 * - the link has `target` or `download`;
 * - the click is not a plain primary click (another button, or any modifier key,
 *   which means a new tab or window).
 */
export function inAppLinkPath(event: MouseEvent, selector: string): string | null {
  if (isReplayedEvent(event) || event.defaultPrevented) return null;
  const link = (event.target as Element | null)?.closest?.(selector);
  const href = link?.getAttribute('href');
  if (!link || !href?.startsWith('/') || href.startsWith('//')) return null;
  if (link.hasAttribute('target') || link.hasAttribute('download')) return null;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
    return null;
  }
  return href;
}
