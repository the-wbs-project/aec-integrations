/**
 * `GET /api/admin/audience` (AECI-586 / Phase 8.3 P5.1) — the §5.4 Audience
 * bundle: lifetime subscriber stocks, the day-bucketed growth/churn series, the
 * UTM and signup-geography breakdowns, and the feedback counts. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.4/§6, `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching. The queries live in `lib/admin-audience.ts`; this handler parses,
 * fans out, and wraps the envelope.
 *
 * ─── Three choices worth knowing before extending this ───────────────────────
 *
 * **1. The series is derived live, and does not read `metrics_daily`.** §7.1
 * snapshots `audience.subscribers_active` / `_unsubscribed` / `feedback_total`
 * daily and anticipated this endpoint reading them. It does not, because
 * `unsubscribed_at` is a soft delete and nothing hard-deletes a `mailing_list`
 * row — so the active population on any past day is exactly recoverable from the
 * two timestamps, which is the property §4 shows the *catalog* stocks lack. Going
 * through the snapshot would have cost every day before 2026-08-13 (stocks are
 * never backfilled) and risked a worse error, since `/metrics/timeseries`
 * zero-fills and a zero-filled stock reports an uncaptured day as zero
 * subscribers rather than as unknown. `source` is therefore the literal `'live'`.
 *
 * **2. The two halves answer different questions and say so.** `subscribers` is
 * lifetime and windowless — "how many people are on the list" has no time range,
 * the same reasoning that keeps a window off `/catalog/coverage`. `window_totals`
 * is the period view. Both carry a `churn_rate`, and they are not the same
 * number: one is "what fraction of everyone who ever joined has left", the other
 * "what fraction of the opening population left during this window".
 *
 * **3. Both rates are `null` on an empty denominator.** Not zero. `mailing_list`
 * has 0 rows today (§3), so an empty response is the FIRST thing anyone will see,
 * and `0%` churn there would be a clean bill of health nobody measured. §5.1's
 * "`null` renders as *Not measured*, never as zero" is the governing rule, and
 * sending `null` rather than a formatted placeholder is what stops the UI from
 * being able to fudge it.
 */

import {
  AdminAudienceQuerySchema,
  AdminAudienceResponseSchema,
  type AdminAudienceResponse,
  type AdminNote,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { isPartial, note, toAdminWindow, utcRangeWindow } from '../lib/admin-analytics';
import {
  audienceAsnBreakdown,
  audienceBreakdown,
  audienceNotes,
  audienceSeries,
  feedbackCounts,
  subscriberTotals,
} from '../lib/admin-audience';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-catalog.ts`.
type AdminContext = Context<{ Bindings: Env }>;

export interface AdminAudienceDeps {
  now?: () => Date;
}

export function createAdminAudienceHandler(
  dbFor: DbFactory = getDb,
  deps: AdminAudienceDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminAudienceQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    const w = utcRangeWindow(query.from, query.to);
    const limit = query.breakdown_limit;

    // Nine independent reads over one window. Serialising them would multiply the
    // slowest round trip for no gain, and a single failure is one honest error
    // state rather than a partially-populated screen whose sections cannot
    // reconcile against each other.
    const [totals, seriesResult, utmSource, utmMedium, utmCampaign, geo, feedback] =
      await Promise.all([
        subscriberTotals(db),
        audienceSeries(db, w),
        audienceBreakdown(db, 'utm_source', w, limit),
        audienceBreakdown(db, 'utm_medium', w, limit),
        audienceBreakdown(db, 'utm_campaign', w, limit),
        Promise.all([
          audienceBreakdown(db, 'country', w, limit),
          audienceBreakdown(db, 'region', w, limit),
          audienceBreakdown(db, 'city', w, limit),
          audienceAsnBreakdown(db, w, limit),
        ]),
        feedbackCounts(db, w),
      ]);

    const [country, region, city, asn] = geo;

    const notes: AdminNote[] = audienceNotes({
      totalEver: totals.total_ever,
      windowSignups: seriesResult.totals.signups,
      signupsWithoutUtmSource: seriesResult.signupsWithoutUtmSource,
    });

    if (isPartial(w, now)) {
      notes.push(
        note(
          'partial_day',
          'The window includes the current UTC day, whose figures are still filling.',
          { day: w.toDay },
        ),
      );
    }

    const body: AdminAudienceResponse = {
      window: toAdminWindow(w),
      generated_at: now.toISOString(),
      source: 'live',
      notes,
      breakdown_limit: limit,
      subscribers: totals,
      series: seriesResult.series,
      window_totals: seriesResult.totals,
      utm: { source: utmSource, medium: utmMedium, campaign: utmCampaign },
      geography: { country, region, city, asn },
      feedback,
    };

    validateResponseInDev(c.env, () => {
      AdminAudienceResponseSchema.parse(body);
    });

    return json(body);
  };
}
