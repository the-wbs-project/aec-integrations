/**
 * Hash-level rule candidates, measured in shadow only (AECI-1584,
 * `POST_LAUNCH_MONITORING.md` §3c).
 *
 * A crawler on a residential proxy pool splits its views across many
 * `(user_agent_hash, cf_asn)` pairs, so the pair-level rules and the digest cannot
 * see it. This module measures three candidates beside the running classifier:
 * crawl shape per hash, a lower swarm bar for a hash with many networks and no hops,
 * and a hash-level digest line.
 *
 * **Nothing here is a rule.** `traffic-classifier.ts` does not import this file, and
 * no constant here is a classifier input, so the version and fingerprint stay put.
 * Nothing writes `is_bot` or `page_view_classifications`. The report exists so Chris
 * can rule, and a rule that follows goes through the §3c loop.
 *
 * **A candidate overlays the real classifier's result.** {@link candidateClass}
 * reads the families off `classifyPageView`'s reason codes, so it cannot drift from
 * the running rules on anything but the family it adds. The specs prove that against
 * `classifyPageView` itself.
 *
 * **The report may look forward; a rule may not.** {@link readVerifiedHopDays} reads
 * hops after a flagged day, to measure error. A rule never judges a day on later rows.
 */

import { and, gte, isNotNull, lt, sql } from 'drizzle-orm';

import { compareText } from '@aeci/shared/text-sort';

import type { Db } from '../db/client';
import { pageViews } from '../db/schema';
import {
  TOP_UNRESOLVED_CLIENTS_LIMIT,
  UNRESOLVED_CLIENT_ALERT_SHARE,
} from './admin-classification';
import {
  CRAWL_SHAPE_LOOKBACK_DAYS,
  referralCodes,
  SIGNAL_FAMILIES,
  SPA_FOLLOWUP_WINDOW_MINUTES,
  SUSPECTED_MIN_SIGNAL_FAMILIES,
  TRAFFIC_CLASSES,
  type ClassifierRow,
  type PageViewClassification,
  type ReasonCode,
  type TrafficClass,
} from './traffic-classifier';

/** The client AECI-1584 was filed for. The report states its reach under every cell. */
export const CANDIDATE_TARGET_HASH_PREFIX = '069245a2';

/** Arrivals a hash needs, across all its networks, to have a crawl shape. */
export const HASH_VIEW_FLOORS = [15, 30, 60] as const;
/** Distinct `concrete_path` ÷ arrivals at or above which a hash reads as crawling. */
export const HASH_PATH_RATIOS = [0.5, 0.8] as const;
/** Distinct networks a hash needs for either hash-level test. */
export const HASH_MIN_ASNS = [5, 10, 20] as const;
/** Distinct networks ÷ arrivals on the day at or above which the lower swarm bar passes. */
export const RELAXED_SWARM_RATIOS = [0.2, 0.3, 0.4] as const;

const DAY_MS = 86_400_000;

/**
 * - `hash_merged`: hash crawl shape and pair crawl shape are one family.
 * - `hash_distinct`: they count as two, which reads one hash's paths twice.
 * - `swarm`: the lower swarm bar alone.
 * - `hash_and_swarm`: hash crawl shape, merged with the pair family, plus the lower
 *   swarm bar. The only variant that can reach a tail view with no other signal.
 */
export const CANDIDATE_VARIANTS = [
  'hash_merged',
  'hash_distinct',
  'swarm',
  'hash_and_swarm',
] as const;
export type CandidateVariant = (typeof CANDIDATE_VARIANTS)[number];

export interface CandidateCell {
  variant: CandidateVariant;
  /** Null on `swarm`, which has no crawl test. */
  viewFloor: number | null;
  /** Null on `swarm`. */
  pathRatio: number | null;
  minAsns: number;
  /** Null on the two variants with no swarm test. */
  swarmRatio: number | null;
}

/** Every variant and threshold the report compares. */
export function candidateCells(): CandidateCell[] {
  const cells: CandidateCell[] = [];
  const hashVariants = ['hash_merged', 'hash_distinct'] as const;
  for (const variant of hashVariants) {
    for (const viewFloor of HASH_VIEW_FLOORS) {
      for (const pathRatio of HASH_PATH_RATIOS) {
        for (const minAsns of HASH_MIN_ASNS) {
          cells.push({ variant, viewFloor, pathRatio, minAsns, swarmRatio: null });
        }
      }
    }
  }
  for (const swarmRatio of RELAXED_SWARM_RATIOS) {
    for (const minAsns of HASH_MIN_ASNS) {
      cells.push({ variant: 'swarm', viewFloor: null, pathRatio: null, minAsns, swarmRatio });
    }
  }
  for (const viewFloor of HASH_VIEW_FLOORS) {
    for (const pathRatio of HASH_PATH_RATIOS) {
      for (const minAsns of HASH_MIN_ASNS) {
        for (const swarmRatio of RELAXED_SWARM_RATIOS) {
          cells.push({ variant: 'hash_and_swarm', viewFloor, pathRatio, minAsns, swarmRatio });
        }
      }
    }
  }
  return cells;
}

/** One hash's counts across all its networks, for one reported day. */
export interface HashWindow {
  userAgentHash: string;
  /** Arrivals up to the end of the reported day, over the 15-day span. */
  arrivals: number;
  distinctPaths: number;
  distinctAsns: number;
  activeDays: number;
  dayArrivals: number;
  dayDistinctPaths: number;
  dayDistinctAsns: number;
  dayDistinctCountries: number;
  /** Browser-verified `browser-spa` hops in the span or the 30-minute margin, on any network. */
  verifiedHops: number;
  dayReferred: number;
  dayTurnstilePass: number;
  dayTurnstileFail: number;
  dayTurnstileUnknown: number;
  /** NULL verdicts. Not evidence: capture started 2026-11-02 and skips some regions. */
  dayTurnstileNone: number;
}

/** The smallest floor any cell uses. Below it a hash cannot pass, so it is not read. */
const MIN_HASH_ARRIVALS = Math.min(...HASH_VIEW_FLOORS, ...HASH_MIN_ASNS);

/**
 * Per-hash counts over the reported day plus {@link CRAWL_SHAPE_LOOKBACK_DAYS}, in one
 * grouped statement. It mirrors `readCrawlShapeWindows`, with the network taken out
 * of the group. A hop on any network counts, including one with a NULL ASN, because
 * it is still evidence the app ran under this hash.
 */
export async function readHashWindows(db: Db, day: string): Promise<HashWindow[]> {
  const from = `${day}T00:00:00.000Z`;
  const startMs = Date.parse(from);
  const to = new Date(startMs + DAY_MS).toISOString();
  const spanFrom = new Date(startMs - CRAWL_SHAPE_LOOKBACK_DAYS * DAY_MS).toISOString();
  const marginTo = new Date(startMs + DAY_MS + SPA_FOLLOWUP_WINDOW_MINUTES * 60_000).toISOString();
  const arrival = sql`${pageViews.createdAt} < ${to}
    and ${pageViews.concretePath} is not null
    and ${pageViews.cfAsn} is not null
    and (${pageViews.navigation} = 'arrival' or ${pageViews.writerProvenance} = 'ssr-arrival')`;
  const dayArrival = sql`${pageViews.createdAt} >= ${from} and ${arrival}`;
  const dayVerdict = (verdict: string) =>
    sql<number>`sum(case when ${dayArrival} and ${pageViews.turnstileVerdict} = ${verdict} then 1 else 0 end)`;
  const groups = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      arrivals: sql<number>`sum(case when ${arrival} then 1 else 0 end)`,
      distinctPaths: sql<number>`count(distinct case when ${arrival} then ${pageViews.concretePath} end)`,
      distinctAsns: sql<number>`count(distinct case when ${arrival} then ${pageViews.cfAsn} end)`,
      activeDays: sql<number>`count(distinct case when ${arrival} then substr(${pageViews.createdAt}, 1, 10) end)`,
      dayArrivals: sql<number>`sum(case when ${dayArrival} then 1 else 0 end)`,
      dayDistinctPaths: sql<number>`count(distinct case when ${dayArrival} then ${pageViews.concretePath} end)`,
      dayDistinctAsns: sql<number>`count(distinct case when ${dayArrival} then ${pageViews.cfAsn} end)`,
      dayDistinctCountries: sql<number>`count(distinct case when ${dayArrival} then ${pageViews.cfCountry} end)`,
      verifiedHops: sql<number>`sum(case when ${pageViews.writerProvenance} = 'browser-spa' and ${pageViews.clientVerdict} = 'browser' then 1 else 0 end)`,
      dayReferred: sql<number>`sum(case when ${dayArrival} and ${pageViews.referrerSource} is not null and ${pageViews.referrerSource} <> 'Direct' then 1 else 0 end)`,
      dayTurnstilePass: dayVerdict('pass'),
      dayTurnstileFail: dayVerdict('fail'),
      dayTurnstileUnknown: dayVerdict('unknown'),
      dayTurnstileNone: sql<number>`sum(case when ${dayArrival} and ${pageViews.turnstileVerdict} is null then 1 else 0 end)`,
    })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, spanFrom),
        lt(pageViews.createdAt, marginTo),
        isNotNull(pageViews.userAgentHash),
      ),
    )
    .groupBy(pageViews.userAgentHash)
    .having(sql`sum(case when ${arrival} then 1 else 0 end) >= ${MIN_HASH_ARRIVALS}`);
  return groups.flatMap((g) =>
    g.userAgentHash === null ? [] : [{ ...g, userAgentHash: g.userAgentHash }],
  );
}

/**
 * Every day in `[fromIso, toIso)` a hash had a browser-verified hop. Shadow only: a
 * hop after a flagged day says the flag would have been wrong, and a rule never reads it.
 */
export async function readVerifiedHopDays(
  db: Db,
  fromIso: string,
  toIso: string,
): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      day: sql<string>`substr(${pageViews.createdAt}, 1, 10)`,
    })
    .from(pageViews)
    .where(
      and(
        gte(pageViews.createdAt, fromIso),
        lt(pageViews.createdAt, toIso),
        isNotNull(pageViews.userAgentHash),
        sql`${pageViews.writerProvenance} = 'browser-spa'`,
        sql`${pageViews.clientVerdict} = 'browser'`,
      ),
    )
    .groupBy(pageViews.userAgentHash, sql`substr(${pageViews.createdAt}, 1, 10)`);
  const out = new Map<string, string[]>();
  for (const r of rows) {
    if (r.userAgentHash === null) continue;
    out.set(r.userAgentHash, [...(out.get(r.userAgentHash) ?? []), r.day]);
  }
  return out;
}

function passesShape(
  arrivals: number,
  distinctPaths: number,
  distinctAsns: number,
  cell: { viewFloor: number; pathRatio: number; minAsns: number },
): boolean {
  return (
    arrivals >= cell.viewFloor &&
    distinctAsns >= cell.minAsns &&
    distinctPaths / arrivals >= cell.pathRatio
  );
}

/** The crawl test on the day or the 15-day span, before the hop veto. */
export function hashCrawlShapeBeforeVeto(
  w: HashWindow,
  cell: { viewFloor: number; pathRatio: number; minAsns: number },
): boolean {
  return (
    passesShape(w.dayArrivals, w.dayDistinctPaths, w.dayDistinctAsns, cell) ||
    passesShape(w.arrivals, w.distinctPaths, w.distinctAsns, cell)
  );
}

/** Crawl shape across all of a hash's networks. One verified hop stops it. */
export function hashCrawlShape(
  w: HashWindow,
  cell: { viewFloor: number; pathRatio: number; minAsns: number },
): boolean {
  return w.verifiedHops === 0 && hashCrawlShapeBeforeVeto(w, cell);
}

/** The lower swarm bar on the reported day, before the hop veto. No prior is needed. */
export function relaxedSwarmBeforeVeto(
  w: HashWindow,
  cell: { swarmRatio: number; minAsns: number },
): boolean {
  return (
    w.dayArrivals > 0 &&
    w.dayDistinctAsns >= cell.minAsns &&
    w.dayDistinctAsns / w.dayArrivals >= cell.swarmRatio
  );
}

/** The lower swarm bar. One verified hop stops it. */
export function relaxedSwarm(
  w: HashWindow,
  cell: { swarmRatio: number; minAsns: number },
): boolean {
  return w.verifiedHops === 0 && relaxedSwarmBeforeVeto(w, cell);
}

/** A family a candidate can add to a row: a classifier family, or the new distinct one. */
export type CandidateFamily = keyof typeof SIGNAL_FAMILIES | 'hash_crawl_shape';

const CODE_FAMILY: ReadonlyMap<ReasonCode, keyof typeof SIGNAL_FAMILIES> = new Map(
  (Object.keys(SIGNAL_FAMILIES) as (keyof typeof SIGNAL_FAMILIES)[]).flatMap((family) =>
    (SIGNAL_FAMILIES[family] as readonly ReasonCode[]).map((code) => [code, family] as const),
  ),
);

/** The automation families a classification's reason codes name. */
export function familiesOfCodes(codes: readonly ReasonCode[]): (keyof typeof SIGNAL_FAMILIES)[] {
  const out = new Set<keyof typeof SIGNAL_FAMILIES>();
  for (const code of codes) {
    const family = CODE_FAMILY.get(code);
    if (family) out.add(family);
  }
  return [...out];
}

/**
 * The class a row would read with `added` families on top of the classifier's result.
 * Identified stays identified. Two families reach Suspected. An added signal
 * contradicts human evidence, as any signal does in the classifier.
 */
export function candidateClass(
  baseClass: TrafficClass,
  baseFamilies: readonly CandidateFamily[],
  added: readonly CandidateFamily[],
): TrafficClass {
  if (baseClass === 'identified_automation' || added.length === 0) return baseClass;
  const families = new Set<CandidateFamily>([...baseFamilies, ...added]);
  if (families.size >= SUSPECTED_MIN_SIGNAL_FAMILIES) return 'suspected_automation';
  return baseClass === 'browser_with_human_evidence' ? 'unresolved' : baseClass;
}

/** The families a cell adds to one row. Crawl shape marks arrivals only; swarm, every row. */
export function candidateFamiliesFor(
  cell: CandidateCell,
  window: HashWindow | undefined,
  crawlEligible: boolean,
): CandidateFamily[] {
  if (!window) return [];
  const added: CandidateFamily[] = [];
  if (cell.viewFloor !== null && cell.pathRatio !== null && crawlEligible) {
    const shape = { viewFloor: cell.viewFloor, pathRatio: cell.pathRatio, minAsns: cell.minAsns };
    if (hashCrawlShape(window, shape)) {
      added.push(cell.variant === 'hash_distinct' ? 'hash_crawl_shape' : 'crawl_shape');
    }
  }
  if (
    cell.swarmRatio !== null &&
    relaxedSwarm(window, { swarmRatio: cell.swarmRatio, minAsns: cell.minAsns })
  ) {
    added.push('swarm');
  }
  return added;
}

type Partition = 'tuning' | 'held_out';
type ClassCounts = Record<TrafficClass, number>;

/** What the report knows about rows sharing a day, hash and classifier result. */
interface Bucket {
  day: string;
  userAgentHash: string;
  partition: Partition;
  slice: string;
  labelled: boolean;
  internal: boolean;
  baseClass: TrafficClass;
  families: (keyof typeof SIGNAL_FAMILIES)[];
  crawlEligible: boolean;
  rows: number;
  referred: number;
}

/** One cell's figures on one partition: the §3c numbers with the hash-level proxies beside them. */
export interface CandidateCellMetrics {
  /** Rows moved to automation. */
  movedViews: number;
  movedHashes: number;
  /** Moved rows by slice. `shared_proxy_candidate` is the office-network risk. */
  movedBySlice: Record<string, number>;
  /** False exclusions: moved rows in a labelled real-browser session. */
  labelledFalseExclusions: number;
  /** Moved rows `NOT_INTERNAL` excludes. The operator's own traffic must never move. */
  internalMoved: number;
  /** Moved rows that arrived from a search engine or another site. Anyone can fake it. */
  referredMoved: number;
  /** Moved rows whose hash shows a verified hop on a later day. Evidence of a false exclusion. */
  laterHopMoved: number;
  /** Unresolved ÷ non-internal rows after the candidate. */
  unresolvedShareAfter: number | null;
  /** Missed automation: the target's views, and how many read as automation after. */
  targetViews: number;
  targetAutomationAfter: number;
}

export interface CandidateCellResult extends CandidateCell {
  tuning: CandidateCellMetrics;
  heldOut: CandidateCellMetrics;
}

/** One hash moved by a {@link REVIEW_VARIANTS} widest cell, for a human read. */
export interface CandidateHashReview {
  partition: Partition;
  userAgentHash: string;
  daysFlagged: number;
  movedViews: number;
  maxDayArrivals: number;
  maxDayAsns: number;
  maxDayCountries: number;
  referredViews: number;
  turnstile: { pass: number; fail: number; unknown: number; none: number };
  laterHop: boolean;
}

/** A hash-day that passes a shape test and is saved only by a hop. */
export interface CandidateVetoDependent {
  partition: Partition;
  day: string;
  userAgentHash: string;
  verifiedHops: number;
  dayArrivals: number;
  dayDistinctAsns: number;
  arrivals: number;
  distinctAsns: number;
}

/** A hash flagged on a day with a verified hop on a later day. */
export interface CandidateLaterHop {
  partition: Partition;
  userAgentHash: string;
  flaggedDays: string[];
  laterHopDays: string[];
  movedViews: number;
}

/** One client's line under a day's digest candidate. */
export interface DigestHashLine {
  userAgentHash: string;
  views: number;
  distinctAsns: number;
  share: number;
  aboveLine: boolean;
}

export interface DigestCandidateDay {
  day: string;
  partition: Partition;
  classifiedNonInternal: number;
  lines: DigestHashLine[];
  /**
   * The largest pair's share: what today's list can see. A pair is a client as
   * `readTopUnresolvedClients` reads one, so a no-user-agent client on a network counts.
   */
  topPairShare: number | null;
  pairsAboveLine: number;
}

export interface TargetDayReach {
  variant: CandidateVariant;
  day: string;
  partition: Partition;
  classCounts: ClassCounts;
}

export interface CandidateReport {
  targetHashPrefix: string;
  /** The running classifier, before any candidate. */
  baseline: Record<Partition, { nonInternal: number; unresolved: number }>;
  cells: CandidateCellResult[];
  targetReach: TargetDayReach[];
  review: CandidateHashReview[];
  vetoDependent: CandidateVetoDependent[];
  laterHops: CandidateLaterHop[];
  digest: DigestCandidateDay[];
}

function zeroClassCounts(): ClassCounts {
  return Object.fromEntries(TRAFFIC_CLASSES.map((c) => [c, 0])) as ClassCounts;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

function isAutomation(cls: TrafficClass): boolean {
  return cls === 'identified_automation' || cls === 'suspected_automation';
}

function isTarget(hash: string): boolean {
  return hash.startsWith(CANDIDATE_TARGET_HASH_PREFIX);
}

/** The most permissive thresholds. A narrower cell of a variant flags a subset of its widest. */
const WIDEST = {
  viewFloor: Math.min(...HASH_VIEW_FLOORS),
  pathRatio: Math.min(...HASH_PATH_RATIOS),
  minAsns: Math.min(...HASH_MIN_ASNS),
  swarmRatio: Math.min(...RELAXED_SWARM_RATIOS),
};

/**
 * The variants whose widest cells together move every row any cell moves. `hash_and_swarm`
 * covers `hash_merged` and `swarm`. It does not cover `hash_distinct`, which moves a pair
 * crawl-shape row on the hash test alone, where `hash_and_swarm` merges the two and also
 * needs the swarm bar to reach a second family.
 */
const REVIEW_VARIANTS = ['hash_distinct', 'hash_and_swarm'] as const;

function widestCell(variant: CandidateVariant): CandidateCell {
  return {
    variant,
    viewFloor: variant === 'swarm' ? null : WIDEST.viewFloor,
    pathRatio: variant === 'swarm' ? null : WIDEST.pathRatio,
    minAsns: WIDEST.minAsns,
    swarmRatio: variant === 'hash_merged' || variant === 'hash_distinct' ? null : WIDEST.swarmRatio,
  };
}

/** Gathers one run's rows, then evaluates every cell over them in {@link finish}. */
export class CandidateCollector {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windows = new Map<string, Map<string, HashWindow>>();
  private readonly partitions = new Map<string, Partition>();
  private readonly baseline: CandidateReport['baseline'] = {
    tuning: { nonInternal: 0, unresolved: 0 },
    held_out: { nonInternal: 0, unresolved: 0 },
  };
  private readonly digestDays = new Map<
    string,
    {
      nonInternal: number;
      hashes: Map<string, { views: number; asns: Set<number> }>;
      pairs: Map<string, number>;
    }
  >();

  addDay(day: string, windows: readonly HashWindow[], heldOut: boolean): void {
    this.windows.set(day, new Map(windows.map((w) => [w.userAgentHash, w])));
    this.partitions.set(day, heldOut ? 'held_out' : 'tuning');
    this.digestDays.set(day, { nonInternal: 0, hashes: new Map(), pairs: new Map() });
  }

  addRow(args: {
    day: string;
    row: ClassifierRow;
    result: PageViewClassification;
    slice: string;
    labelled: boolean;
  }): void {
    const { day, row, result, slice, labelled } = args;
    const partition = this.partitions.get(day) ?? 'tuning';
    const digest = this.digestDays.get(day);
    if (!result.internal) {
      this.baseline[partition].nonInternal += 1;
      if (digest) digest.nonInternal += 1;
      if (result.class === 'unresolved') {
        this.baseline[partition].unresolved += 1;
        if (digest && row.userAgentHash !== null) {
          const line = digest.hashes.get(row.userAgentHash) ?? {
            views: 0,
            asns: new Set<number>(),
          };
          line.views += 1;
          if (row.cfAsn !== null) line.asns.add(row.cfAsn);
          digest.hashes.set(row.userAgentHash, line);
        }
        // The population `readTopUnresolvedClients` lists. A NULL hash never joins a hash
        // line, but it is one no-user-agent client per network on today's digest.
        if (
          digest &&
          (row.userAgentHash !== null || (row.cfAsn !== null && row.privacySignal !== true))
        ) {
          const pair = `${row.userAgentHash}|${row.cfAsn}`;
          digest.pairs.set(pair, (digest.pairs.get(pair) ?? 0) + 1);
        }
      }
    }
    // Identified rows cannot move. A NULL hash never groups: an unknown is not a match.
    if (row.userAgentHash === null || result.class === 'identified_automation') return;
    const families = familiesOfCodes(result.reasonCodes);
    const crawlEligible =
      row.concretePath !== null &&
      row.cfAsn !== null &&
      (row.navigation === 'arrival' || row.writerProvenance === 'ssr-arrival');
    const key = JSON.stringify([
      day,
      row.userAgentHash,
      slice,
      result.internal,
      result.class,
      families,
      crawlEligible,
    ]);
    const bucket = this.buckets.get(key) ?? {
      day,
      userAgentHash: row.userAgentHash,
      partition,
      slice,
      labelled,
      internal: result.internal,
      baseClass: result.class,
      families,
      crawlEligible,
      rows: 0,
      referred: 0,
    };
    bucket.rows += 1;
    if (referralCodes(row).length > 0) bucket.referred += 1;
    this.buckets.set(key, bucket);
  }

  private classOf(bucket: Bucket, cell: CandidateCell): TrafficClass {
    const window = this.windows.get(bucket.day)?.get(bucket.userAgentHash);
    return candidateClass(
      bucket.baseClass,
      bucket.families,
      candidateFamiliesFor(cell, window, bucket.crawlEligible),
    );
  }

  private metricsFor(
    cell: CandidateCell,
    partition: Partition,
    hopDays: ReadonlyMap<string, readonly string[]>,
  ): CandidateCellMetrics {
    const m: CandidateCellMetrics = {
      movedViews: 0,
      movedHashes: 0,
      movedBySlice: {},
      labelledFalseExclusions: 0,
      internalMoved: 0,
      referredMoved: 0,
      laterHopMoved: 0,
      unresolvedShareAfter: null,
      targetViews: 0,
      targetAutomationAfter: 0,
    };
    const hashes = new Set<string>();
    let unresolvedAfter = this.baseline[partition].unresolved;
    for (const b of this.buckets.values()) {
      if (b.partition !== partition) continue;
      const after = this.classOf(b, cell);
      if (isTarget(b.userAgentHash)) {
        m.targetViews += b.rows;
        if (isAutomation(after)) m.targetAutomationAfter += b.rows;
      }
      if (after === b.baseClass) continue;
      if (!b.internal) {
        if (b.baseClass === 'unresolved') unresolvedAfter -= b.rows;
        if (after === 'unresolved') unresolvedAfter += b.rows;
      }
      if (!isAutomation(after)) continue;
      m.movedViews += b.rows;
      hashes.add(b.userAgentHash);
      m.movedBySlice[b.slice] = (m.movedBySlice[b.slice] ?? 0) + b.rows;
      if (b.labelled) m.labelledFalseExclusions += b.rows;
      if (b.internal) m.internalMoved += b.rows;
      m.referredMoved += b.referred;
      if ((hopDays.get(b.userAgentHash) ?? []).some((d) => d > b.day)) m.laterHopMoved += b.rows;
    }
    m.movedHashes = hashes.size;
    m.unresolvedShareAfter = ratio(unresolvedAfter, this.baseline[partition].nonInternal);
    return m;
  }

  private targetReach(): TargetDayReach[] {
    const out = new Map<string, TargetDayReach>();
    for (const variant of CANDIDATE_VARIANTS) {
      const cell = widestCell(variant);
      for (const b of this.buckets.values()) {
        if (!isTarget(b.userAgentHash)) continue;
        const key = `${variant}|${b.day}`;
        const reach = out.get(key) ?? {
          variant,
          day: b.day,
          partition: b.partition,
          classCounts: zeroClassCounts(),
        };
        reach.classCounts[this.classOf(b, cell)] += b.rows;
        out.set(key, reach);
      }
    }
    return [...out.values()].sort(
      (a, b) =>
        CANDIDATE_VARIANTS.indexOf(a.variant) - CANDIDATE_VARIANTS.indexOf(b.variant) ||
        compareText(a.day, b.day),
    );
  }

  private reviewAndLaterHops(hopDays: ReadonlyMap<string, readonly string[]>): {
    review: CandidateHashReview[];
    laterHops: CandidateLaterHop[];
  } {
    const cells = REVIEW_VARIANTS.map(widestCell);
    const moved = new Map<string, Map<string, { views: number; referred: number }>>();
    for (const b of this.buckets.values()) {
      const movedByAnyCell = cells.some((cell) => {
        const after = this.classOf(b, cell);
        return after !== b.baseClass && isAutomation(after);
      });
      if (!movedByAnyCell) continue;
      const key = `${b.partition}|${b.userAgentHash}`;
      const days = moved.get(key) ?? new Map<string, { views: number; referred: number }>();
      const day = days.get(b.day) ?? { views: 0, referred: 0 };
      day.views += b.rows;
      day.referred += b.referred;
      days.set(b.day, day);
      moved.set(key, days);
    }
    const review: CandidateHashReview[] = [];
    const laterHops: CandidateLaterHop[] = [];
    for (const [key, days] of moved) {
      const [partition, userAgentHash] = key.split('|') as [Partition, string];
      const entry: CandidateHashReview = {
        partition,
        userAgentHash,
        daysFlagged: days.size,
        movedViews: 0,
        maxDayArrivals: 0,
        maxDayAsns: 0,
        maxDayCountries: 0,
        referredViews: 0,
        turnstile: { pass: 0, fail: 0, unknown: 0, none: 0 },
        laterHop: false,
      };
      for (const [day, counts] of days) {
        entry.movedViews += counts.views;
        entry.referredViews += counts.referred;
        const w = this.windows.get(day)?.get(userAgentHash);
        if (!w) continue;
        entry.maxDayArrivals = Math.max(entry.maxDayArrivals, w.dayArrivals);
        entry.maxDayAsns = Math.max(entry.maxDayAsns, w.dayDistinctAsns);
        entry.maxDayCountries = Math.max(entry.maxDayCountries, w.dayDistinctCountries);
        entry.turnstile.pass += w.dayTurnstilePass;
        entry.turnstile.fail += w.dayTurnstileFail;
        entry.turnstile.unknown += w.dayTurnstileUnknown;
        entry.turnstile.none += w.dayTurnstileNone;
      }
      const flaggedDays = [...days.keys()].sort(compareText);
      const firstFlagged = flaggedDays[0] ?? '';
      const later = [...(hopDays.get(userAgentHash) ?? [])]
        .filter((d) => d > firstFlagged)
        .sort(compareText);
      if (later.length > 0) {
        entry.laterHop = true;
        laterHops.push({
          partition,
          userAgentHash,
          flaggedDays,
          laterHopDays: later,
          movedViews: entry.movedViews,
        });
      }
      review.push(entry);
    }
    review.sort(
      (a, b) => a.movedViews - b.movedViews || compareText(a.userAgentHash, b.userAgentHash),
    );
    laterHops.sort(
      (a, b) => b.movedViews - a.movedViews || compareText(a.userAgentHash, b.userAgentHash),
    );
    return { review, laterHops };
  }

  private vetoDependent(): CandidateVetoDependent[] {
    const out: CandidateVetoDependent[] = [];
    for (const [day, windows] of this.windows) {
      for (const w of windows.values()) {
        if (w.verifiedHops === 0 || w.dayArrivals === 0) continue;
        const shape = hashCrawlShapeBeforeVeto(w, WIDEST) || relaxedSwarmBeforeVeto(w, WIDEST);
        if (!shape) continue;
        out.push({
          partition: this.partitions.get(day) ?? 'tuning',
          day,
          userAgentHash: w.userAgentHash,
          verifiedHops: w.verifiedHops,
          dayArrivals: w.dayArrivals,
          dayDistinctAsns: w.dayDistinctAsns,
          arrivals: w.arrivals,
          distinctAsns: w.distinctAsns,
        });
      }
    }
    return out.sort(
      (a, b) =>
        a.verifiedHops - b.verifiedHops ||
        b.dayArrivals - a.dayArrivals ||
        compareText(a.day, b.day) ||
        compareText(a.userAgentHash, b.userAgentHash),
    );
  }

  private digest(): DigestCandidateDay[] {
    return [...this.digestDays.entries()].map(([day, d]) => {
      const lines = [...d.hashes.entries()]
        .map(([userAgentHash, line]) => {
          const share = d.nonInternal > 0 ? line.views / d.nonInternal : 0;
          return {
            userAgentHash,
            views: line.views,
            distinctAsns: line.asns.size,
            share: ratio(line.views, d.nonInternal) ?? 0,
            aboveLine: share > UNRESOLVED_CLIENT_ALERT_SHARE,
          };
        })
        .sort((a, b) => b.views - a.views || compareText(a.userAgentHash, b.userAgentHash));
      const pairViews = [...d.pairs.values()];
      const topPair = pairViews.length > 0 ? Math.max(...pairViews) : 0;
      return {
        day,
        partition: this.partitions.get(day) ?? 'tuning',
        classifiedNonInternal: d.nonInternal,
        lines: lines.slice(0, TOP_UNRESOLVED_CLIENTS_LIMIT),
        topPairShare: ratio(topPair, d.nonInternal),
        pairsAboveLine:
          d.nonInternal === 0
            ? 0
            : pairViews.filter((v) => v / d.nonInternal > UNRESOLVED_CLIENT_ALERT_SHARE).length,
      };
    });
  }

  finish(hopDays: ReadonlyMap<string, readonly string[]>): CandidateReport {
    const { review, laterHops } = this.reviewAndLaterHops(hopDays);
    return {
      targetHashPrefix: CANDIDATE_TARGET_HASH_PREFIX,
      baseline: this.baseline,
      cells: candidateCells().map((cell) => ({
        ...cell,
        tuning: this.metricsFor(cell, 'tuning', hopDays),
        heldOut: this.metricsFor(cell, 'held_out', hopDays),
      })),
      targetReach: this.targetReach(),
      review,
      vetoDependent: this.vetoDependent(),
      laterHops,
      digest: this.digest(),
    };
  }
}

// ─── Report ─────────────────────────────────────────────────────────────────

function table(head: readonly string[], body: readonly (readonly (string | number)[])[]): string {
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const row of body) lines.push(`| ${row.join(' | ')} |`);
  return lines.join('\n');
}

function pct(v: number | null): string {
  return v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`;
}

function shortHash(hash: string): string {
  return `\`${hash.slice(0, 8)}\``;
}

function dash(v: number | null): string | number {
  return v === null ? '-' : v;
}

const CELL_HEAD = [
  'Variant',
  'View floor',
  'Path ratio',
  'Min ASNs',
  'Swarm ratio',
  'Moved views',
  'Moved hashes',
  'Labelled false exclusions',
  'Internal moved',
  'Referred moved',
  'Later-hop moved',
  'Target automation / views',
  'Unresolved share after',
] as const;

function cellRows(
  report: CandidateReport,
  pick: (c: CandidateCellResult) => CandidateCellMetrics,
): (string | number)[][] {
  return report.cells.map((c) => {
    const m = pick(c);
    return [
      c.variant,
      dash(c.viewFloor),
      dash(c.pathRatio),
      c.minAsns,
      dash(c.swarmRatio),
      m.movedViews,
      m.movedHashes,
      m.labelledFalseExclusions,
      m.internalMoved,
      m.referredMoved,
      m.laterHopMoved,
      `${m.targetAutomationAfter} / ${m.targetViews}`,
      pct(m.unresolvedShareAfter),
    ];
  });
}

function reviewTable(rows: readonly CandidateHashReview[]): string {
  return rows.length === 0
    ? 'None.'
    : table(
        [
          'UA hash',
          'Days flagged',
          'Moved views',
          'Max day arrivals',
          'Max day ASNs',
          'Max day countries',
          'Referred views',
          'Turnstile pass / fail / unknown / none',
          'Later hop',
        ],
        rows.map((r) => [
          shortHash(r.userAgentHash),
          r.daysFlagged,
          r.movedViews,
          r.maxDayArrivals,
          r.maxDayAsns,
          r.maxDayCountries,
          r.referredViews,
          `${r.turnstile.pass} / ${r.turnstile.fail} / ${r.turnstile.unknown} / ${r.turnstile.none}`,
          r.laterHop ? 'yes' : 'no',
        ]),
      );
}

function digestTable(days: readonly DigestCandidateDay[]): string {
  return days.length === 0
    ? 'None.'
    : table(
        [
          'Day',
          'Classified non-internal',
          'Top pair share',
          'Pairs above line',
          'Top hash',
          'Views',
          'ASNs',
          'Share',
          'Hashes above line',
        ],
        days.map((d) => {
          const top = d.lines[0];
          return [
            d.day,
            d.classifiedNonInternal,
            pct(d.topPairShare),
            d.pairsAboveLine,
            top ? shortHash(top.userAgentHash) : '-',
            top?.views ?? 0,
            top?.distinctAsns ?? 0,
            pct(top?.share ?? null),
            d.lines.filter((l) => l.aboveLine).length,
          ];
        }),
      );
}

/**
 * The candidate sections. Held-out figures sit in their own last section, so a cell
 * can be chosen on the tuning days before they are read (§3c).
 */
export function renderCandidateMarkdown(report: CandidateReport): string[] {
  const out: string[] = [];
  const tuningReview = report.review.filter((r) => r.partition === 'tuning');
  const tuningVeto = report.vetoDependent.filter((r) => r.partition === 'tuning');
  const tuningLater = report.laterHops.filter((r) => r.partition === 'tuning');

  out.push('', '## Hash-level candidates: comparison, tuning days only (AECI-1584)', '');
  out.push(
    `Report-only. No rule changed. The running classifier leaves ${report.baseline.tuning.unresolved} of ${report.baseline.tuning.nonInternal} non-internal tuning rows Unresolved (${pct(ratio(report.baseline.tuning.unresolved, report.baseline.tuning.nonInternal))}). The target is \`${report.targetHashPrefix}\`. Labelled false exclusions are close to automatic here, because the labelled sessions carry hops. Read the referred, later-hop and review figures beside them.`,
    '',
  );
  out.push(
    table(
      CELL_HEAD,
      cellRows(report, (c) => c.tuning),
    ),
  );

  out.push('', `## \`${report.targetHashPrefix}\` reach per day, widest cell of each variant`, '');
  const tuningReach = report.targetReach.filter((r) => r.partition === 'tuning');
  out.push(
    tuningReach.length === 0
      ? 'The target has no rows on the tuning days.'
      : table(
          ['Variant', 'Day', ...TRAFFIC_CLASSES],
          tuningReach.map((r) => [
            r.variant,
            r.day,
            ...TRAFFIC_CLASSES.map((c) => r.classCounts[c]),
          ]),
        ),
  );

  out.push(
    '',
    `## Hash-level false-exclusion review, widest \`hash_distinct\` and \`hash_and_swarm\` cells (lowest 50 of ${tuningReview.length})`,
    '',
  );
  out.push(
    'Every hash any cell moved to automation, lowest volume first. A popular browser build shares one hash across many real people, so this needs a human read. A NULL Turnstile verdict is not evidence: capture started 2026-11-02 and skips some regions.',
    '',
  );
  out.push(reviewTable(tuningReview.slice(0, 50)));

  out.push(
    '',
    `## Hop-dependent hashes: pass a shape test, saved only by a hop (top 50 of ${tuningVeto.length})`,
    '',
  );
  out.push(
    'These hash-days pass a widest-threshold shape test and carry at least one verified hop. They are real-browser hashes one quiet fortnight away from a false exclusion. Fewest hops first.',
    '',
  );
  out.push(
    tuningVeto.length === 0
      ? 'None.'
      : table(
          [
            'Day',
            'UA hash',
            'Verified hops',
            'Day arrivals',
            'Day ASNs',
            'Span arrivals',
            'Span ASNs',
          ],
          tuningVeto
            .slice(0, 50)
            .map((v) => [
              v.day,
              shortHash(v.userAgentHash),
              v.verifiedHops,
              v.dayArrivals,
              v.dayDistinctAsns,
              v.arrivals,
              v.distinctAsns,
            ]),
        ),
  );

  out.push(
    '',
    `## Later hops: flagged hashes that ran our app afterwards (${tuningLater.length})`,
    '',
  );
  out.push(
    'A flagged hash with a verified hop after its first flagged day. A rule could not read this, because a day is never judged on later rows. Each row is evidence of a false exclusion, or of a person sharing the hash.',
    '',
  );
  out.push(
    tuningLater.length === 0
      ? 'None.'
      : table(
          ['UA hash', 'Moved views', 'Flagged days', 'Later hop days'],
          tuningLater
            .slice(0, 50)
            .map((l) => [
              shortHash(l.userAgentHash),
              l.movedViews,
              l.flaggedDays.length,
              l.laterHopDays.length,
            ]),
        ),
  );

  out.push('', '## Digest candidate: the day’s largest Unresolved hash', '');
  out.push(
    'Report-only and needs no version bump. "Pairs above line" is what the digest can see today. "Hashes above line" is what a hash-level line would add.',
    '',
  );
  out.push(digestTable(report.digest.filter((d) => d.partition === 'tuning')));

  const heldOutReview = report.review.filter((r) => r.partition === 'held_out');
  out.push('', '## Held-out days: read only after choosing a cell', '');
  out.push(
    `The running classifier leaves ${report.baseline.held_out.unresolved} of ${report.baseline.held_out.nonInternal} non-internal held-out rows Unresolved (${pct(ratio(report.baseline.held_out.unresolved, report.baseline.held_out.nonInternal))}).`,
    '',
  );
  out.push(
    table(
      CELL_HEAD,
      cellRows(report, (c) => c.heldOut),
    ),
  );
  out.push('', `Held-out review, widest cells (lowest 50 of ${heldOutReview.length}):`, '');
  out.push(reviewTable(heldOutReview.slice(0, 50)));
  out.push('', 'Held-out digest candidate:', '');
  out.push(digestTable(report.digest.filter((d) => d.partition === 'held_out')));
  return out;
}
