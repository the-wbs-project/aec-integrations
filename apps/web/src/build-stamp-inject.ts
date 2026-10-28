/**
 * Build stamp for stale-tab detection (AECI-1493).
 *
 * Every deploy replaces the hashed JS chunks in `dist/browser`, and Workers
 * static assets keep only the current set. A tab opened before a deploy still
 * asks for the old chunk names, gets a 404, and every lazy route or `@defer`
 * block fails. The browser can only notice this if it knows which build it is
 * running, so the SSR Worker stamps each HTML page with
 * `<meta name="aeci-build" content="{COMMIT_SHA}">`. `AppUpdateService` compares
 * it with `GET /_version`, which reports the build now deployed.
 *
 * **Cache-safe.** The stamp is deploy state, not visitor state: every visitor
 * gets the same value. Each Worker version is its own native-cache namespace
 * (`docs/CACHE_STRATEGY.md` "Deploy behavior"), so a cached page always carries
 * the SHA of the build whose chunks it names.
 *
 * Skipped (returns the input unchanged) when:
 *   - `COMMIT_SHA` is absent, so the browser check stays off (vitest, a bare
 *     `wrangler dev`). `/_version` would report `unknown` there anyway.
 *   - The response is not a 2xx `text/html` with a `</head>`, the same rules as
 *     the other bootstrap injections.
 */

import type { WebEnv } from './env';

const HEAD_CLOSE = '</head>';

/** The `<meta name>` the browser reads. Mirrored in `app/core/app-update`. */
export const BUILD_STAMP_META_NAME = 'aeci-build';

/** Escapes a value for a double-quoted HTML attribute. */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Builds the `<meta>` tag, or `null` when `COMMIT_SHA` is absent. */
export function buildBuildStampMeta(env: WebEnv): string | null {
  const sha = env.COMMIT_SHA;
  if (!sha || sha === 'unknown') return null;
  return `<meta name="${BUILD_STAMP_META_NAME}" content="${escapeAttr(sha)}">`;
}

export async function injectBuildStamp(response: Response, env: WebEnv): Promise<Response> {
  const meta = buildBuildStampMeta(env);
  if (!meta) return response;
  if (response.status < 200 || response.status >= 300) return response;

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) return response;

  const html = await response.clone().text();
  const idx = html.indexOf(HEAD_CLOSE);
  if (idx === -1) return response;

  const next = html.slice(0, idx) + meta + html.slice(idx);
  const headers = new Headers(response.headers);
  // The body length changed — drop any cached content-length so the runtime
  // recomputes it instead of truncating/padding to the original size.
  headers.delete('content-length');
  return new Response(next, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
