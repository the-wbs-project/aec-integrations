/**
 * Cloudflare Turnstile siteverify client (AECI-1457).
 *
 * The invisible Turnstile widget runs in the browser on public pages and hands the
 * tracker a single-use token. This module asks Cloudflare whether that token is
 * good and maps the answer onto the three verdicts `page_views.turnstile_verdict`
 * stores. The verdict is classifier EVIDENCE, never an exclusion axis, so nothing
 * here can block or drop a page view.
 *
 * The contract, modelled on `lib/toxicity.ts`:
 *
 *   - **Never throws.** Every failure resolves to a verdict. A timeout, a network
 *     error, a non-2xx or an unreadable payload is `unknown`.
 *   - **No secret → `null`, and no fetch.** Deployed tiers always carry the secret
 *     (CI-pushed, deploy-required); local dev and tests often do not. `null` means
 *     "no check was attempted", which is different
 *     from `unknown` ("a check was attempted and could not answer").
 *   - **Every response body is released.** A 2xx body is read as JSON. Every other
 *     path calls `discardResponseBody`, because an unread body holds one of the
 *     Worker's six connections and a cancelled fetch never settles (ADR 0021,
 *     2026-08-27 amendment).
 *
 * `expectedCData` binds a token to one thing. The landing verdict endpoint passes
 * the page load's Ray ID, which the browser also handed the widget as `cData`. A
 * token minted for one page load then cannot be spent on another row: siteverify
 * echoes `cdata`, and a present-but-different value is `fail`. An absent `cdata`
 * is `unknown`, never `fail`.
 */

import type { TurnstileVerdict } from '@aeci/shared';
import { discardResponseBody } from '@aeci/shared/response-drain';

import type { Env } from '../env';

export const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Same cap as the toxicity call. Runs inside `waitUntil`, so it never delays a response. */
const TIMEOUT_MS = 4000;

/** The slice of the siteverify response we read. All optional: a malformed body is `unknown`. */
type SiteverifyResponse = {
  success?: unknown;
  'error-codes'?: unknown;
  cdata?: unknown;
};

export type VerifyTurnstileOptions = {
  /** The visitor's IP, passed to siteverify as `remoteip`. Optional. */
  remoteIp?: string | null;
  /** When set, a `success:true` answer whose `cdata` is present and differs is `fail`; an absent `cdata` is `unknown`. */
  expectedCData?: string;
};

/**
 * Verify one Turnstile token. Returns `null` when no secret is configured (no fetch
 * made), otherwise `pass`, `fail` or `unknown`. Never throws.
 *
 * Mapping:
 *   - `success:true`, and `cdata` equals `expectedCData` when one is given → `pass`.
 *   - `success:true` with a present `cdata` that differs from `expectedCData` → `fail`.
 *   - `success:true` with no `cdata` when one is expected → `unknown`.
 *   - `success:false` with `invalid-input-response` → `fail`: the token is forged
 *     or malformed.
 *   - `success:false` with any other code (`timeout-or-duplicate`, `internal-error`,
 *     a secret misconfiguration) → `unknown`. Those say nothing about the visitor.
 *   - Non-2xx, network error, timeout, unparseable JSON → `unknown`.
 */
export async function verifyTurnstile(
  env: Pick<Env, 'TURNSTILE_SECRET_KEY'>,
  token: string,
  options: VerifyTurnstileOptions = {},
): Promise<TurnstileVerdict | null> {
  const secret = env.TURNSTILE_SECRET_KEY;
  if (!secret) return null;

  // URL-encoded form, which siteverify accepts alongside multipart and JSON.
  const form = new URLSearchParams({ secret, response: token });
  if (options.remoteIp) form.set('remoteip', options.remoteIp);

  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    // Timeout (AbortError / TimeoutError) or network failure.
    return 'unknown';
  }

  if (!res.ok) {
    discardResponseBody(res);
    return 'unknown';
  }

  let data: SiteverifyResponse;
  try {
    data = (await res.json()) as SiteverifyResponse;
  } catch {
    // `json()` already consumed the body, so there is nothing left to release.
    return 'unknown';
  }
  return mapSiteverify(data, options.expectedCData);
}

/** Pure mapping from a parsed siteverify body to a verdict. Exported for the spec. */
export function mapSiteverify(
  data: SiteverifyResponse | null | undefined,
  expectedCData?: string,
): TurnstileVerdict {
  if (data === null || typeof data !== 'object') return 'unknown';
  if (data.success === true) {
    if (expectedCData === undefined) return 'pass';
    // An ABSENT cdata says nothing about the visitor: Cloudflare's test secrets
    // answer success with no cdata at all. Only a present-and-different cdata is a
    // token minted for another page load. A false `fail` poisons classifier evidence.
    if (data.cdata === undefined || data.cdata === null) return 'unknown';
    return data.cdata === expectedCData ? 'pass' : 'fail';
  }
  if (data.success === false) {
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'] : [];
    return codes.includes('invalid-input-response') ? 'fail' : 'unknown';
  }
  return 'unknown';
}
