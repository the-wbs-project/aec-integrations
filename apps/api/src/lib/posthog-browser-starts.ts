/**
 * The digest's browser-start read (AECI-870) — one D1 lookup, then one HogQL
 * request.
 *
 * ─── Why this module exists at all ──────────────────────────────────────────
 *
 * Two surfaces print the figure: the 05:00 analytics digest email
 * (`scheduled.ts`) and `GET /api/admin/overview?recompute=1`. `ADMIN_PANEL_SPEC.md`
 * §6 P1.1 note 1 is the rule that follows — the panel and the email must not be
 * *able* to disagree — so the composition lives here and both callers import it,
 * exactly as both import `collectAnalyticsMetrics`.
 *
 * It is deliberately NOT in `analytics-digest.ts`. That module's header commits
 * the collector to D1 and only D1: the PostHog read "reaches the NETWORK, which
 * the D1-only collector has never done and should not start doing". And it is
 * not in `posthog-query.ts`, which is a pure transport that authenticates with
 * what the caller hands it and holds no database. This is the seam between them
 * and nothing else.
 *
 * ─── Never throws ───────────────────────────────────────────────────────────
 *
 * Both halves fail open. A D1 error on the admin lookup is caught and reported
 * as a skip rather than silently degrading to "no operators to exclude", because
 * an unfiltered number labelled "operator excluded" is worse than no number: on
 * the Sep 7–10 production sample the operator was 41 of 109 starts.
 */

import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles } from '../db/schema';
import type { Env } from '../env';

import {
  fetchPosthogBrowserStarts,
  publicHostOf,
  type PosthogBrowserStartsOutcome,
} from './posthog-query';

/** The half-open UTC window to count over. Structurally the subset of
 *  `DigestWindow` this read needs, so a caller can pass either. */
export interface BrowserStartsWindow {
  startIso: string;
  endIso: string;
}

/**
 * Supabase user ids of every admin, for the PostHog `$identify` retro-join.
 *
 * `profiles.id` IS the Supabase user id (`AUTH_AND_RLS.md`), and the browser
 * calls `identify(user.id)` with that same value (`ANALYTICS.md` §8), so the two
 * join without a mapping table. Report-only: no `audit_log` row, no mutation.
 *
 * Returns `null` — not `[]` — when the read fails. The difference is the whole
 * point: `[]` means "this deployment has no admins", which is a legitimate state
 * that correctly produces an unfiltered count, while `null` means "we could not
 * find out", which must suppress the figure instead of publishing it unfiltered.
 */
export async function readAdminUserIds(db: Db): Promise<string[] | null> {
  try {
    const rows = await db
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.role, 'admin'));
    return rows.map((r) => r.id);
  } catch (error) {
    console.warn('[posthog-browser-starts] admin lookup failed', error);
    return null;
  }
}

/**
 * Read `app_started` for this environment's own host and the given window.
 *
 * Host-scoped to `PUBLIC_SITE_URL` for the same reason the `$pageview` read is
 * (`scheduled.ts` `readPosthogFloor`): preview, staging and demo share one
 * PostHog project, so an unscoped read folds three tiers into one figure.
 */
export async function readPosthogBrowserStarts(
  env: Env,
  db: Db,
  window: BrowserStartsWindow,
  fetchImpl: typeof fetch = fetch,
): Promise<PosthogBrowserStartsOutcome> {
  const host = publicHostOf(env.PUBLIC_SITE_URL);
  if (!host) return { ok: false, reason: 'public_site_url_unset' };

  const adminIds = await readAdminUserIds(db);
  if (adminIds === null) return { ok: false, reason: 'admin_lookup_failed' };

  return fetchPosthogBrowserStarts(
    {
      apiKey: env.POSTHOG_QUERY_API_KEY,
      projectId: env.POSTHOG_PROJECT_ID,
      host: env.POSTHOG_API_HOST,
    },
    { startIso: window.startIso, endIso: window.endIso, host },
    adminIds,
    fetchImpl,
  );
}
