/**
 * The admin panel's audience read layer (AECI-586 / `ADMIN_PANEL_SPEC.md` §5.4).
 *
 * Everything `GET /api/admin/audience` and `GET /api/admin/feedback` need:
 * lifetime subscriber stocks, the day-bucketed growth/churn series, the UTM and
 * signup-geography breakdowns, and the feedback inbox. The route handlers stay
 * thin — parse the query, call in here, wrap the envelope — matching
 * `lib/admin-analytics.ts` and `lib/admin-catalog.ts`.
 *
 * Four things are load-bearing and easy to get wrong:
 *
 * **1. Churn is exactly computable, and that is a property of the schema, not of
 * this code.** `unsubscribed_at` is a soft delete (AECI-537) — a suppression
 * record, so the subscriber is never re-emailed — and nothing in the repo ever
 * hard-deletes a `mailing_list` row. The population on any past day is therefore
 * `created_at <= D AND (unsubscribed_at IS NULL OR unsubscribed_at > D)`, exactly.
 * This is why §5.4 does not need the `metrics_daily` stocks the catalog counts
 * require: §4's problem is rows that vanish without per-row audit, and none vanish
 * here.
 *
 * **2. The one thing it cannot see is a resubscribe.** `POST /api/subscribe`'s
 * reactivation path *clears* `unsubscribed_at` back to null and keeps the original
 * `created_at`, so a subscriber who churned and came back reads as never-churned
 * and their suppressed days read as active. Nothing on the row records that it
 * happened. That is disclosed as `audience_history_is_current_state` rather than
 * left for a reader to discover — and it is also the reason the P2.1 snapshot
 * keeps writing `audience.subscribers_active`, which is the only durable record of
 * the state before a reactivation rewrote it.
 *
 * **3. The cumulative line is a running sum, not one query per day.** A row can
 * only enter the population through `created_at` and leave it through
 * `unsubscribed_at`, so seeding at `active_at_start` and carrying
 * `signups − unsubscribes` forward is exact — not an approximation of a
 * per-day `COUNT`. It also costs two statements instead of `days`.
 *
 * **4. A rate over an empty denominator is `null`, never `0`.** Both churn figures
 * return null when nothing was there to churn. §5.1's rule — "`null` renders as
 * *Not measured*, never as zero" — applies with more force to a ratio than to a
 * count: `0%` churn on an empty list is a clean bill of health nobody measured,
 * and both tables are empty today (§3), so this is the FIRST thing anyone sees.
 */

import {
  type AdminAudienceBreakdownRow,
  type AdminAudienceSeriesPoint,
  type AdminAudienceSubscribers,
  type AdminAudienceWindowTotals,
  type AdminFeedbackRow,
  type AdminNote,
} from '@aeci/shared';
import { and, asc, count, desc, gte, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { feedback, mailingList } from '../db/schema';
import { countAll, enumerateDays, note, type UtcWindow } from './admin-analytics';

/** `sum(case when <predicate> then 1 else 0 end)` — SQLite returns NULL over an
 *  empty table, hence the coalesce. Same idiom as `lib/admin-catalog.ts`. */
function tally(predicate: SQL): SQL<number> {
  return sql<number>`coalesce(sum(case when ${predicate} then 1 else 0 end), 0)`;
}

const num = (v: number | string | null | undefined): number => Number(v ?? 0);

/**
 * Day bucketing is `substr(created_at, 1, 10)`, not `strftime`: `createdAt()`
 * stamps `new Date().toISOString()` (`db/schema.ts`), so the first ten characters
 * ARE the UTC date. Same rule and same reasoning as `lib/admin-analytics.ts`.
 */
const signupDay = sql<string>`substr(${mailingList.createdAt}, 1, 10)`;
const unsubscribeDay = sql<string>`substr(${mailingList.unsubscribedAt}, 1, 10)`;

/** `column` inside `[start, end)`. ISO 8601 text sorts lexicographically the same
 *  as chronologically, so the string range is exact. */
function inWindow(column: AnySQLiteColumn, w: UtcWindow): SQL {
  return and(gte(column, w.startIso), lt(column, w.endIso)) as SQL;
}

// ─── Lifetime stocks ─────────────────────────────────────────────────────────

/**
 * Active / unsubscribed / total, in ONE statement so all three see the same
 * snapshot — a signup landing mid-request cannot make them disagree with each
 * other.
 *
 * `active` uses the identical `unsubscribed_at IS NULL` predicate as
 * `/api/admin/overview`'s `active_subscribers` and the snapshot cron's
 * `audience.subscribers_active` (both via `countAll`), so the three surfaces
 * cannot report different numbers for the same question.
 */
export async function subscriberTotals(db: Db): Promise<AdminAudienceSubscribers> {
  const [row] = await db
    .select({
      total_ever: count(),
      active: tally(sql`${mailingList.unsubscribedAt} is null`),
      unsubscribed: tally(sql`${mailingList.unsubscribedAt} is not null`),
    })
    .from(mailingList);

  const totalEver = num(row?.total_ever);
  const unsubscribed = num(row?.unsubscribed);
  return {
    active: num(row?.active),
    unsubscribed,
    total_ever: totalEver,
    // Undefined, not zero, over an empty list — see the module header, point 4.
    churn_rate: totalEver === 0 ? null : unsubscribed / totalEver,
  };
}

// ─── The windowed series ─────────────────────────────────────────────────────

/** Signups per day inside the window, keyed `YYYY-MM-DD`. */
async function signupsPerDay(db: Db, w: UtcWindow): Promise<Map<string, number>> {
  const rows = await db
    .select({ day: signupDay, value: count() })
    .from(mailingList)
    .where(inWindow(mailingList.createdAt, w))
    .groupBy(signupDay);
  return new Map(rows.map((r) => [r.day, r.value]));
}

/** Unsubscribes per day inside the window. `isNotNull` is redundant against the
 *  range comparison (NULL compares to neither bound) but makes the index usable
 *  and the intent legible. */
async function unsubscribesPerDay(db: Db, w: UtcWindow): Promise<Map<string, number>> {
  const rows = await db
    .select({ day: unsubscribeDay, value: count() })
    .from(mailingList)
    .where(and(isNotNull(mailingList.unsubscribedAt), inWindow(mailingList.unsubscribedAt, w)))
    .groupBy(unsubscribeDay);
  return new Map(rows.map((r) => [r.day, r.value]));
}

/**
 * The population at the instant the window opens: subscribed before it, and not
 * yet suppressed at that moment. `unsubscribed_at >= startIso` keeps a subscriber
 * who opts out *during* the window in the opening figure, which is what makes the
 * running sum below balance.
 */
function activeAtInstant(db: Db, instantIso: string): Promise<number> {
  return countAll(
    db,
    mailingList,
    and(
      lt(mailingList.createdAt, instantIso),
      sql`(${mailingList.unsubscribedAt} is null or ${mailingList.unsubscribedAt} >= ${instantIso})`,
    ) as SQL,
  );
}

export interface AudienceSeriesResult {
  series: AdminAudienceSeriesPoint[];
  totals: AdminAudienceWindowTotals;
  /** Signups in the window with no `utm_source` — the `utm_attribution_incomplete`
   *  numerator. Counted here rather than read off the breakdown's null bucket,
   *  which `breakdown_limit` could truncate away. */
  signupsWithoutUtmSource: number;
}

/**
 * The day-bucketed growth/churn series, zero-filled across every day in the
 * window, plus the window totals it reconciles against.
 *
 * `active_cumulative` carries forward from `active_at_start` rather than
 * re-counting per day. That is exact, not an approximation: entry and exit each
 * have exactly one timestamp, both of which are bucketed here.
 */
export async function audienceSeries(db: Db, w: UtcWindow): Promise<AudienceSeriesResult> {
  const [signups, unsubscribes, activeAtStart, signupStats] = await Promise.all([
    signupsPerDay(db, w),
    unsubscribesPerDay(db, w),
    activeAtInstant(db, w.startIso),
    db
      .select({
        signups: count(),
        withoutUtmSource: tally(sql`${mailingList.utmSource} is null`),
      })
      .from(mailingList)
      .where(inWindow(mailingList.createdAt, w)),
  ]);

  let running = activeAtStart;
  let totalSignups = 0;
  let totalUnsubscribes = 0;

  const series = enumerateDays(w).map<AdminAudienceSeriesPoint>((day) => {
    const s = signups.get(day) ?? 0;
    const u = unsubscribes.get(day) ?? 0;
    running += s - u;
    totalSignups += s;
    totalUnsubscribes += u;
    return { day, signups: s, unsubscribes: u, active_cumulative: Math.max(0, running) };
  });

  return {
    series,
    totals: {
      signups: totalSignups,
      unsubscribes: totalUnsubscribes,
      net: totalSignups - totalUnsubscribes,
      active_at_start: activeAtStart,
      active_at_end: Math.max(0, running),
      // Period churn: who left over who was there to leave. Null, not zero, on an
      // empty opening population — see the module header, point 4.
      churn_rate: activeAtStart === 0 ? null : totalUnsubscribes / activeAtStart,
    },
    signupsWithoutUtmSource: num(signupStats[0]?.withoutUtmSource),
  };
}

// ─── Breakdowns ──────────────────────────────────────────────────────────────

/**
 * The dimensions §5.4 asks for. `utm_*` is the attribution the signup band
 * captures from the live URL; the geography columns are derived from `request.cf`
 * by the caller and forwarded on `LANDING_CF_HEADERS` (`API_CONTRACTS.md` §6.13).
 */
export const AUDIENCE_TEXT_DIMENSIONS = {
  utm_source: mailingList.utmSource,
  utm_medium: mailingList.utmMedium,
  utm_campaign: mailingList.utmCampaign,
  country: mailingList.country,
  region: mailingList.region,
  city: mailingList.city,
} as const;

export type AudienceTextDimension = keyof typeof AUDIENCE_TEXT_DIMENSIONS;

/** The untranslated operator fallback for a NULL group. The UI keys off
 *  `key === null` and renders its own localized placeholder — these strings exist
 *  for curl and logs. */
const NULL_LABEL: Record<AudienceTextDimension | 'asn', string> = {
  utm_source: 'Unattributed',
  utm_medium: 'Unattributed',
  utm_campaign: 'Unattributed',
  country: 'Unknown',
  region: 'Unknown',
  city: 'Unknown',
  asn: 'Unknown',
};

/**
 * One dimension, grouped over signups **inside the window**.
 *
 * Three rules are lifted verbatim from `breakdown()` in `lib/admin-analytics.ts`,
 * because they are the same rules and getting any of them wrong is the same bug:
 *
 * - **The NULL group is surfaced, never dropped.** An organic signup has no
 *   `utm_source` and Cloudflare does not always resolve a country. Dropping those
 *   rows is how an attribution breakdown quietly starts claiming attribution it
 *   does not have, and it would stop the rows reconciling against the window's
 *   signup total.
 * - **A strict total order** — count desc, then named groups before the NULL
 *   bucket, then the key. The explicit `IS NULL` sort beats relying on collation:
 *   SQLite ascending puts NULL first, and an unattributed bucket should not
 *   outrank a named campaign that drew the same number of signups.
 * - **Capped, not paginated** — `limit` is the caller's `breakdown_limit`.
 */
export async function audienceBreakdown(
  db: Db,
  dimension: AudienceTextDimension,
  w: UtcWindow,
  limit: number,
): Promise<AdminAudienceBreakdownRow[]> {
  const column = AUDIENCE_TEXT_DIMENSIONS[dimension];
  const rows = await db
    .select({ key: column, subscribers: count() })
    .from(mailingList)
    .where(inWindow(mailingList.createdAt, w))
    .groupBy(column)
    .orderBy(desc(count()), asc(sql`${column} is null`), asc(column))
    .limit(limit);

  return rows.map((r) => ({
    key: r.key,
    label: r.key ?? NULL_LABEL[dimension],
    subscribers: r.subscribers,
  }));
}

/**
 * Signups grouped by autonomous system.
 *
 * Separate from the text dimensions because the grouped column and the label
 * column differ: **an ASN cannot label itself.** `as_organization` is the holder
 * name Cloudflare supplied, and `max()` picks one deterministically where a
 * single ASN was recorded under more than one spelling — the alternative,
 * grouping on the pair, would split one network across two rows.
 */
export async function audienceAsnBreakdown(
  db: Db,
  w: UtcWindow,
  limit: number,
): Promise<AdminAudienceBreakdownRow[]> {
  const asn = mailingList.asn;
  const rows = await db
    .select({
      key: asn,
      org: sql<string | null>`max(${mailingList.asOrganization})`,
      subscribers: count(),
    })
    .from(mailingList)
    .where(inWindow(mailingList.createdAt, w))
    .groupBy(asn)
    .orderBy(desc(count()), asc(sql`${asn} is null`), asc(asn))
    .limit(limit);

  return rows.map((r) => ({
    key: r.key === null ? null : String(r.key),
    label: r.key === null ? NULL_LABEL.asn : (r.org ?? `AS${r.key}`),
    subscribers: r.subscribers,
  }));
}

// ─── Feedback ────────────────────────────────────────────────────────────────

/** Both figures in one statement, for the same reason as `subscriberTotals`. */
export async function feedbackCounts(
  db: Db,
  w: UtcWindow,
): Promise<{ total_ever: number; in_window: number }> {
  const [row] = await db
    .select({
      total_ever: count(),
      in_window: tally(
        sql`${feedback.createdAt} >= ${w.startIso} and ${feedback.createdAt} < ${w.endIso}`,
      ),
    })
    .from(feedback);
  return { total_ever: num(row?.total_ever), in_window: num(row?.in_window) };
}

/**
 * One page of the inbox, newest first.
 *
 * Ordered `created_at DESC, id DESC`: the autoincrement id breaks ties so a page
 * boundary is stable even for two submissions stamped in the same millisecond —
 * without it, pagination could repeat or skip a row (the AECI-99 rule).
 *
 * `email` is returned whole. That is deliberate and is the opposite of the
 * `page_views` feed's truncated hash: a page view observes someone who never
 * identified themself, while this is contact information a person volunteered in
 * order to be replied to. `/api/admin/requests` returns `submitter_email` on the
 * same reasoning.
 */
export async function listFeedback(
  db: Db,
  page: number,
  perPage: number,
): Promise<{ rows: AdminFeedbackRow[]; total: number }> {
  const [total, rows] = await Promise.all([
    countAll(db, feedback),
    db
      .select()
      .from(feedback)
      .orderBy(desc(feedback.createdAt), desc(feedback.id))
      .limit(perPage)
      .offset((page - 1) * perPage),
  ]);

  return {
    total,
    rows: rows.map((r) => ({
      id: r.id,
      created_at: r.createdAt,
      features: r.features,
      tools: r.tools,
      email: r.email,
      subscribed: r.subscribed,
      country: r.country,
      city: r.city,
      region: r.region,
      timezone: r.timezone,
      referrer: r.referrer,
    })),
  };
}

// ─── Notes ───────────────────────────────────────────────────────────────────

/**
 * The window's caveats, derived from what the window actually contains — never
 * from a hardcoded date, the rule `bot_classification_incomplete` established and
 * then vindicated by retiring itself when AECI-582 ran.
 *
 * Neither note fires on an empty list, which is the state both tables are in
 * today (§3): 0 of 0 signups missing attribution is not incomplete, and there is
 * no history to caveat. An empty audience section should say "no subscribers
 * yet", not hand the operator two footnotes about data that does not exist.
 */
export function audienceNotes(input: {
  totalEver: number;
  windowSignups: number;
  signupsWithoutUtmSource: number;
}): AdminNote[] {
  const notes: AdminNote[] = [];

  if (input.signupsWithoutUtmSource > 0) {
    notes.push(
      note(
        'utm_attribution_incomplete',
        `${input.signupsWithoutUtmSource} of ${input.windowSignups} signups in this window carry no utm_source. They arrived without campaign parameters — the bucket is real signups, not missing rows.`,
        { missing: input.signupsWithoutUtmSource, total: input.windowSignups },
      ),
    );
  }

  if (input.totalEver > 0) {
    notes.push(
      note(
        'audience_history_is_current_state',
        'The series reads each subscriber row as it stands now. A resubscribe clears unsubscribed_at, so anyone who opted out and came back reads as never-churned and their suppressed days read as active.',
      ),
    );
  }

  return notes;
}

/** Exported for the specs and for `isNull`/`isNotNull` parity with the overview's
 *  active-subscriber count, which is the one figure this section shares. */
export const ACTIVE_SUBSCRIBER_PREDICATE = isNull(mailingList.unsubscribedAt);
export const UNSUBSCRIBED_PREDICATE = isNotNull(mailingList.unsubscribedAt);
