/**
 * Return-path validation for the auth flows (AECI-194 / Phase 5 §4.2) — the
 * open-redirect guard. `/auth/login?return=<path>` threads the visitor's
 * pre-login location through the Supabase redirect
 * (`/auth/callback?return=<path>`), and anything we forward there eventually
 * becomes a client-side navigation target after the session exchange
 * (AECI-195). A raw pass-through would let
 * `/auth/login?return=//evil.example` bounce a signed-in user off-site.
 *
 * Pure on purpose (no Angular, no `URL` constructor needing a base) so the
 * acceptance-criterion test table runs under plain Node Vitest.
 */

/**
 * Narrows a raw `?return=` value to a safe same-origin path, defaulting to
 * `/` on anything suspect. Accepts only strings that:
 *
 *   - start with a single `/` (rejects `//host` protocol-relative URLs and
 *     absolute `scheme:` URLs, including `javascript:`),
 *   - contain no `\` anywhere (browsers normalize `/\evil.example` and
 *     `\/evil.example` to `//evil.example`),
 *   - contain no control characters (defense against header/URL smuggling —
 *     some parsers strip `\t`/`\n` before scheme detection).
 *
 * Query strings and fragments within the path are preserved — they are
 * same-origin by construction once the prefix rules hold.
 */
export function safeReturnPath(raw: string | null | undefined): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';
  if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return '/';
  if (raw.includes('\\')) return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';
  return raw;
}
