/**
 * Strips bearer tokens out of the URLs `posthog-js` attaches to every event.
 *
 * Two pages take a per-recipient secret in the query string: `/unsubscribe?token=`
 * (mailing list, AECI-537) and `/notifications/mute?token=` (digest mute,
 * AECI-1204). The SDK copies the address bar into `$current_url` on every event,
 * and into `$referrer` on the next page. Without this, the token would sit in
 * PostHog where anyone with project read access could replay it.
 *
 * Wired as the `before_send` hook in `createPostHogClient` (`posthog-client.ts`).
 * Pure on purpose, so plain Vitest covers it without the SDK or a browser.
 *
 * Rules:
 * - Only the `token` parameter is removed. Every other parameter keeps its
 *   original spelling and order, and the `#fragment` is kept.
 * - Absolute and relative URLs both work. Nothing is parsed with `new URL`, so
 *   a relative or malformed value is never rewritten into another shape.
 * - Never throws. A value that is not a string is returned untouched.
 */
import type { CaptureResult } from 'posthog-js';

/** The query parameter that carries a bearer token on our own pages. */
const SECRET_PARAM = 'token';

/**
 * Event properties that hold a URL or path. The `$initial_*` keys are the
 * first-touch copies the SDK writes into `$set_once`.
 */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$pathname',
  '$initial_current_url',
  '$initial_referrer',
  '$initial_pathname',
] as const;

function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return rawKey;
  }
}

/**
 * Returns `url` with every `token` query parameter removed. Returns the input
 * unchanged when it has no query or no `token` parameter.
 */
export function stripTokenParam(url: string): string {
  const hashAt = url.indexOf('#');
  const beforeHash = hashAt === -1 ? url : url.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : url.slice(hashAt);

  const queryAt = beforeHash.indexOf('?');
  if (queryAt === -1) return url;

  const base = beforeHash.slice(0, queryAt);
  const pairs = beforeHash.slice(queryAt + 1).split('&');
  const kept = pairs.filter((pair) => {
    const eq = pair.indexOf('=');
    const rawKey = eq === -1 ? pair : pair.slice(0, eq);
    return decodeKey(rawKey) !== SECRET_PARAM;
  });

  if (kept.length === pairs.length) return url;
  const query = kept.join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}

function sanitizeBag(bag: Record<string, unknown> | undefined): void {
  if (!bag) return;
  for (const key of URL_PROPERTIES) {
    const value = bag[key];
    if (typeof value === 'string') bag[key] = stripTokenParam(value);
  }
}

/**
 * The `before_send` hook. Scrubs the URL properties on the event and on its
 * `$set` / `$set_once` person bags. A `null` (an event an earlier hook dropped)
 * passes through.
 */
export function sanitizePostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  sanitizeBag(event.properties);
  sanitizeBag(event.$set);
  sanitizeBag(event.$set_once);
  return event;
}
