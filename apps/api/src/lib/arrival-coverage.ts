/**
 * Arrival network-metadata coverage — the AECI-868 telemetry tripwire.
 *
 * ─── What this measures, and why it is worth a check of its own ─────────────
 *
 * A `page_views` row with `navigation = 'arrival'` is a full-document load, and
 * it is written by exactly one writer: the SSR Worker's `firePageView`
 * (`apps/web/src/server-runtime.ts`). That writer derives the trusted
 * `x-aeci-cf-*` headers from `request.cf`, and the API's `POST /api/page-views`
 * stores them as `cf_asn` / `cf_country` / `cf_colo` / `cf_as_organization` /
 * `tls_version` / `http_protocol`. The browser tracker's `spa` rows come down a
 * different path and carry their own metadata, so they are deliberately NOT in
 * scope here — mixing them in would dilute exactly the signal this watches.
 *
 * From WC-4 (2026-07-19) until AECI-868, the cache gateway forwarded every
 * GET/HEAD to the cached `Renderer` entrypoint with `{ cf: { cacheKey } }`. A
 * supplied `cf` object REPLACES `request.cf` on that loopback rather than merging
 * into it, so `Renderer` saw a one-field `cf`, set none of the headers, and every
 * arrival stored NULL for all six columns. On production that ran from the
 * 2026-09-07 promote until the fix: **1,458 of 1,458** arrivals carried an ASN on
 * Sep 6, **0 of 2,633** on Sep 8.
 *
 * Nothing failed. No error fired, no count dropped, and the human/bot split still
 * rendered — it just lost the input underneath it. `DATACENTER_ASNS`
 * classification, the swarm and ASN-rotator groupings, the AECI-683 operator-pair
 * retro-join and the §9.8 `(user_agent_hash, cf_asn)` visitor definition all read
 * `cf_asn`, and all of them treat NULL as "no evidence" rather than as an error.
 * So the outage read as *fewer bots detected*, which is indistinguishable from
 * good news. **That is the whole argument for this module**: the defect class is
 * silent, and only a ratio watched over time can see it.
 *
 * ─── Scope decisions ───────────────────────────────────────────────────────
 *
 * - **No population filter.** Bot rows, operator rows and internal paths all
 *   count. This is a question about the *pipeline*, not about the audience: an
 *   outage that spared humans and blinded the bot half would still be an outage,
 *   and filtering would shrink the denominator enough to hide a partial one.
 * - **`cf_asn` is the probe field.** It is the one the six columns fail together
 *   with, it is an integer (so "present" is unambiguous), and it is the input the
 *   most downstream readers depend on.
 * - **Read-only.** No audit row (ADR 0022 exempts `page_views` as log-class), no
 *   write of any kind, no migration.
 *
 * AECI-869 renders this same figure as a digest / admin telemetry-health line, so
 * keep the signature small and the return shape stable.
 */

import { and, count, eq, gte, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViews } from '../db/schema';

/**
 * The `page_views.navigation` value for a full-document load (AECI-585).
 * `'spa'` is the in-app counterpart and NULL is every row written before the
 * column shipped. Named here rather than inlined so a reader can see that this
 * module targets one writer's rows, not "all page views".
 */
export const ARRIVAL_NAVIGATION = 'arrival';

/**
 * The minimum share of arrivals that must carry a `cf_asn` before the daily
 * data-quality check fails (AECI-868).
 *
 * 0.95 rather than 1.0 because a small NULL tail is legitimate and permanent:
 * `request.cf` is absent on a non-Cloudflare runtime, and a request that reaches
 * the Worker without edge context still writes its row. The observed healthy
 * state is ~100%, and the defect this guards took coverage to **0%** — so any
 * threshold in this region separates the two. It is set low enough that normal
 * noise never pages and high enough that a partial regression (one entrypoint, one
 * route class) is still caught well before a human notices a missing bot split.
 */
export const ARRIVAL_CF_COVERAGE_MIN = 0.95;

/** One window's arrival-metadata coverage. `coverage` is `arrivalsWithAsn / arrivals`. */
export interface ArrivalCfCoverage {
  /** Full-document (`navigation = 'arrival'`) rows in the window. */
  arrivals: number;
  /** How many of those carry a non-null `cf_asn`. */
  arrivalsWithAsn: number;
  /**
   * The ratio in `[0, 1]`. **`1` when `arrivals` is 0** — an empty window is not a
   * telemetry defect, and returning 0 there would make every quiet night a page.
   * Callers that need to tell "clean" from "nothing happened" read `arrivals`.
   */
  coverage: number;
}

/**
 * Count arrivals and ASN-bearing arrivals in the half-open UTC window
 * `[startIso, endIso)`.
 *
 * One `SELECT` with a conditional `SUM`, not two queries: a single scan of the
 * same rows guarantees the numerator can never be measured against a denominator
 * from a different instant, which is the failure mode of any ratio assembled from
 * two round trips. Bounds are ISO-8601 strings because `page_views.created_at` is
 * stored as text.
 */
export async function readArrivalCfCoverage(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<ArrivalCfCoverage> {
  const [row] = await db
    .select({
      arrivals: count(),
      // `SUM` over zero rows is NULL in SQLite, so this is coerced below rather
      // than trusted — `arrivals === 0` and `arrivalsWithAsn === null` arrive together.
      arrivalsWithAsn: sql<
        number | null
      >`sum(case when ${pageViews.cfAsn} is not null then 1 else 0 end)`,
    })
    .from(pageViews)
    .where(
      and(
        eq(pageViews.navigation, ARRIVAL_NAVIGATION),
        gte(pageViews.createdAt, startIso),
        lt(pageViews.createdAt, endIso),
      ),
    );

  const arrivals = Number(row?.arrivals ?? 0);
  const arrivalsWithAsn = Number(row?.arrivalsWithAsn ?? 0);
  return {
    arrivals,
    arrivalsWithAsn,
    coverage: arrivals === 0 ? 1 : arrivalsWithAsn / arrivals,
  };
}
