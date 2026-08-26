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

import { and, count, countDistinct, desc, gte, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViews } from '../db/schema';

// Import direction matters: this module depends on `analytics-digest`, never the
// reverse. The digest consumes a `SwarmSummary` through a TYPE-only import, which
// is erased at compile time, so there is no runtime cycle. Keep it that way.
import { HUMAN, NOT_INTERNAL } from './analytics-digest';

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
}

/** What the digest and the admin panel report about a window. */
export interface SwarmSummary {
  candidates: SwarmCandidate[];
  /** Total human views in the window attributable to flagged UA hashes. */
  flaggedViews: number;
  /** Total human views in the window, for the "N of M" framing. */
  totalHumanViews: number;
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
 */
export async function detectSwarms(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<SwarmSummary> {
  const window = and(
    gte(pageViews.createdAt, startIso),
    lt(pageViews.createdAt, endIso),
    HUMAN,
    NOT_INTERNAL,
  );

  const rows = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      views: count(),
      distinctAsns: countDistinct(pageViews.cfAsn),
      distinctCountries: countDistinct(pageViews.cfCountry),
      distinctPaths: countDistinct(pageViews.concretePath),
      // Null-safe on purpose: every row written before AECI-658 has a null
      // verdict and must count as "no evidence", never as "browser".
      nonBrowserViews: sql<number>`sum(case when ${pageViews.clientVerdict} in ('inconsistent', 'non-browser') then 1 else 0 end)`,
    })
    .from(pageViews)
    // A null hash cannot be grouped into a visitor at all, so it is not evidence
    // either way. Excluded rather than bucketed under a synthetic key, which
    // would invent one enormous fake swarm out of unrelated rows.
    .where(and(window, sql`${pageViews.userAgentHash} is not null`))
    .groupBy(pageViews.userAgentHash)
    .having(gte(count(), SWARM_MIN_VIEWS))
    .orderBy(desc(count()));

  const candidates: SwarmCandidate[] = [];
  for (const r of rows) {
    if (!r.userAgentHash || r.views < SWARM_MIN_VIEWS) continue;
    const asnRatio = r.distinctAsns / r.views;
    if (asnRatio < SWARM_MIN_ASN_RATIO) continue;
    candidates.push({
      userAgentHash: r.userAgentHash,
      views: r.views,
      distinctAsns: r.distinctAsns,
      distinctCountries: r.distinctCountries,
      distinctPaths: r.distinctPaths,
      nonBrowserViews: Number(r.nonBrowserViews ?? 0),
      asnRatio: Math.round(asnRatio * 100) / 100,
      pathRatio: Math.round((r.distinctPaths / r.views) * 100) / 100,
    });
  }

  const [totals] = await db.select({ value: count() }).from(pageViews).where(window);

  return {
    candidates,
    flaggedViews: candidates.reduce((sum, c) => sum + c.views, 0),
    totalHumanViews: totals?.value ?? 0,
  };
}

/**
 * One ASCII line for the digest, or null when nothing was flagged.
 *
 * Phrased as "may be" and "one automated client" on purpose. This is a
 * heuristic over a small sample, the operator is the one who decides, and a
 * digest that overstates its own certainty is how a wrong number becomes a
 * wrong decision.
 */
export function swarmNote(summary: SwarmSummary): string | null {
  if (summary.candidates.length === 0) return null;
  const { flaggedViews, totalHumanViews, candidates } = summary;
  const clients = candidates.length === 1 ? '1 client' : `${candidates.length} clients`;
  return (
    `${flaggedViews} of ${totalHumanViews} may not be people: ${clients} each read ` +
    `nearly every page from a different network, which is the shape of one ` +
    `automated client behind a rotating proxy pool rather than separate visitors.`
  );
}

/** Re-exported so the admin panel can render the same threshold text the digest uses. */
export const SWARM_THRESHOLD_NOTE =
  `Flagged when one user-agent hash accounts for ${SWARM_MIN_VIEWS}+ views and ` +
  `at least ${Math.round(SWARM_MIN_ASN_RATIO * 100)}% of them came from a different network.`;

/** Exported for the spec: whether a candidate's request shape corroborates the
 *  cardinality signal. Kept as a function so the panel and the tests agree on
 *  what "corroborated" means rather than each inventing a threshold. */
export function isCorroboratedByRequestShape(candidate: SwarmCandidate): boolean {
  return candidate.nonBrowserViews > candidate.views / 2;
}
