/**
 * Where a vendor request lives, expressed as strings an operator can act on
 * (AECI-860 / `STAGE_1_PHASE_6_SPEC.md` §6.4).
 *
 * Three consumers need the same two answers — which deployment produced this
 * request, and what URL opens it in the admin console — and they had none:
 * `lib/linear.ts` builds the issue description, `lib/email.ts` builds the operator
 * alert, and `lib/claim-stale-check.ts` builds the founder warning. Deriving the
 * pair in three places is how the demo link and the production link drift apart.
 *
 * **The environment comes from `PUBLIC_SITE_URL`, never from `source_url`.**
 * `source_url` is whatever page the form was submitted from: client-supplied,
 * optional, and spoofable. `PUBLIC_SITE_URL` is a committed per-env var in
 * `apps/api/wrangler.jsonc` (`https://demo.aecintegrations.com`,
 * `https://www.aecintegrations.com`, …), so it is the Worker describing itself.
 * That distinction is the whole point of the field: a demo ticket has to be
 * recognisable as a demo ticket, which is why `LINEAR_API_KEY` is production-only
 * under AECI-851 and why rehearsing the claim flow on demo was blocked.
 *
 * Every function returns `null` when `PUBLIC_SITE_URL` is unset (local
 * `dev:bound`, PR previews). Callers omit the row rather than rendering a broken
 * link — the same posture as `email.ts`'s existing `siteUrl` helper.
 */

import type { RequestKind } from '@aeci/shared';

import type { Env } from '../env';

/**
 * Which request kinds raise an operator email on intake (AECI-861).
 *
 * Claims only, today and deliberately: a claim asserts control of a listing and
 * starts the verification path, a correction is a low-stakes data fix that nobody
 * needs woken for. It is a set rather than an inline `kind === 'claim'` because the
 * scope is expected to move — admitting corrections is adding `'correction'` here,
 * and nothing else. Both send sites read it (the submit handler in
 * `routes/requests.ts` and the §6.7 sweep's recovery send), so widening cannot
 * leave one of them behind, which is the failure a duplicated literal invites.
 *
 * It lives here rather than beside either send site because a lib may not import a
 * route, and `adminRequestUrl` below already handles a non-claim kind — so the
 * email body survives the widening without a second edit.
 */
export const NOTIFIED_REQUEST_KINDS: ReadonlySet<RequestKind> = new Set<RequestKind>(['claim']);

/** Trimmed `PUBLIC_SITE_URL` with any trailing slash removed, or `null`. */
export function siteBaseUrl(env: Env): string | null {
  const url = env.PUBLIC_SITE_URL?.trim();
  return url ? url.replace(/\/$/, '') : null;
}

/**
 * The deployment's own hostname — `demo.aecintegrations.com`,
 * `www.aecintegrations.com`, `staging.aecintegrations.com`.
 *
 * Parsed rather than string-sliced so a `PUBLIC_SITE_URL` carrying a port or a
 * path still yields a bare host. A value that will not parse yields `null`
 * instead of throwing: this feeds a description row, and a malformed var must not
 * take down issue creation.
 */
export function environmentHost(env: Env): string | null {
  const base = siteBaseUrl(env);
  if (!base) return null;
  try {
    return new URL(base).host;
  } catch {
    return null;
  }
}

/**
 * The admin console URL that opens this request.
 *
 * Claims get the AECI-739 detail page, which is keyed on `vendor_requests.id`
 * (`routes/admin-claims.ts`), so the request id is the path segment. Corrections
 * have no detail route — only the `/admin/requests` queue — so they get that.
 * Linking a correction to a `/admin/claims/:id` that 404s would be worse than
 * linking the queue.
 */
export function adminRequestUrl(env: Env, kind: RequestKind, requestId: string): string | null {
  const base = siteBaseUrl(env);
  if (!base) return null;
  return kind === 'claim' ? `${base}/admin/claims/${requestId}` : `${base}/admin/requests`;
}
