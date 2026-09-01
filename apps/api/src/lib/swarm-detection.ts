/**
 * Rotating-proxy swarm detection over `page_views` (AECI-658).
 *
 * ─── The observation this encodes ───────────────────────────────────────────
 *
 * On UTC day 2026-08-23 the digest reported 48 "human" views. Those 48 spanned
 * **44 ASNs and 31 countries** but only **18 `user_agent_hash` values**. One hash
 * accounted for nine views from nine different countries on nine different
 * networks, hitting nine different pages and never repeating one; six more
 * behaved identically. Between them they enumerated 22 distinct taxonomy terms
 * with exactly one view each. All 48 produced zero PostHog events.
 *
 * `cf_asn` shatters a swarm like that into 44 apparent visitors. `user_agent_hash`
 * reassembles it into seven. That is the whole idea: this is the same join
 * AECI-582's backfill used retroactively (`recover-ua-names.sql`), pointed
 * forward at live traffic.
 *
 * ─── And the exact inverse, which the first grouping cannot see (AECI-683) ───
 *
 * A grouping is blind to whatever it groups ON. Rotate the user-agent instead of
 * the IP and the UA-hash test collapses: on 2026-08-26, AS47544 (PL) read five
 * product pages under **four different UA hashes**, so every group was a
 * singleton, every group was under `SWARM_MIN_VIEWS`, and the day's five views
 * counted as five visitors. (Four, not five: 4/5 = 0.80 is exactly
 * `ASN_ROTATOR_MIN_UA_RATIO`, which is why `POST_LAUNCH_MONITORING.md` §3 can say
 * the threshold is validated at that value and `0.85` would have missed it.)
 *
 * {@link detectAsnRotators} is the mirror image — group by `cf_asn`, flag one
 * network serving nearly a new fingerprint per request. Between them the two
 * groupings cover both ways a client can dilute itself: many networks behind one
 * fingerprint, or many fingerprints behind one network.
 *
 * The mirror needs a guard the original does not, and it is the whole reason the
 * request-shape verdict is a HARD gate there: a corporate NAT, a campus, or a
 * coffee shop legitimately produces five views from five devices on one ASN at a
 * ratio of 1.0. What it does not produce is a majority of `inconsistent` /
 * `non-browser` verdicts. Cardinality alone would flag every shared network on
 * the internet.
 *
 * ─── And a hash is not re-tried from scratch every morning (AECI-742) ───────
 *
 * Both groupings above judge a window in isolation, which meant a client that
 * happened to reuse one network on a quiet day dropped under `SWARM_MIN_ASN_RATIO`
 * and was counted as a person for that day. Measured against production,
 * `53304b2e...` was flagged on 8/29 at ratio 1.00 and escaped on 8/30 at 0.70,
 * while `02048353...` did the exact inverse — between them 18 of the 37 residual
 * views across those two days, the largest single bucket left in the headline.
 *
 * {@link detectUaHashSwarms} therefore carries a prior: a hash flagged at FULL
 * strength on {@link SWARM_PRIOR_MIN_FLAGGED_DAYS} of the previous
 * {@link SWARM_PRIOR_LOOKBACK_DAYS} days is held to a lower bar today. The prior
 * is never built from relaxed flags and never from the reported day itself, so
 * the memory cannot ratchet; and the bar is lowered, not removed, so a hash that
 * settles onto one network is forgiven within a fortnight.
 *
 * ─── The third use of the verdict: sufficient on its own, no floor (AECI-744) ─
 *
 * Both groupings above gate on a view-count FLOOR before any evidence is weighed
 * (`.having(count() >= …)`), so a low-volume automated client never reaches the
 * code that reads its verdict. On 2026-08-29 that let `87012404…` through: three
 * views, three different US networks, one fingerprint, seventeen hours apart, ASN
 * ratio 1.00 — and all three `client_verdict = 'inconsistent'`. Under the floor by
 * one view. With four more such singletons the next day, ~7 of the 37 residual
 * views were admitted as human on a technicality.
 *
 * The floors are correct for what they protect. They exist because a RATIO over a
 * tiny sample is meaningless: one view is trivially "1 ASN for 1 view". But
 * `client_verdict` is not a ratio and not an inference over a sample — it is a
 * direct observation about the headers of THIS request. It needs no sample size
 * to mean something, so {@link detectNonBrowserClients} has no floor at all.
 *
 * **Which of the three uses each call site relies on — read this before changing
 * any of them, because they are deliberately not interchangeable:**
 *
 * 1. **HARD GATE** — {@link detectAsnRotators}. Cardinality alone is the normal
 *    shape of any shared network, so without the verdict this flags every office
 *    NAT, campus and café on the internet. Never remove it.
 * 2. **CORROBORATION** — {@link detectUaHashSwarms}. `nonBrowserViews` is reported
 *    beside the ratios and filters nothing; the reader weighs it. This is the use
 *    the "known ceiling" section below says the module will lean on as we grow.
 * 3. **SUFFICIENT** — {@link detectNonBrowserClients}. Per ROW, no grouping, no
 *    floor, no ratio. The one place the verdict decides by itself.
 *
 * All three read the one vocabulary in {@link NON_BROWSER_VERDICTS}, and all three
 * are NULL-safe by construction: SQL `IN` against `NULL` is `NULL`, so a row
 * written before the column existed — like a `'browser'` or `'unknown'` row —
 * counts as NO EVIDENCE, never as "not a browser".
 *
 * ─── Read-side only. It never writes anything ───────────────────────────────
 *
 * Nothing here touches `is_bot`, and it must not start. `DATACENTER_ASNS` is the
 * only thing that writes a classification, its membership rule is deliberately
 * strict, and the networks a residential proxy rides on are genuine consumer
 * ISPs — adding them would teach the LIVE classifier that real people's ISPs are
 * datacenters (`bot-classification.ts` header; AECI-582 hit exactly this with 885
 * Applebot rows on Apple's AS714). This module reports; a human decides.
 *
 * ─── Known ceiling: it works because we are small ───────────────────────────
 *
 * A `user_agent_hash` is a browser BUILD fingerprint, not a person. Thousands of
 * unrelated people share "Chrome 128 on Windows 10" exactly, so at real volume a
 * popular UA hash legitimately spans many ASNs and this cardinality test alone
 * would light up constantly. It discriminates today because AECi's human volume
 * is ~50 views/day, where nine views from nine countries on one UA hash cannot
 * be coincidence.
 *
 * The signal that survives growth is the **combination** with `client_verdict`
 * (`lib/client-signals.ts`): a high-cardinality UA hash whose rows are also
 * mostly `inconsistent` / `non-browser` is evidence in a way that cardinality
 * alone stops being. `nonBrowserViews` is reported for exactly that reason —
 * read it alongside the ratios, never the ratios alone.
 *
 * The thresholds below are therefore **launch-tunable constants** in the sense of
 * `POST_LAUNCH_MONITORING.md` §3: expect to raise `SWARM_MIN_VIEWS` and lean
 * harder on the verdict mix as traffic grows. Revisit when human volume passes a
 * few hundred views/day.
 */

import { and, count, countDistinct, desc, gte, inArray, lt, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViews } from '../db/schema';

// Import direction matters: this module depends on `analytics-digest`, never the
// reverse. The digest consumes a `SwarmSummary` through a TYPE-only import, which
// is erased at compile time, so there is no runtime cycle. Keep it that way.
import { HUMAN, NOT_INTERNAL } from './analytics-digest';

/**
 * The `client_verdict` values that say "these headers do not look like a browser"
 * (`lib/client-signals.ts` — the other two values are `'browser'` and `'unknown'`).
 *
 * One exported array rather than the same literal pair repeated at each site, so
 * the module's three uses cannot drift apart, and so `analytics-digest.ts` can be handed
 * the same vocabulary as plain data instead of importing this module back (which
 * would close the runtime cycle the import comment above forbids).
 */
export const NON_BROWSER_VERDICTS = ['inconsistent', 'non-browser'] as const;

/** "This row's request shape is not a browser's." NULL-safe: `IN` against a NULL
 *  verdict is NULL, so pre-AECI-658 rows are no evidence rather than evidence. */
const NON_BROWSER = inArray(pageViews.clientVerdict, [...NON_BROWSER_VERDICTS]);

/** `COUNT` of the rows in a group whose verdict is non-browser — uses (1) and (2)
 *  above. Shared so the gate and the note count the same thing. */
const nonBrowserViewsExpr = sql<number>`sum(case when ${NON_BROWSER} then 1 else 0 end)`;

/**
 * Minimum views before a UA hash is even considered.
 *
 * Below this the ratios are noise: one view is trivially "1 ASN for 1 view"
 * (ratio 1.0) and would flag every single-hit visitor on the site.
 */
export const SWARM_MIN_VIEWS = 4;

/**
 * Distinct-ASN-to-views ratio at which a UA hash is called a swarm candidate.
 *
 * 0.8 means "nearly every view came from a different network." A real browser
 * sits on one network per session and a household changes ISP essentially never,
 * so legitimate traffic from one UA hash clusters; a rotating proxy pool cannot.
 */
export const SWARM_MIN_ASN_RATIO = 0.8;

/**
 * How far back the recurrence read looks for a hash's flagged history (AECI-742).
 *
 * The window ENDS at the reported window's own start and never reaches inside
 * it: a day must not count toward its own prior, or the test becomes circular.
 *
 * Fourteen days is long enough to survive a client pausing over a weekend and
 * short enough that a hash which genuinely reformed is forgiven inside a
 * fortnight. `page_views` is retained for 400 days, so the history is always
 * there to read; the ceiling on this constant is judgement, not retention.
 */
export const SWARM_PRIOR_LOOKBACK_DAYS = 14;

/**
 * Flagged days inside the lookback before a hash counts as recurring.
 *
 * Two, not one. One flagged day is the same evidence the per-day test already
 * acted on, so requiring one would merely re-apply yesterday's verdict to today.
 * Two means the shape repeated after the client had a chance not to. The eight
 * hashes this was built from ran EVERY day of 2026-08-21..30.
 */
export const SWARM_PRIOR_MIN_FLAGGED_DAYS = 2;

/**
 * The ratio bar a recurring hash is held to in place of {@link SWARM_MIN_ASN_RATIO}.
 *
 * 0.5 = "half its views still came from a different network". Both measured
 * escapes sit above it (`53304b2e...` at 0.70 on 8/30, `02048353...` at 0.63 on
 * 8/29) and comfortably below the standing 0.8 that let them through.
 *
 * Deliberately NOT zero. A prior lowers the bar; it does not remove it. A hash
 * that genuinely settles onto one network stops being flagged, which is the only
 * thing that keeps this memory from being a one-way list.
 */
export const SWARM_RECURRING_ASN_RATIO = 0.5;

/**
 * The view floor a recurring hash is held to in place of {@link SWARM_MIN_VIEWS}.
 *
 * {@link SWARM_MIN_VIEWS} exists because a ratio over 1-3 views is noise WHEN
 * NOTHING ELSE IS KNOWN. For a hash carrying a fortnight of flagged history
 * something else is known, and two views across two networks is corroboration
 * rather than coincidence. Still two rather than one: a single view is trivially
 * "1 ASN for 1 view" and carries no spread at all, so it would re-flag a known
 * hash on the strength of the prior alone.
 */
export const SWARM_RECURRING_MIN_VIEWS = 2;

/**
 * Minimum views before an ASN is considered a user-agent rotator.
 *
 * Same floor as {@link SWARM_MIN_VIEWS}, and for the same reason: one view is
 * trivially "1 UA for 1 view". Deliberately a SEPARATE constant even though the
 * values match today — the two groupings have different false-positive profiles
 * (this one has to survive shared NAT) and will very likely be tuned apart.
 */
export const ASN_ROTATOR_MIN_VIEWS = 4;

/**
 * Distinct-UA-hash-to-views ratio at which an ASN is called a rotator candidate.
 *
 * 0.8 means "nearly every request wore a different browser fingerprint." A UA
 * string changes on browser update, not between page loads, so a real network —
 * however many people are behind it — reuses fingerprints across a day. The
 * AS47544 shape that motivated this was 5 views under 4 hashes: ratio 0.80,
 * exactly this value. `0.85` would have missed it.
 */
export const ASN_ROTATOR_MIN_UA_RATIO = 0.8;

/**
 * Hard cap on each candidate list.
 *
 * The union count below binds one parameter per flagged hash and per flagged ASN,
 * and D1's bound-parameter ceiling is far below stock SQLite's — a limit the
 * better-sqlite3 test harness cannot reproduce, so an uncapped list would pass
 * every spec and fail on the first busy day (`TESTING_STRATEGY.md` §6.3). Real
 * days produce a handful. When it does bite, {@link SwarmSummary.truncated} says
 * so: a cap that silently drops evidence would make a partial read look complete,
 * which is the failure this whole module exists to stop.
 */
export const SWARM_MAX_CANDIDATES = 25;

/** One UA hash that looks like a rotating-proxy swarm rather than a visitor. */
export interface SwarmCandidate {
  userAgentHash: string;
  views: number;
  distinctAsns: number;
  distinctCountries: number;
  distinctPaths: number;
  /** Views whose `client_verdict` was `inconsistent` or `non-browser` (AECI-658).
   *  Null-safe: rows predating the column count as neither. */
  nonBrowserViews: number;
  /** `distinctAsns / views`, rounded to 2dp. 1.0 = a new network every hit. */
  asnRatio: number;
  /** `distinctPaths / views`, rounded to 2dp. 1.0 = never read the same page twice. */
  pathRatio: number;
  /**
   * Days in the previous {@link SWARM_PRIOR_LOOKBACK_DAYS} on which this hash met
   * the FULL-strength bar, or 0 when it has no such history (AECI-742).
   *
   * A count rather than a boolean so the digest, the panel and `job_runs` can say
   * how much history justified the lower bar rather than only that one existed.
   * `> 0` here means the candidate was judged against
   * {@link SWARM_RECURRING_ASN_RATIO} / {@link SWARM_RECURRING_MIN_VIEWS}; it does
   * not mean it would have failed the standing bar.
   */
  priorFlaggedDays: number;
}

/** One ASN that looks like a single client rotating its user-agent (AECI-683). */
export interface AsnRotatorCandidate {
  cfAsn: number;
  /** AS holder name captured at ingest, when we have one. Null on rows written
   *  before `cf_as_organization` shipped — it is a label, never a verdict. */
  asOrganization: string | null;
  views: number;
  distinctUaHashes: number;
  distinctCountries: number;
  distinctPaths: number;
  /** As {@link SwarmCandidate.nonBrowserViews} — and here it is a GATE, not a note. */
  nonBrowserViews: number;
  /** `distinctUaHashes / views`, rounded to 2dp. 1.0 = a new fingerprint every hit. */
  uaRatio: number;
  /** `distinctPaths / views`, rounded to 2dp. */
  pathRatio: number;
}

/**
 * Where a window's non-browser-verdict views came from (AECI-744).
 *
 * Purely DESCRIPTIVE, and that distinction is the whole design. The other two
 * types are candidates whose membership decides which views are flagged; this one
 * is a read-time rollup OF views already flagged individually, kept so the
 * operator can see which networks the flagged requests came from without querying
 * D1. Nothing downstream depends on it — see {@link SwarmSummary.verdictCandidates}.
 */
export interface NonBrowserCandidate {
  /** Null when the rows carried no ASN — kept as its own bucket, not dropped. */
  cfAsn: number | null;
  /** AS holder name captured at ingest, when we have one. A label, never a verdict. */
  asOrganization: string | null;
  views: number;
  distinctUaHashes: number;
  distinctCountries: number;
  distinctPaths: number;
}

/** What the digest and the admin panel report about a window. */
export interface SwarmSummary {
  /** UA hashes spread across too many networks. */
  uaCandidates: SwarmCandidate[];
  /** Networks serving too many user-agents. */
  asnCandidates: AsnRotatorCandidate[];
  /**
   * The networks behind {@link verdictFlaggedViews}, largest first (AECI-744).
   *
   * Descriptive only. Unlike the two lists above, truncating this one CANNOT
   * change {@link flaggedViews}: those flag by list membership, so a candidate cut
   * from the list takes its views out of the count with it, whereas the verdict
   * flags each row on its own in SQL and this rollup is read afterwards.
   */
  verdictCandidates: NonBrowserCandidate[];
  /**
   * Human views in the window attributable to ANY flagged candidate.
   *
   * A UNION, not a sum. The three shapes overlap — a view can sit on a flagged
   * UA hash AND a flagged ASN AND carry a non-browser verdict — and adding the
   * totals would report more suspicious views than the day contained, which is
   * exactly the kind of number this module was written to stop producing.
   */
  flaggedViews: number;
  /**
   * Human views in the window carrying a non-browser verdict (AECI-744).
   *
   * The gross count, NOT "views the other two groupings missed". It is a
   * component of {@link flaggedViews}, never an addend: the union above is what
   * reconciles the overlap, and subtracting here as well would double-correct it.
   */
  verdictFlaggedViews: number;
  /** Total human views in the window, for the "N of M" framing. */
  totalHumanViews: number;
  /** Whether either CANDIDATE list hit {@link SWARM_MAX_CANDIDATES}. Deliberately
   *  not affected by `verdictCandidates`, per the note on that field. */
  truncated: boolean;
}

/** The window predicate both groupings share — and it must be the digest's own,
 *  or "N of the M reported views" compares two different populations. */
function humanWindow(startIso: string, endIso: string) {
  return and(
    gte(pageViews.createdAt, startIso),
    lt(pageViews.createdAt, endIso),
    HUMAN,
    NOT_INTERNAL,
  );
}

/** `distinctPaths / views`, 2dp — the two groupings report it identically. */
function ratio(numerator: number, denominator: number): number {
  return Math.round((numerator / denominator) * 100) / 100;
}

/**
 * `startIso` shifted back by {@link SWARM_PRIOR_LOOKBACK_DAYS}.
 *
 * Computed in JS and bound as a plain string so the comparison never crosses a
 * format boundary. `created_at` is `new Date().toISOString()` and so is this, so
 * the two shapes are identical by construction — the trap `OPERATOR_PAIR_MATCH`
 * documents (a bare `datetime(...)` returns a SPACE where the stored value has a
 * `T`, and a space sorts before `T`) cannot arise here.
 */
function priorWindowStart(startIso: string): string {
  const start = new Date(startIso);
  start.setUTCDate(start.getUTCDate() - SWARM_PRIOR_LOOKBACK_DAYS);
  return start.toISOString();
}

/**
 * How many of the previous {@link SWARM_PRIOR_LOOKBACK_DAYS} each UA hash was
 * flagged on — the prior that AECI-742 added, keyed by hash (absent = none).
 *
 * The defect it answers: `SWARM_MIN_ASN_RATIO` was evaluated per-day and
 * independently each day, so a swarm that happened to reuse one network dropped
 * under the cutoff and was counted as a person for that day. Measured against
 * production, `53304b2e...` was flagged on 8/29 at ratio 1.00 and escaped on 8/30
 * at 0.70; `02048353...` did the exact inverse. That is 18 of the 37 residual
 * views across those two days — the largest single bucket in the headline — and
 * it is not a different client, it is the same one on a quieter day. Over
 * 2026-08-21..30 the eight swarm hashes each ran EVERY day, spanning 45-68 ASNs
 * across 29-38 countries.
 *
 * Three properties of this read are load-bearing:
 *
 *   - **The prior is evaluated at FULL strength** ({@link SWARM_MIN_VIEWS} /
 *     {@link SWARM_MIN_ASN_RATIO}), never at the relaxed bar it goes on to grant.
 *     Otherwise the memory bootstraps itself — a relaxed flag would justify
 *     tomorrow's relaxed flag, and a hash that once crossed the line could never
 *     get back out no matter how it behaved.
 *   - **The window ends at `startIso`**, strictly before the reported day, so a
 *     day never counts toward its own prior.
 *   - **It binds a fixed number of parameters** — two window bounds plus
 *     `NOT_INTERNAL`'s own two — regardless of how many hashes exist. A
 *     JS-resolved hash list would bind one per hash and scale with the data,
 *     which is precisely the D1 bound-parameter hazard the better-sqlite3 test
 *     harness cannot fail on (`TESTING_STRATEGY.md` §6.3).
 *
 * Reuses {@link humanWindow}, so the prior describes the same population the
 * headline counts: a bot row or an operator row can no more build a history than
 * it can be flagged today.
 *
 * **Its cost is load-bearing on `page_views_operator_pair_idx` (migration 0019),
 * and only on that.** `NOT_INTERNAL`'s retro-join is a correlated `EXISTS`, so
 * without that partial index the planner runs a full `SCAN op` per candidate row
 * and this read degrades from a lookup to a nested scan: measured over 41k rows,
 * 8 ms with the index against 4.3 s without (`SEARCH op USING COVERING INDEX`
 * versus `SCAN op`), and against prod-shaped data a 14-day window costs 14 s and
 * 42.7M rows read with the index absent. The index ships in the same migration as
 * the retro-join that needs it, so the two cannot separate — but if this read ever
 * looks slow, check `sqlite_master` for that index before tuning anything here.
 */
async function countPriorFlaggedDays(db: Db, startIso: string): Promise<Map<string, number>> {
  // The first ten characters of an ISO-8601 UTC timestamp ARE the UTC date, so
  // this is a substring rather than a date conversion.
  const utcDay = sql<string>`substr(${pageViews.createdAt}, 1, 10)`;
  const rows = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      day: utcDay,
      views: count(),
      distinctAsns: countDistinct(pageViews.cfAsn),
    })
    .from(pageViews)
    .where(
      and(
        humanWindow(priorWindowStart(startIso), startIso),
        sql`${pageViews.userAgentHash} is not null`,
      ),
    )
    .groupBy(pageViews.userAgentHash, utcDay)
    .having(gte(count(), SWARM_MIN_VIEWS));

  const flaggedDays = new Map<string, number>();
  for (const r of rows) {
    if (!r.userAgentHash || r.views < SWARM_MIN_VIEWS) continue;
    if (r.distinctAsns / r.views < SWARM_MIN_ASN_RATIO) continue;
    flaggedDays.set(r.userAgentHash, (flaggedDays.get(r.userAgentHash) ?? 0) + 1);
  }
  // Drop the hashes that repeated too few times to be a prior at all, so a caller
  // reading this map can treat presence as "recurring" without restating the rule.
  for (const [hash, days] of flaggedDays) {
    if (days < SWARM_PRIOR_MIN_FLAGGED_DAYS) flaggedDays.delete(hash);
  }
  return flaggedDays;
}

/**
 * Group a window's HUMAN views by `user_agent_hash` and return the hashes whose
 * network spread is inconsistent with being a browser.
 *
 * Deliberately reuses the digest's own `HUMAN` + `NOT_INTERNAL` predicates rather
 * than restating them: this must describe the exact population the headline
 * number counts, or "N of the M reported views" is comparing two different sets.
 * Bot rows are already excluded, so a well-behaved crawler that identifies itself
 * (Googlebot, Bingbot, Applebot) can never appear here.
 *
 * **A hash is not adjudicated from scratch (AECI-742).** One with a flagged
 * history in {@link countPriorFlaggedDays} is held to
 * {@link SWARM_RECURRING_ASN_RATIO} / {@link SWARM_RECURRING_MIN_VIEWS} instead of
 * the standing pair. The two reads are issued together, so the memory costs a
 * query but no extra round-trip latency.
 */
export async function detectUaHashSwarms(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<SwarmCandidate[]> {
  const [rows, prior] = await Promise.all([
    db
      .select({
        userAgentHash: pageViews.userAgentHash,
        views: count(),
        distinctAsns: countDistinct(pageViews.cfAsn),
        distinctCountries: countDistinct(pageViews.cfCountry),
        distinctPaths: countDistinct(pageViews.concretePath),
        // Null-safe on purpose: every row written before AECI-658 has a null
        // verdict and must count as "no evidence", never as "browser".
        nonBrowserViews: nonBrowserViewsExpr,
      })
      .from(pageViews)
      // A null hash cannot be grouped into a visitor at all, so it is not evidence
      // either way. Excluded rather than bucketed under a synthetic key, which
      // would invent one enormous fake swarm out of unrelated rows.
      .where(and(humanWindow(startIso, endIso), sql`${pageViews.userAgentHash} is not null`))
      .groupBy(pageViews.userAgentHash)
      // The LOOSEST of the two floors, not a lowered noise floor: which floor a
      // hash actually faces is only knowable once its prior is resolved, which
      // happens in the loop below. Every row this admits and the prior does not
      // vouch for is dropped there against the full `SWARM_MIN_VIEWS`.
      .having(gte(count(), Math.min(SWARM_MIN_VIEWS, SWARM_RECURRING_MIN_VIEWS)))
      .orderBy(desc(count())),
    countPriorFlaggedDays(db, startIso),
  ]);

  const candidates: SwarmCandidate[] = [];
  for (const r of rows) {
    if (!r.userAgentHash) continue;
    const priorFlaggedDays = prior.get(r.userAgentHash) ?? 0;
    const recurring = priorFlaggedDays > 0;
    if (r.views < (recurring ? SWARM_RECURRING_MIN_VIEWS : SWARM_MIN_VIEWS)) continue;
    const asnRatio = r.distinctAsns / r.views;
    if (asnRatio < (recurring ? SWARM_RECURRING_ASN_RATIO : SWARM_MIN_ASN_RATIO)) continue;
    candidates.push({
      userAgentHash: r.userAgentHash,
      views: r.views,
      distinctAsns: r.distinctAsns,
      distinctCountries: r.distinctCountries,
      distinctPaths: r.distinctPaths,
      nonBrowserViews: Number(r.nonBrowserViews ?? 0),
      asnRatio: ratio(r.distinctAsns, r.views),
      pathRatio: ratio(r.distinctPaths, r.views),
      priorFlaggedDays,
    });
  }
  return candidates;
}

/**
 * The inverse grouping (AECI-683): one `cf_asn`, many singleton UA hashes.
 *
 * **The request-shape verdict is a hard gate here, and that is the difference
 * from {@link detectUaHashSwarms}.** For a UA hash, spanning many networks is
 * already anomalous on its own and `nonBrowserViews` is corroboration a reader
 * weighs. For an ASN it is the reverse: a high UA-hash ratio is the NORMAL shape
 * of any shared network — an office NAT, a campus, a café — so cardinality alone
 * would flag real people constantly. What a rotator cannot launder is the shape
 * of the requests themselves. Without the gate this detector is a
 * shared-connection detector wearing a bot detector's name.
 *
 * Read-side only, like everything in this module. It never writes `is_bot`, and
 * a flagged ASN must NOT be added to `DATACENTER_ASNS` on this evidence — that
 * map drives the live classifier and a false positive there deletes real
 * visitors permanently (AECI-582's 885 Applebot rows on Apple's AS714).
 */
export async function detectAsnRotators(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<AsnRotatorCandidate[]> {
  const rows = await db
    .select({
      cfAsn: pageViews.cfAsn,
      // `max()` rather than a group key: the holder name is a read-time label
      // that is null on older rows, and grouping on it would split one ASN into
      // "named" and "unnamed" halves.
      asOrganization: sql<string | null>`max(${pageViews.cfAsOrganization})`,
      views: count(),
      distinctUaHashes: countDistinct(pageViews.userAgentHash),
      distinctCountries: countDistinct(pageViews.cfCountry),
      distinctPaths: countDistinct(pageViews.concretePath),
      nonBrowserViews: nonBrowserViewsExpr,
    })
    .from(pageViews)
    // Same reasoning as the null UA hash above: a null ASN groups nothing.
    .where(and(humanWindow(startIso, endIso), sql`${pageViews.cfAsn} is not null`))
    .groupBy(pageViews.cfAsn)
    .having(gte(count(), ASN_ROTATOR_MIN_VIEWS))
    .orderBy(desc(count()));

  const candidates: AsnRotatorCandidate[] = [];
  for (const r of rows) {
    if (r.cfAsn === null || r.views < ASN_ROTATOR_MIN_VIEWS) continue;
    const uaRatio = r.distinctUaHashes / r.views;
    if (uaRatio < ASN_ROTATOR_MIN_UA_RATIO) continue;
    const nonBrowserViews = Number(r.nonBrowserViews ?? 0);
    // The gate. See the doc comment: without it this flags every shared network.
    if (!isCorroboratedByRequestShape({ views: r.views, nonBrowserViews })) continue;
    candidates.push({
      cfAsn: r.cfAsn,
      asOrganization: r.asOrganization ?? null,
      views: r.views,
      distinctUaHashes: r.distinctUaHashes,
      distinctCountries: r.distinctCountries,
      distinctPaths: r.distinctPaths,
      nonBrowserViews,
      uaRatio: ratio(r.distinctUaHashes, r.views),
      pathRatio: ratio(r.distinctPaths, r.views),
    });
  }
  return candidates;
}

/**
 * The window's non-browser-verdict views, rolled up by network (AECI-744).
 *
 * **This function does not decide anything.** The flagging is per row and lives in
 * SQL — {@link NON_BROWSER} inside {@link countFlaggedViews} — precisely so that no
 * grouping, floor, ratio or list cap can stand between the evidence and the count.
 * What this returns is a legible summary OF that decision, for the operator's
 * triage: which networks, how many views each, how many fingerprints.
 *
 * Three consequences of that, each deliberate:
 *
 * * **No `having()` floor.** A single view is enough. That is the entire issue —
 *   a view floor gates a ratio, and there is no ratio here.
 * * **A null `cf_asn` is KEPT**, as its own `cfAsn: null` bucket, where both
 *   groupings above exclude it. Their exclusion exists because bucketing null
 *   under a synthetic key would invent one enormous fake swarm out of unrelated
 *   rows — an inference. Here the rows are already flagged individually and the
 *   bucket only says "we do not know the network", which is true and useful.
 * * **The cap is presentation.** It binds no parameters downstream, and slicing
 *   the list cannot remove a view from {@link SwarmSummary.flaggedViews}.
 */
export async function detectNonBrowserClients(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<NonBrowserCandidate[]> {
  const rows = await db
    .select({
      cfAsn: pageViews.cfAsn,
      // `max()` rather than a group key, as in `detectAsnRotators`: the holder
      // name is a read-time label that is null on older rows, and grouping on it
      // would split one ASN into "named" and "unnamed" halves.
      asOrganization: sql<string | null>`max(${pageViews.cfAsOrganization})`,
      views: count(),
      distinctUaHashes: countDistinct(pageViews.userAgentHash),
      distinctCountries: countDistinct(pageViews.cfCountry),
      distinctPaths: countDistinct(pageViews.concretePath),
    })
    .from(pageViews)
    .where(and(humanWindow(startIso, endIso), NON_BROWSER))
    .groupBy(pageViews.cfAsn)
    .orderBy(desc(count()));

  return rows.slice(0, SWARM_MAX_CANDIDATES).map((r) => ({
    cfAsn: r.cfAsn ?? null,
    asOrganization: r.asOrganization ?? null,
    views: r.views,
    distinctUaHashes: r.distinctUaHashes,
    distinctCountries: r.distinctCountries,
    distinctPaths: r.distinctPaths,
  }));
}

/**
 * All three shapes over one window, plus the de-duplicated view count they account
 * for between them.
 *
 * The union count is a third query rather than arithmetic on the two candidate
 * lists, because the lists carry per-group totals and a view matching both shapes
 * appears in each. Summing them would report more suspicious views than the day
 * contained.
 */
export async function detectSwarms(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<SwarmSummary> {
  const window = humanWindow(startIso, endIso);

  const [allUa, allAsn, verdictCandidates, totals, verdictFlaggedViews] = await Promise.all([
    detectUaHashSwarms(db, startIso, endIso),
    detectAsnRotators(db, startIso, endIso),
    detectNonBrowserClients(db, startIso, endIso),
    db.select({ value: count() }).from(pageViews).where(window),
    // Counted in SQL rather than summed off `verdictCandidates`, so the figure
    // survives that list being capped. See `SwarmSummary.verdictCandidates`.
    db.select({ value: count() }).from(pageViews).where(and(window, NON_BROWSER)),
  ]);

  // The cap is applied BEFORE the union read, and that ordering is what keeps the
  // bound-parameter count bounded: at most `SWARM_MAX_CANDIDATES` hashes plus the
  // same number of ASNs, i.e. 50 against D1's 100. AECI-742's relaxed bar makes the
  // UA list longer, so it makes truncation more likely — never less safe. Ordering
  // stays views-DESC, which already sorts a recurring swarm near the top.
  const uaCandidates = allUa.slice(0, SWARM_MAX_CANDIDATES);
  const asnCandidates = allAsn.slice(0, SWARM_MAX_CANDIDATES);
  const truncated = allUa.length > uaCandidates.length || allAsn.length > asnCandidates.length;

  return {
    uaCandidates,
    asnCandidates,
    verdictCandidates,
    flaggedViews: await countFlaggedViews(db, window, uaCandidates, asnCandidates),
    verdictFlaggedViews: verdictFlaggedViews[0]?.value ?? 0,
    totalHumanViews: totals[0]?.value ?? 0,
    truncated,
  };
}

/**
 * The union count across all three shapes.
 *
 * The verdict matcher is UNCONDITIONAL — it is a predicate over each row, not a
 * list of flagged keys — so unlike the previous version this never short-circuits
 * to zero without a round trip. That costs one query on a day that flags nothing,
 * and buys the property that matters: `analytics-digest.ts`'s `notFlagged()` is
 * documented as the exact complement of this function, and a branch here that the
 * complement does not also have is exactly how the two silently drift.
 */
async function countFlaggedViews(
  db: Db,
  window: ReturnType<typeof humanWindow>,
  uaCandidates: readonly SwarmCandidate[],
  asnCandidates: readonly AsnRotatorCandidate[],
): Promise<number> {
  const matchers = [
    uaCandidates.length > 0
      ? inArray(
          pageViews.userAgentHash,
          uaCandidates.map((c) => c.userAgentHash),
        )
      : undefined,
    asnCandidates.length > 0
      ? inArray(
          pageViews.cfAsn,
          asnCandidates.map((c) => c.cfAsn),
        )
      : undefined,
    NON_BROWSER,
  ].filter((m) => m !== undefined);
  const [row] = await db
    .select({ value: count() })
    .from(pageViews)
    .where(and(window, or(...matchers)));
  return row?.value ?? 0;
}

/**
 * One ASCII line for the digest, or null when nothing was flagged.
 *
 * Phrased as "may be" and "one automated client" on purpose. This is a
 * heuristic over a small sample, the operator is the one who decides, and a
 * digest that overstates its own certainty is how a wrong number becomes a
 * wrong decision.
 *
 * The null guard is "nothing was flagged", NOT "there are no candidates"
 * (AECI-744). A null note means "the detector ran and flagged nothing" to
 * `AutomationFilter`, and the headline is `raw - flaggedViews` — so a day whose
 * only flagged views came from the verdict would subtract from the headline with
 * no explanation anywhere in the email. Every subtraction gets a sentence.
 */
export function swarmNote(summary: SwarmSummary): string | null {
  const { flaggedViews, totalHumanViews, uaCandidates, asnCandidates, verdictCandidates } = summary;
  if (flaggedViews === 0) return null;

  const clauses: string[] = [];
  if (uaCandidates.length > 0) {
    const n = uaCandidates.length;
    clauses.push(
      `${n === 1 ? '1 client' : `${n} clients`} each read nearly every page from a ` +
        `different network, which is the shape of one automated client behind a ` +
        `rotating proxy pool rather than separate visitors`,
    );
  }
  if (asnCandidates.length > 0) {
    const n = asnCandidates.length;
    clauses.push(
      `${n === 1 ? '1 network' : `${n} networks`} served nearly a new browser ` +
        `fingerprint on every request, with request headers that mostly do not look ` +
        `like a browser, which is the shape of one client rotating its user-agent ` +
        `rather than separate visitors`,
    );
  }
  if (verdictCandidates.length > 0) {
    const views = summary.verdictFlaggedViews;
    const networks = verdictCandidates.length;
    clauses.push(
      `${views === 1 ? '1 view' : `${views} views`} arrived with request headers that ` +
        `do not look like a browser, from ${networks === 1 ? '1 network' : `${networks} networks`}, ` +
        `which is evidence about those requests themselves rather than an inference ` +
        `from how many of them there were`,
    );
  }
  // Said out loud because it is the one clause that rests on evidence from OUTSIDE
  // the reported day. A reader comparing the note to the day's own numbers would
  // otherwise find a candidate whose ratio sits under the published threshold and
  // conclude the detector had drifted.
  const recurring = uaCandidates.filter((c) => c.priorFlaggedDays > 0).length;
  const priorNote =
    recurring > 0
      ? ` ${recurring === 1 ? '1 of those clients was' : `${recurring} of those clients were`} ` +
        `already flagged on ${SWARM_PRIOR_MIN_FLAGGED_DAYS}+ of the previous ` +
        `${SWARM_PRIOR_LOOKBACK_DAYS} days, so a lower bar applied to it today.`
      : '';
  const truncationNote = summary.truncated
    ? ` Only the ${SWARM_MAX_CANDIDATES} largest of each kind are listed.`
    : '';
  return `${flaggedViews} of ${totalHumanViews} may not be people: ${clauses.join('; and ')}.${priorNote}${truncationNote}`;
}

/** Re-exported so the admin panel can render the same threshold text the digest uses. */
export const SWARM_THRESHOLD_NOTE =
  `Flagged when one user-agent hash accounts for ${SWARM_MIN_VIEWS}+ views and ` +
  `at least ${Math.round(SWARM_MIN_ASN_RATIO * 100)}% of them came from a different network, ` +
  `or when one network accounts for ${ASN_ROTATOR_MIN_VIEWS}+ views under ` +
  `${Math.round(ASN_ROTATOR_MIN_UA_RATIO * 100)}%+ distinct user-agents AND most of those ` +
  `requests do not look like a browser. A single view is also flagged on its own when ` +
  `its own request headers do not look like a browser, with no view count required. ` +
  `A hash already flagged on ${SWARM_PRIOR_MIN_FLAGGED_DAYS}+ of the previous ` +
  `${SWARM_PRIOR_LOOKBACK_DAYS} days is held to a lower bar on the day being reported: ` +
  `${SWARM_RECURRING_MIN_VIEWS}+ views at ${Math.round(SWARM_RECURRING_ASN_RATIO * 100)}%+ ` +
  `from a different network.`;

/** Exported for the spec: whether a candidate's request shape corroborates the
 *  cardinality signal. Kept as a function so the panel and the tests agree on
 *  what "corroborated" means rather than each inventing a threshold.
 *
 *  Takes the two fields rather than a whole candidate so both groupings can use
 *  it — and so they cannot end up with two different ideas of "corroborated",
 *  which matters more here than usual because for an ASN it is a GATE. */
export function isCorroboratedByRequestShape(candidate: {
  views: number;
  nonBrowserViews: number;
}): boolean {
  return candidate.nonBrowserViews > candidate.views / 2;
}
