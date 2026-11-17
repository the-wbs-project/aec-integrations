/**
 * Strips bearer tokens out of the URLs `posthog-js` attaches to every event.
 *
 * Three pages take a per-recipient secret in the query string: `/unsubscribe?token=`
 * (mailing list, AECI-537), `/notifications/mute?token=` (digest mute, AECI-1204)
 * and `/claims/confirm?token=` (the single-use claim confirm link, AECI-1435). The SDK copies the address bar into `$current_url` on every event,
 * into `$referrer` on the next page, and into `$session_entry_url` on every
 * later event of the session. Without this, the token would sit in
 * PostHog where anyone with project read access could replay it.
 *
 * A second layer for form answers (AECI-1919). A form submitted natively before
 * hydration GETs the page with every Signal Forms field in the query string, as
 * `ng.form9.submitter_email=…`. The leaking form now declares `method="dialog"`
 * so that cannot happen, and this hook drops any `ng.form*` parameter that still
 * arrives, from an old cached page or another form.
 *
 * Wired as the `before_send` hook in `createPostHogClient` (`posthog-client.ts`).
 * Pure on purpose, so plain Vitest covers it without the SDK or a browser.
 *
 * Rules:
 * - Only the `token` parameter and `ng.form*` parameters are removed. Every other
 *   parameter keeps its original spelling and order, and the `#fragment` is kept.
 * - Absolute and relative URLs both work. Nothing is parsed with `new URL`, so
 *   a relative or malformed value is never rewritten into another shape.
 * - Never throws. A value that is not a string is returned untouched.
 */
import type { CaptureResult } from 'posthog-js';

/** The query parameter that carries a bearer token on our own pages. */
const SECRET_PARAM = 'token';

/** The name prefix Signal Forms gives every field (`ng.form9.email`), AECI-1919. */
const FORM_FIELD_PREFIX = 'ng.form';

function isSecretKey(key: string): boolean {
  return key === SECRET_PARAM || key.startsWith(FORM_FIELD_PREFIX);
}

/**
 * Event properties that hold a URL or path. The `$initial_*` keys are the
 * first-touch copies the SDK writes into `$set_once`. The `$session_entry_*` keys
 * are the session's first URL, which posthog-js (`getSessionProps`) copies onto
 * every event in the session.
 */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$pathname',
  '$initial_current_url',
  '$initial_referrer',
  '$initial_pathname',
  '$session_entry_url',
  '$session_entry_referrer',
  '$session_entry_pathname',
] as const;

function decodeKey(rawKey: string): string {
  try {
    return decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return rawKey;
  }
}

/**
 * Returns `url` with every `token` and `ng.form*` query parameter removed.
 * Returns the input unchanged when it has no query or no such parameter.
 */
export function stripSecretParams(url: string): string {
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
    return !isSecretKey(decodeKey(rawKey));
  });

  if (kept.length === pairs.length) return url;
  const query = kept.join('&');
  return `${base}${query ? `?${query}` : ''}${hash}`;
}

function sanitizeBag(bag: Record<string, unknown> | undefined): void {
  if (!bag) return;
  for (const key of URL_PROPERTIES) {
    const value = bag[key];
    if (typeof value === 'string') bag[key] = stripSecretParams(value);
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
