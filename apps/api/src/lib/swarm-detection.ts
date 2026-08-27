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
 * product pages under **five different UA hashes**, so every group was a
 * singleton, every group was under `SWARM_MIN_VIEWS`, and the day's five views
 * counted as five visitors.
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
 * AS47544 shape that motivated this was 5 views under 5 hashes: ratio 1.0.
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

/** What the digest and the admin panel report about a window. */
export interface SwarmSummary {
  /** UA hashes spread across too many networks. */
  uaCandidates: SwarmCandidate[];
  /** Networks serving too many user-agents. */
  asnCandidates: AsnRotatorCandidate[];
  /**
   * Human views in the window attributable to ANY flagged candidate.
   *
   * A UNION, not a sum. The two groupings overlap — a view can sit on a flagged
   * UA hash AND a flagged ASN — and adding the two totals would report more
   * suspicious views than the day contained, which is exactly the kind of number
   * this module was written to stop producing.
   */
  flaggedViews: number;
  /** Total human views in the window, for the "N of M" framing. */
  totalHumanViews: number;
  /** Whether either candidate list hit {@link SWARM_MAX_CANDIDATES}. */
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
 * Group a window's HUMAN views by `user_agent_hash` and return the hashes whose
 * network spread is inconsistent with being a browser.
 *
 * Deliberately reuses the digest's own `HUMAN` + `NOT_INTERNAL` predicates rather
 * than restating them: this must describe the exact population the headline
 * number counts, or "N of the M reported views" is comparing two different sets.
 * Bot rows are already excluded, so a well-behaved crawler that identifies itself
 * (Googlebot, Bingbot, Applebot) can never appear here.
 */
export async function detectUaHashSwarms(
  db: Db,
  startIso: string,
  endIso: string,
): Promise<SwarmCandidate[]> {
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
    .where(and(humanWindow(startIso, endIso), sql`${pageViews.userAgentHash} is not null`))
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
      asnRatio: ratio(r.distinctAsns, r.views),
      pathRatio: ratio(r.distinctPaths, r.views),
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
      nonBrowserViews: sql<number>`sum(case when ${pageViews.clientVerdict} in ('inconsistent', 'non-browser') then 1 else 0 end)`,
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
 * Both groupings over one window, plus the de-duplicated view count they account
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

  const [allUa, allAsn, totals] = await Promise.all([
    detectUaHashSwarms(db, startIso, endIso),
    detectAsnRotators(db, startIso, endIso),
    db.select({ value: count() }).from(pageViews).where(window),
  ]);

  const uaCandidates = allUa.slice(0, SWARM_MAX_CANDIDATES);
  const asnCandidates = allAsn.slice(0, SWARM_MAX_CANDIDATES);
  const truncated = allUa.length > uaCandidates.length || allAsn.length > asnCandidates.length;

  return {
    uaCandidates,
    asnCandidates,
    flaggedViews: await countFlaggedViews(db, window, uaCandidates, asnCandidates),
    totalHumanViews: totals[0]?.value ?? 0,
    truncated,
  };
}

/** The union count. Skips the round trip entirely when nothing was flagged. */
async function countFlaggedViews(
  db: Db,
  window: ReturnType<typeof humanWindow>,
  uaCandidates: readonly SwarmCandidate[],
  asnCandidates: readonly AsnRotatorCandidate[],
): Promise<number> {
  if (uaCandidates.length === 0 && asnCandidates.length === 0) return 0;
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
 */
export function swarmNote(summary: SwarmSummary): string | null {
  const { flaggedViews, totalHumanViews, uaCandidates, asnCandidates } = summary;
  if (uaCandidates.length === 0 && asnCandidates.length === 0) return null;

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
  const truncationNote = summary.truncated
    ? ` Only the ${SWARM_MAX_CANDIDATES} largest of each kind are listed.`
    : '';
  return `${flaggedViews} of ${totalHumanViews} may not be people: ${clauses.join('; and ')}.${truncationNote}`;
}

/** Re-exported so the admin panel can render the same threshold text the digest uses. */
export const SWARM_THRESHOLD_NOTE =
  `Flagged when one user-agent hash accounts for ${SWARM_MIN_VIEWS}+ views and ` +
  `at least ${Math.round(SWARM_MIN_ASN_RATIO * 100)}% of them came from a different network, ` +
  `or when one network accounts for ${ASN_ROTATOR_MIN_VIEWS}+ views under ` +
  `${Math.round(ASN_ROTATOR_MIN_UA_RATIO * 100)}%+ distinct user-agents AND most of those ` +
  `requests do not look like a browser.`;

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
