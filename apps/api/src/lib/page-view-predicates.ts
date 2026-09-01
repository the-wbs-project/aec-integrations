/**
 * The `page_views` population predicates, in one module both readers import
 * (AECI-745).
 *
 * ─── Why these live apart from the two modules that use them ────────────────
 *
 * `analytics-digest.ts` counts the population; `swarm-detection.ts` decides which
 * part of that population is automated. Both must describe the SAME rows, or the
 * digest's "N of the M reported views may not be people" compares two populations
 * that merely look alike. Until AECI-745 they shared the predicates by
 * `swarm-detection` importing `analytics-digest` — which fixed the direction of
 * the dependency and meant the collector could never call the detector. The panel
 * therefore had no path to the filtered figure, and `/admin/overview` led with a
 * raw count while the 05:00 email led with a filtered one (14 vs 70 on
 * 2026-08-30).
 *
 * Lifting them here inverts nothing and breaks the cycle: both modules depend on
 * this one, this one depends on neither, and `analytics-digest` is free to import
 * `swarm-detection`. **Keep that shape.** Nothing in this file may import either
 * of them.
 *
 * Everything below moved here VERBATIM. The NULL-safe `NOT EXISTS` form of
 * {@link OPERATOR_PAIR_MATCH}, its `%Y-%m-%dT%H:%M:%fZ` format string, and the
 * "IS NULL OR NOT IN" shape of {@link notFlagged} are each load-bearing and
 * documented as such below — this was a move, not a rewrite, and the same
 * warnings apply.
 */

import { and, eq, inArray, isNull, not, notLike, or, sql } from 'drizzle-orm';

import { UNTRACKED_ROUTE_PREFIXES } from '@aeci/shared';

import { pageViews } from '../db/schema';

/**
 * The automated clients a run flagged, as plain data (AECI-747).
 *
 * Still plain primitives rather than a `SwarmSummary`, even though AECI-745
 * removed the import cycle that originally forced it. The reason is now the one
 * that always mattered underneath: this module owns only the COMPLEMENT of
 * "flagged", and `swarm-detection.ts` owns what flagged MEANS. Handing the
 * complement a summary object would invite it to re-derive the decision from the
 * candidate fields, and then there would be two definitions again.
 */
export interface AutomationExclusion {
  /** `user_agent_hash` values flagged as rotating-proxy swarms. */
  uaHashes: readonly string[];
  /** `cf_asn` values flagged as user-agent rotators. */
  asns: readonly number[];
  /**
   * `client_verdict` values that flag a row ON THEIR OWN, with no view floor
   * (AECI-744) — `['inconsistent', 'non-browser']`, `NON_BROWSER_VERDICTS` there.
   *
   * Unlike the two lists above this is a fixed vocabulary, not a per-run result,
   * and it is passed rather than hardcoded here for the same reason they are: the
   * detector owns what "flagged" means, and this module owns only the complement.
   */
  verdicts: readonly string[];
}

/**
 * "This row is NOT attributable to a flagged automated client" — the exact
 * complement of `swarm-detection.ts`'s `countFlaggedViews`, so the headline
 * (`total - flagged`) and the tables (filtered by this) describe the same
 * population. If the two ever drift, the email reports a filtered number over
 * unfiltered rows, which is the inconsistency this exists to close.
 *
 * **NULL-safety is load-bearing and must not be "simplified".** The flagged
 * predicate is `ua IN (…) OR asn IN (…) OR client_verdict IN (…)` (the third term
 * since AECI-744). A row with a NULL hash, a NULL ASN and a NULL verdict makes
 * every `IN` NULL, so `OR` is NULL, so the row is NOT counted as flagged —
 * it stays in the headline. The tempting negation `not(or(inArray…, inArray…))`
 * is NULL for that same row, and a NULL `WHERE` DROPS it — so the row would
 * vanish from the tables while remaining in the count. Writing each half as
 * "IS NULL OR NOT IN" keeps it. Same three-valued-logic trap `OPERATOR_PAIR_MATCH`
 * documents above.
 */
export function notFlagged(exclusion: AutomationExclusion | undefined) {
  if (!exclusion) return undefined;
  const clauses = [];
  if (exclusion.uaHashes.length > 0) {
    clauses.push(
      or(
        isNull(pageViews.userAgentHash),
        not(inArray(pageViews.userAgentHash, [...exclusion.uaHashes])),
      ),
    );
  }
  if (exclusion.asns.length > 0) {
    clauses.push(or(isNull(pageViews.cfAsn), not(inArray(pageViews.cfAsn, [...exclusion.asns]))));
  }
  if (exclusion.verdicts.length > 0) {
    // Same NULL-safe shape, and load-bearing for the same reason: a row written
    // before `client_verdict` existed counts in the headline, so it must survive
    // the tables. `not(inArray(...))` alone is NULL for that row and a NULL
    // `WHERE` drops it.
    clauses.push(
      or(
        isNull(pageViews.clientVerdict),
        not(inArray(pageViews.clientVerdict, [...exclusion.verdicts])),
      ),
    );
  }
  return clauses.length > 0 ? and(...clauses) : undefined;
}

/**
 * A row is "human" when it isn't flagged as a bot. `is_bot IS NOT 1` (NULL-safe) so
 * pre-classification rows (`is_bot = NULL`) count as human, not vanish.
 *
 * Exported because the admin panel (AECI-574) reads the SAME population — sharing
 * the predicate is what makes "the screen and the 05:00 email cannot disagree"
 * structural rather than a convention someone has to remember. The panel also
 * surfaces the resulting bias as a `bot_classification_incomplete` note.
 */
export const HUMAN = or(isNull(pageViews.isBot), eq(pageViews.isBot, false));
export const BOT = eq(pageViews.isBot, true);

/**
 * How far either side of a row the retro-join will look for an `is_operator = 1`
 * anchor on the same visitor pair. A documented launch tunable
 * (`POST_LAUNCH_MONITORING.md` §3) — raise it only against measured evidence.
 *
 * Symmetric on purpose: a lapse can sit before the operator's first flagged row
 * of a session as easily as after their last. On 2026-08-26 the anchors were on
 * BOTH sides of the gap (02:48-04:42 and 07:33 onward, with 05:46-07:32 dark).
 */
export const OPERATOR_PAIR_LOOKBACK_DAYS = 30;

/** `'-30 days'` / `'+30 days'`, bound as ordinary parameters rather than inlined.
 *  Two parameters for the whole predicate, no matter how many pairs exist. */
const LOOKBACK_BACK = `-${OPERATOR_PAIR_LOOKBACK_DAYS} days`;
const LOOKBACK_FWD = `+${OPERATOR_PAIR_LOOKBACK_DAYS} days`;

/**
 * "This row shares a `(user_agent_hash, cf_asn)` pair with a VERIFIED operator
 * row nearby in time" — the read-side repair for the operator session-lapse leak
 * (AECI-683).
 *
 * ─── The defect it closes ───────────────────────────────────────────────────
 *
 * `is_operator` is decided once, at ingest, and `lib/operator-session.ts` resolves
 * every failure to `false` — deliberately, so an auth hiccup costs a flag rather
 * than the row. An **expired** access token is one of those failures. So an
 * operator who browses across a token expiry writes flagged rows, then unflagged
 * rows, then flagged rows again, and nothing on the unflagged ones distinguishes
 * them from a visitor. On 2026-08-26 that was 22 views in one 105-minute gap
 * (ending on `/auth/login`, which is what a lapse looks like from the outside),
 * inside a 102-view "human" day whose corroborated population was 8 views from
 * 7 visitors.
 *
 * ─── Why the PAIR, and not either half ──────────────────────────────────────
 *
 * Measured on production 2026-08-19 and recorded in
 * `scripts/ops/2026-08-operator-page-view-backfill/operator-pairs.sql`:
 *
 *   - **The UA hash alone is wrong.** The operator's second browser hash
 *     `d37ac4d2…` — the very hash that leaked here — spans 6 ASNs across 5
 *     countries. A UA hash is a browser BUILD, shared with strangers; flagging it
 *     outright would delete real visitors in four countries.
 *   - **The ASN alone is wrong.** "Everything from Indonesia" was 44% false
 *     positives and 50% recall. That is the objection §13 D10 already recorded
 *     against `ANALYTICS_INTERNAL_ASNS`.
 *   - **The pair is right**, and is also exactly the tuple §9.8 already calls a
 *     "visitor" — so this excludes operator VISITORS in the same terms the panel
 *     counts everyone else in.
 *
 * ─── Why the anchors come from `is_operator = 1` only ───────────────────────
 *
 * The ops backfill could also prove a pair from an `/admin*` row, because no
 * visitor reaches one. That is no longer available: since AECI-575's write-side
 * guard (`server-runtime.ts`, `page-view-tracker.ts`) untracked routes are not
 * written AT ALL, so there are no such rows to harvest from any recent window.
 * `/account` would be the wrong source regardless — every signed-in user reaches
 * it, so harvesting there would exclude ordinary members' public browsing.
 *
 * ─── Two properties that must not be refactored away ────────────────────────
 *
 * **NULL-safe by construction.** A row with a NULL `user_agent_hash` or `cf_asn`
 * makes the inner `=` NULL, the subquery matches nothing, and `NOT EXISTS` is
 * TRUE — the row is KEPT. The tempting `NOT (hash = ? AND asn = ?)` form does the
 * opposite: SQL's three-valued logic turns it NULL and the `WHERE` drops the row.
 * Do not rewrite it that way.
 *
 * **The `strftime` format string is load-bearing.** `created_at` is
 * `new Date().toISOString()` — `2026-08-26T05:46:00.000Z`. Bare `datetime(…)`
 * returns `2026-07-27 05:46:00`, and a space sorts BEFORE `T`, so comparing the
 * two shapes is silently wrong at the boundary. `%Y-%m-%dT%H:%M:%fZ` reproduces
 * the stored format exactly.
 *
 * Exported in its POSITIVE form so the count of what the clause removes and the
 * clause itself are the same expression and cannot drift.
 */
export const OPERATOR_PAIR_MATCH = sql`exists (
    select 1 from ${pageViews} as op
     where op.is_operator = 1
       and op.user_agent_hash = ${pageViews.userAgentHash}
       and op.cf_asn = ${pageViews.cfAsn}
       and op.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', ${pageViews.createdAt}, ${LOOKBACK_BACK})
       and op.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', ${pageViews.createdAt}, ${LOOKBACK_FWD})
  )`;

/**
 * The path + flag halves WITHOUT the retro-join — the population the digest
 * counted before AECI-683.
 *
 * Exists only so `operatorLeakViews` can report exactly what the retro-join
 * removed. Nothing else should read it: a caller that wants "not the operator"
 * wants {@link NOT_INTERNAL}.
 */
export const NOT_INTERNAL_BEFORE_RETRO_JOIN = and(
  ...UNTRACKED_ROUTE_PREFIXES.flatMap((prefix) => [
    notLike(pageViews.path, prefix),
    notLike(pageViews.path, `${prefix}/%`),
  ]),
  or(isNull(pageViews.isOperator), eq(pageViews.isOperator, false)),
);

/**
 * Excludes the operator's own traffic. Three independent halves, deliberately one
 * predicate:
 *
 *   - **Operator-only PATHS** (`/admin/*`, `/account`) — the read-side half of
 *     AECI-575 / ADMIN_PANEL_SPEC §9.6, described below.
 *   - **Operator SESSIONS** (`is_operator = 1`) — the operator browsing the
 *     PUBLIC site while signed in as an admin (§13 **D13**,
 *     `lib/operator-session.ts`). The path half never saw these: standing on
 *     `/products/procore` is indistinguishable from a visitor doing the same,
 *     and on 2026-08-19 that was 15% of all human public-page views.
 *   - **Operator VISITOR PAIRS** ({@link OPERATOR_PAIR_MATCH}, AECI-683) — the
 *     rows a lapsed session left unflagged. The session half cannot see these
 *     either: `is_operator` is decided once at ingest and an expired token reads
 *     exactly like an anonymous request.
 *
 * They live in one constant because they answer one question — "is this row the
 * operator?" — and because a caller that remembered one and forgot the others
 * would report a number that is partly corrected, which is worse than any
 * consistent alternative. NULL-safe on `is_operator`: every row written before
 * D13 shipped is NULL and counts as a visitor, so history keeps reading exactly
 * as it did rather than shifting under a column it never had.
 *
 * **The third half is an INFERENCE, and is therefore reported.** The first two
 * are facts about the request — a path no visitor reaches, a signature that
 * verified — so the digest excludes them silently: they were never visitor
 * traffic. A pair match is a judgement about identity, and `ANALYTICS_BASELINE.md`
 * is explicit that the pair cohort must not be read as equivalent to the live
 * flag. So `AnalyticsMetrics.operatorLeakViews` counts what it removed and the
 * email prints it. Silence would be the same failure the headline number itself
 * was guilty of.
 *
 * The tracker no longer writes the path rows, but rows captured BEFORE that
 * shipped are indistinguishable from real traffic once they're in the table, so
 * filtering only at the write side would leave every pre-fix day permanently
 * inflated and inconsistent with every post-fix day. Applying it here makes the
 * whole history read the same way.
 *
 * Prefix list comes from `@aeci/shared` so the read side can't drift from the two
 * write-side guards. `path` is NOT NULL, so `NOT LIKE` is safe here (no
 * three-valued-logic surprise), and `page_views_path_idx` covers the column.
 *
 * **Kept a static constant on purpose.** The retro-join is written as a
 * self-contained correlated subquery anchored on each row's OWN timestamp rather
 * than as a `notInternalFor(window)` function, so all five read surfaces below
 * keep sharing one expression instead of each remembering to thread a window
 * through. It also binds a fixed two parameters regardless of how many operator
 * pairs exist — a JS-resolved pair list would bind two per pair and scale with
 * the data, which is precisely the D1 bound-parameter hazard the better-sqlite3
 * test harness cannot fail on (`TESTING_STRATEGY.md` §6.3).
 *
 * Exported because four other read surfaces must exclude the same rows or they
 * diverge from the digest they are meant to mirror: the admin panel
 * (`lib/admin-analytics.ts` + `routes/admin-overview.ts`, AECI-574), the
 * `metrics_daily` snapshot that reaches D1 through the first of those, and the
 * public home page's trending card (`lib/home-stats.ts`). Both panel modules
 * import it as `EXCLUDE_OPERATOR_TRAFFIC`, to stay distinct from that module's
 * unrelated `ANALYTICS_INTERNAL_ASNS` "internal" filter — the alias says *traffic*
 * rather than *routes* because since D13 it is no longer only about paths.
 *
 * Trending is the one that bites hardest if forgotten: it renders publicly, and
 * D12 recorded it as immune to the path half (an `/admin/*` row has no
 * `product_id`) — which is true and does not extend to an operator session, which
 * carries the FK like any other product view.
 *
 * One structural caveat: the correlated subquery names `"page_views"` columns
 * directly, so a caller that ALIASES `pageViews` would silently break the
 * correlation. No caller does today; keep it that way.
 */
export const NOT_INTERNAL = and(NOT_INTERNAL_BEFORE_RETRO_JOIN, not(OPERATOR_PAIR_MATCH));
