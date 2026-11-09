/**
 * Coordinated browser identities: a group-level candidate signal, measured in
 * shadow only (AECI-1659, `POST_LAUNCH_MONITORING.md` §3c).
 *
 * One crawler rotates its browser string over eight to ten identities and a proxy
 * pool, with AS214483 as its main network. Each identity passes every per-hash and
 * per-pair rule, so on 2026-10-24 its 2,355 views (27.8%) were all `unresolved`.
 * This module asks a question no single hash can answer: do several identities that
 * share a main network behave as one program?
 *
 *  1. Each identity's main network is its busiest non-NULL `cf_asn`, ties to the
 *     lower ASN. The daily email's network groups use the same rule (AECI-1647),
 *     through {@link mainNetworkByIdentity}, so the two cannot disagree.
 *  2. Identities sharing a main network form a group of at least
 *     {@link COORDINATED_MIN_IDENTITIES}.
 *  3. A group is coordinated when {@link COORDINATED_MIN_EVIDENCE} of three tests
 *     pass: a synchronised start, a partitioned crawl, and a large share of the day.
 *  4. Every row of a member identity on that day, on any network, is a member row.
 *
 * **Nothing here is a rule yet.** `traffic-classifier.ts` does not import this
 * file, and no constant here is a classifier input, so the version and fingerprint
 * stay put. The shadow runner overlays the result (`traffic-shadow-coordinated.ts`)
 * so Chris can rule. Every constant is a starting value, not a ruling.
 *
 * Pure: no bindings, queries or clock. A NULL hash or a NULL ASN never groups, so a
 * privacy-signal row, which stores neither (AECI-1386), can never join a group.
 */

import { compareText } from '@aeci/shared/text-sort';

import type { ClassifierRow } from './traffic-classifier';

/** The fewest identities that make a group. Matches `NETWORK_GROUP_MIN_IDENTITIES`. */
export const COORDINATED_MIN_IDENTITIES = 3;

/** The synchronised-start window. Two first views exactly this far apart are not in one window. */
export const COORDINATED_START_WINDOW_SECONDS = 60;

/** "Most members": the share of members whose first view falls in one start window. */
export const COORDINATED_START_MIN_MEMBER_SHARE = 0.5;

/** The most `concrete_path` values any two members may share for a partitioned crawl. */
export const COORDINATED_MAX_PAIR_OVERLAP = 2;

/** The group's distinct paths ÷ its views with a path, at or above which it crawls. */
export const COORDINATED_MIN_DISTINCT_PATH_RATIO = 0.8;

/** The group's share of the day's non-internal views, strictly above which it counts. */
export const COORDINATED_GROUP_SHARE = 0.05;

/** How many of the three tests a group must pass. */
export const COORDINATED_MIN_EVIDENCE = 2;

/** Every shadow-only constant, for the report header. */
export const COORDINATED_CONSTANTS = {
  COORDINATED_MIN_IDENTITIES,
  COORDINATED_START_WINDOW_SECONDS,
  COORDINATED_START_MIN_MEMBER_SHARE,
  COORDINATED_MAX_PAIR_OVERLAP,
  COORDINATED_MIN_DISTINCT_PATH_RATIO,
  COORDINATED_GROUP_SHARE,
  COORDINATED_MIN_EVIDENCE,
} as const;

/** One identity's view count on one network. */
export interface IdentityNetworkViews {
  userAgentHash: string | null;
  cfAsn: number | null;
  views: number;
}

/** An identity's busiest network and its views across every network. */
export interface MainNetwork<T extends IdentityNetworkViews> {
  /** Views on every network, NULL included. */
  total: number;
  /** The busiest non-NULL network's count, or null when the identity had none. */
  main: (T & { cfAsn: number }) | null;
}

/**
 * Each identity's main network: its busiest non-NULL `cf_asn`, ties to the lower
 * ASN. It need not carry a majority. An identity seen only with no network has no
 * main network. A NULL hash is dropped. `rows` holds one count per pair.
 */
export function mainNetworkByIdentity<T extends IdentityNetworkViews>(
  rows: readonly T[],
): Map<string, MainNetwork<T>> {
  const out = new Map<string, MainNetwork<T>>();
  for (const r of rows) {
    if (r.userAgentHash === null) continue;
    const entry = out.get(r.userAgentHash) ?? { total: 0, main: null };
    entry.total += r.views;
    const { cfAsn } = r;
    if (
      cfAsn !== null &&
      (entry.main === null ||
        r.views > entry.main.views ||
        (r.views === entry.main.views && cfAsn < entry.main.cfAsn))
    ) {
      entry.main = { ...r, cfAsn };
    }
    out.set(r.userAgentHash, entry);
  }
  return out;
}

/** The fields {@link findCoordinatedGroups} needs from a row. */
export type CoordinatedRow = Pick<
  ClassifierRow,
  'id' | 'createdAt' | 'concretePath' | 'cfAsn' | 'userAgentHash'
>;

/** One group of identities sharing a main network, with every measure the tests read. */
export interface CoordinatedGroup {
  cfAsn: number;
  /** Member hashes, sorted. */
  userAgentHashes: string[];
  identities: number;
  /** Member rows on every network, internal included. */
  views: number;
  /** Member rows on the main network itself. */
  mainNetworkViews: number;
  /** Member rows that are not internal: the share test's numerator. */
  nonInternalViews: number;
  /** The most member first-views of the day inside one start window. */
  startAligned: number;
  /** `startAligned ÷ identities`. */
  startShare: number;
  /** The most `concrete_path` values any two members share. */
  maxPairOverlap: number;
  /** Distinct paths across the group ÷ member rows with a path. Null with no path. */
  distinctPathRatio: number | null;
  /** `nonInternalViews ÷` the day's non-internal views. Null on an empty day. */
  share: number | null;
  passes: { start: boolean; partition: boolean; share: boolean };
  coordinated: boolean;
}

export interface CoordinatedDay {
  /** Every group of {@link COORDINATED_MIN_IDENTITIES} or more, coordinated or not. */
  groups: CoordinatedGroup[];
  /** Every row of a coordinated group's members, on any network. */
  memberRowIds: Set<number>;
}

/** The most sorted instants inside one sliding window of `windowMs`. */
function maxInWindow(sorted: readonly number[], windowMs: number): number {
  let best = 0;
  let start = 0;
  for (let end = 0; end < sorted.length; end += 1) {
    while ((sorted[end] ?? 0) - (sorted[start] ?? 0) >= windowMs) start += 1;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/** The most paths any two of `pathSets` share. Counted per path, so cheap when sets are disjoint. */
function maxPairOverlap(pathSets: readonly ReadonlySet<string>[]): number {
  const holders = new Map<string, number[]>();
  pathSets.forEach((set, i) => {
    for (const path of set) {
      const list = holders.get(path) ?? [];
      list.push(i);
      holders.set(path, list);
    }
  });
  const pairs = new Map<number, number>();
  let best = 0;
  const n = pathSets.length;
  for (const list of holders.values()) {
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) {
        const key = (list[a] ?? 0) * n + (list[b] ?? 0);
        const next = (pairs.get(key) ?? 0) + 1;
        pairs.set(key, next);
        if (next > best) best = next;
      }
    }
  }
  return best;
}

/**
 * The day's groups of identities sharing a main network, and the rows of the ones
 * that coordinate. `rows` is every row of one UTC day, internal included, as
 * `buildClassificationDay` loads them. `isInternal` says which rows `NOT_INTERNAL`
 * excludes, for the share test only.
 *
 * Only the reported day is read. A day is never judged on later rows.
 */
export function findCoordinatedGroups(
  rows: readonly CoordinatedRow[],
  isInternal: (row: CoordinatedRow) => boolean,
): CoordinatedDay {
  const pairCounts = new Map<string, IdentityNetworkViews>();
  const byHash = new Map<string, CoordinatedRow[]>();
  let dayNonInternal = 0;
  for (const r of rows) {
    if (!isInternal(r)) dayNonInternal += 1;
    if (r.userAgentHash === null) continue;
    const list = byHash.get(r.userAgentHash) ?? [];
    list.push(r);
    byHash.set(r.userAgentHash, list);
    const key = JSON.stringify([r.userAgentHash, r.cfAsn]);
    const pair = pairCounts.get(key) ?? {
      userAgentHash: r.userAgentHash,
      cfAsn: r.cfAsn,
      views: 0,
    };
    pair.views += 1;
    pairCounts.set(key, pair);
  }

  const members = new Map<number, { hash: string; mainViews: number }[]>();
  for (const [hash, { main }] of mainNetworkByIdentity([...pairCounts.values()])) {
    if (main === null) continue;
    const list = members.get(main.cfAsn) ?? [];
    list.push({ hash, mainViews: main.views });
    members.set(main.cfAsn, list);
  }

  const groups: CoordinatedGroup[] = [];
  const memberRowIds = new Set<number>();
  for (const [cfAsn, list] of members) {
    if (list.length < COORDINATED_MIN_IDENTITIES) continue;
    const hashes = list.map((m) => m.hash).sort(compareText);
    const firsts: number[] = [];
    const pathSets: Set<string>[] = [];
    let views = 0;
    let nonInternalViews = 0;
    let pathViews = 0;
    const groupPaths = new Set<string>();
    for (const hash of hashes) {
      const own = byHash.get(hash) ?? [];
      views += own.length;
      let first = Number.POSITIVE_INFINITY;
      const paths = new Set<string>();
      for (const r of own) {
        if (!isInternal(r)) nonInternalViews += 1;
        first = Math.min(first, Date.parse(r.createdAt));
        if (r.concretePath !== null) {
          pathViews += 1;
          paths.add(r.concretePath);
          groupPaths.add(r.concretePath);
        }
      }
      firsts.push(first);
      pathSets.push(paths);
    }
    firsts.sort((a, b) => a - b);
    const startAligned = maxInWindow(firsts, COORDINATED_START_WINDOW_SECONDS * 1000);
    const startShare = startAligned / hashes.length;
    const overlap = maxPairOverlap(pathSets);
    const distinctPathRatio = pathViews === 0 ? null : groupPaths.size / pathViews;
    const share = dayNonInternal === 0 ? null : nonInternalViews / dayNonInternal;
    const passes = {
      start: startShare >= COORDINATED_START_MIN_MEMBER_SHARE,
      partition:
        distinctPathRatio !== null &&
        overlap <= COORDINATED_MAX_PAIR_OVERLAP &&
        distinctPathRatio >= COORDINATED_MIN_DISTINCT_PATH_RATIO,
      share: share !== null && share > COORDINATED_GROUP_SHARE,
    };
    const coordinated = Object.values(passes).filter(Boolean).length >= COORDINATED_MIN_EVIDENCE;
    if (coordinated) {
      for (const hash of hashes) for (const r of byHash.get(hash) ?? []) memberRowIds.add(r.id);
    }
    groups.push({
      cfAsn,
      userAgentHashes: hashes,
      identities: hashes.length,
      views,
      mainNetworkViews: list.reduce((sum, m) => sum + m.mainViews, 0),
      nonInternalViews,
      startAligned,
      startShare,
      maxPairOverlap: overlap,
      distinctPathRatio,
      share,
      passes,
      coordinated,
    });
  }
  groups.sort((a, b) => b.views - a.views || a.cfAsn - b.cfAsn);
  return { groups, memberRowIds };
}
