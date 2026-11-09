/**
 * The admin read side of `page_view_classifications` (AECI-1345, D19 Phase 2;
 * `API_CONTRACTS.md` §6.10, `DATABASE_SCHEMA.md` §9.7).
 *
 * Three reads, all read-only and all log-class (no `audit_log` row, ADR 0022):
 *
 *  - {@link readClassificationSummary} for `GET /api/admin/overview` and the
 *    05:00 digest: the four class counts for a window, with internal traffic
 *    split off beside them.
 *  - {@link readClassificationSeries} (AECI-1346, D19 Phase 3) for the overview's
 *    30-day class chart, its per-class day deltas and the digest's prior day:
 *    views per class per day, each day on its own latest version.
 *  - {@link readRowClassifications} for `GET /api/admin/page-views`: the latest
 *    stored classification of each row on the page.
 *  - {@link automationClassFilterForDay} (AECI-1460) for the top products and
 *    top sources tables in the digest and on `/admin/overview`: a predicate that
 *    drops views classed as automation on the day's latest version.
 *  - {@link readTopUnresolvedClients} (AECI-1579) for the digest's list of the
 *    day's largest Unresolved clients. It reports only.
 *  - {@link readTopUnresolvedIdentities} (AECI-1644) for the digest's list of the
 *    day's largest Unresolved browser identities, summed across every network.
 *    It reports only.
 *  - {@link readTopUnresolvedNetworkGroups} (AECI-1647) for the digest's list of
 *    browser identities that share one main network, the shape of one program
 *    rotating its browser string. It reports only.
 *
 * **Internal traffic is decided here, at read time.** The writer stores every row
 * of the day, internal ones included, and stores no internal flag: a later
 * operator anchor can turn a row internal after its append-only row is written,
 * and a stored flag would drift. So the summary applies `NOT_INTERNAL` in the
 * same query that counts the classes.
 *
 * **Versions are flagged, never blended (D19(c)).** Each day is counted on its own
 * latest version. "Latest" is the version whose rows were evaluated last, never a
 * string comparison: the version is opaque to SQL (§9.7).
 *
 * This module builds no `AdminNote`. The route turns the facts it returns into
 * notes, so this file and `admin-analytics.ts` do not import each other.
 */

import {
  ADMIN_PAGE_VIEW_NULL_FILTER,
  type AdminClassificationSummary,
  type AdminPageViewClassification,
  type AdminTrafficClass,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gte,
  lte,
  max,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViewClassifications, pageViews } from '../db/schema';
import { mainNetworkByIdentity } from './coordinated-identities';
import { NOT_INTERNAL } from './page-view-predicates';
import { TRAFFIC_CLASSES } from './traffic-classifier';

/**
 * The share of classified, non-internal views above which the overview warns
 * (`classification_unresolved_share`). Ruled 2026-10-21 (AECI-1345). Strictly
 * greater than: exactly half does not warn. `BOT_TRAFFIC_CLASSIFICATION.md` §2.15.
 */
export const CLASSIFICATION_UNRESOLVED_SHARE_MAX = 0.5;

/** How many Unresolved clients the digest lists (AECI-1579). */
export const TOP_UNRESOLVED_CLIENTS_LIMIT = 10;

/** How many Unresolved browser identities the digest lists across networks (AECI-1644). */
export const TOP_UNRESOLVED_IDENTITIES_LIMIT = 5;

/** How many main-network groups of Unresolved browser identities the digest lists (AECI-1647). */
export const TOP_UNRESOLVED_NETWORK_GROUPS_LIMIT = 3;

/**
 * The fewest browser identities that make a main-network group (AECI-1647, ruled
 * 2026-11-09). Two would let one large identity and one stray single view form a
 * "group" that only repeats the identity list's alert, as on 2026-11-02.
 */
export const NETWORK_GROUP_MIN_IDENTITIES = 3;

/**
 * The share of the day's classified, non-internal views above which one Unresolved
 * client alerts in the digest (AECI-1579). A starting value, ruled 2026-11-02.
 * Strictly greater than: exactly 5% does not alert. `BOT_TRAFFIC_CLASSIFICATION.md` §2.15.
 */
export const UNRESOLVED_CLIENT_ALERT_SHARE = 0.05;

const DAY_MS = 86_400_000;

/** The facts behind the overview's classification block and its gated notes. */
export interface ClassificationSummaryRead {
  summary: AdminClassificationSummary;
  /** Unresolved views among the classified, non-internal ones. */
  unresolved: number;
  /** All classified, non-internal views. */
  classified: number;
  /** True when `unresolved / classified` exceeds {@link CLASSIFICATION_UNRESOLVED_SHARE_MAX}. */
  unresolvedShareExceeded: boolean;
}

/** The version order across a window: each version and when it was last evaluated. */
type VersionOrder = { version: string; at: string }[];

/** The latest version per day, and the version order across the window. */
async function latestVersionPerDay(
  db: Db,
  fromDay: string,
  toDay: string,
): Promise<{ perDay: Map<string, string>; ordered: VersionOrder }> {
  const rows = await db
    .select({
      day: pageViewClassifications.viewDay,
      version: pageViewClassifications.classifierVersion,
      at: max(pageViewClassifications.evaluatedAt),
    })
    .from(pageViewClassifications)
    .where(
      and(
        gte(pageViewClassifications.viewDay, fromDay),
        lte(pageViewClassifications.viewDay, toDay),
      ),
    )
    .groupBy(pageViewClassifications.viewDay, pageViewClassifications.classifierVersion);

  const perDay = new Map<string, { version: string; at: string }>();
  const lastEvaluated = new Map<string, string>();
  for (const r of rows) {
    const at = r.at ?? '';
    const current = perDay.get(r.day);
    if (!current || at > current.at || (at === current.at && r.version > current.version)) {
      perDay.set(r.day, { version: r.version, at });
    }
    const seen = lastEvaluated.get(r.version);
    if (seen === undefined || at > seen) lastEvaluated.set(r.version, at);
  }
  const ordered = [...lastEvaluated.entries()]
    .map(([version, at]) => ({ version, at }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.version < b.version ? -1 : 1));
  return {
    perDay: new Map([...perDay.entries()].map(([day, v]) => [day, v.version])),
    ordered,
  };
}

/**
 * The classification block for `[fromDay, toDay]` (inclusive UTC days).
 *
 * `operatorLeakViews` is the collector's D15(b) figure, passed through so
 * `internal_excluded.operator_leak_inferred` and the email's internal line are
 * one number.
 */
export async function readClassificationSummary(
  db: Db,
  window: { fromDay: string; toDay: string },
  operatorLeakViews: number,
): Promise<ClassificationSummaryRead> {
  const { perDay, ordered } = await latestVersionPerDay(db, window.fromDay, window.toDay);

  const views = new Map<AdminTrafficClass, number>(TRAFFIC_CLASSES.map((c) => [c, 0]));
  const visitors = new Map<AdminTrafficClass, number>(TRAFFIC_CLASSES.map((c) => [c, 0]));
  let internalViews = 0;

  if (perDay.size > 0) {
    const pairs = [...perDay.entries()].map(([day, version]) =>
      and(
        eq(pageViewClassifications.viewDay, day),
        eq(pageViewClassifications.classifierVersion, version),
      ),
    );
    const internal = sql<number>`case when ${NOT_INTERNAL} then 0 else 1 end`;
    const rows = await db
      .select({
        internal,
        class: pageViewClassifications.class,
        views: sql<number>`count(*)`,
        // §9.8's visitor, the same expression `countDistinctVisitors` uses.
        visitors: sql<number>`count(distinct coalesce(${pageViews.userAgentHash}, '') || '|' || coalesce(${pageViews.cfAsn}, ''))`,
      })
      .from(pageViewClassifications)
      .innerJoin(pageViews, eq(pageViews.id, pageViewClassifications.pageViewId))
      .where(or(...pairs))
      .groupBy(internal, pageViewClassifications.class);

    for (const r of rows) {
      const n = Number(r.views);
      if (Number(r.internal) === 1) {
        internalViews += n;
        continue;
      }
      const cls = r.class as AdminTrafficClass;
      if (!views.has(cls)) continue; // an unknown class from a future version is not counted
      views.set(cls, (views.get(cls) ?? 0) + n);
      visitors.set(cls, (visitors.get(cls) ?? 0) + Number(r.visitors));
    }
  }

  const latest = ordered.at(-1)?.version ?? null;
  const classified = [...views.values()].reduce((a, b) => a + b, 0);
  const unresolved = views.get('unresolved') ?? 0;

  return {
    summary: {
      classifier_version: latest,
      counts: TRAFFIC_CLASSES.map((cls) => ({
        class: cls,
        views: views.get(cls) ?? 0,
        visitors: visitors.get(cls) ?? 0,
        // The caller owns the comparison: it needs the prior day, which this
        // window does not read. Null here is "not computed", never a zero change.
        delta_day: null,
      })),
      internal_excluded: { views: internalViews, operator_leak_inferred: operatorLeakViews },
      basis: 'requests',
      version_seam: versionSeamFor(perDay, ordered),
      // §3d rows depend on the tier, which this module does not read. The route fills it.
      method_seams: [],
    },
    unresolved,
    classified,
    unresolvedShareExceeded:
      classified > 0 && unresolved / classified > CLASSIFICATION_UNRESOLVED_SHARE_MAX,
  };
}

/**
 * The D19(c) seam over a window, from each day's latest version and the version
 * order. Non-null when the days counted carry more than one version.
 *
 * One rule for the summary and the series, so the panel's note and its chart
 * boundary cannot disagree. `changed_on` is the first day counted on the latest
 * version. `from_version` is the most recently evaluated other version that a
 * day in the window is counted on.
 */
export function versionSeamFor(
  perDay: ReadonlyMap<string, string>,
  ordered: VersionOrder,
): AdminClassificationSummary['version_seam'] {
  const latest = ordered.at(-1)?.version ?? null;
  const dayVersions = [...perDay.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const distinct = new Set(dayVersions.map(([, v]) => v));
  if (latest === null || distinct.size < 2) return null;
  const changedOn = dayVersions.find(([, v]) => v === latest)?.[0];
  const previous = [...ordered]
    .reverse()
    .find((o) => o.version !== latest && distinct.has(o.version))?.version;
  if (!changedOn || !previous) return null;
  return { from_version: previous, to_version: latest, changed_on: changedOn };
}

/** One classified day: non-internal views per class, on that day's latest version. */
export interface ClassificationDay {
  version: string;
  views: Record<AdminTrafficClass, number>;
}

/** The facts behind the 30-day class chart and the per-class day deltas. */
export interface ClassificationSeriesRead {
  /** Classified days only. A day absent from the map was NOT classified, which is
   *  different from four zeros and must never be drawn as them. */
  perDay: Map<string, ClassificationDay>;
  /** The D19(c) seam across the whole window, from {@link versionSeamFor}. */
  versionSeam: AdminClassificationSummary['version_seam'];
}

/**
 * Non-internal views per class per day for `[fromDay, toDay]` (AECI-1346).
 *
 * Reuses {@link latestVersionPerDay}, then runs ONE grouped query by
 * `(view_day, internal, class)` over the `(day, latest version)` pairs, which
 * `page_view_classifications_day_idx` covers. Internal rows are decided by
 * `NOT_INTERNAL` at read time and dropped, as in the summary.
 *
 * Views only. The §9.8 visitor pair is not summable across days, and the chart
 * and the deltas read views.
 */
export async function readClassificationSeries(
  db: Db,
  window: { fromDay: string; toDay: string },
): Promise<ClassificationSeriesRead> {
  const { perDay: versions, ordered } = await latestVersionPerDay(db, window.fromDay, window.toDay);
  const perDay = new Map<string, ClassificationDay>();
  for (const [day, version] of versions) {
    perDay.set(day, {
      version,
      views: Object.fromEntries(TRAFFIC_CLASSES.map((c) => [c, 0])) as Record<
        AdminTrafficClass,
        number
      >,
    });
  }

  if (versions.size > 0) {
    const pairs = [...versions.entries()].map(([day, version]) =>
      and(
        eq(pageViewClassifications.viewDay, day),
        eq(pageViewClassifications.classifierVersion, version),
      ),
    );
    const internal = sql<number>`case when ${NOT_INTERNAL} then 0 else 1 end`;
    const rows = await db
      .select({
        day: pageViewClassifications.viewDay,
        internal,
        class: pageViewClassifications.class,
        views: sql<number>`count(*)`,
      })
      .from(pageViewClassifications)
      .innerJoin(pageViews, eq(pageViews.id, pageViewClassifications.pageViewId))
      .where(or(...pairs))
      .groupBy(pageViewClassifications.viewDay, internal, pageViewClassifications.class);

    for (const r of rows) {
      if (Number(r.internal) === 1) continue;
      const day = perDay.get(r.day);
      // An unknown class from a future version is not counted, as in the summary.
      if (!day || !(TRAFFIC_CLASSES as readonly string[]).includes(r.class)) continue;
      day.views[r.class as AdminTrafficClass] += Number(r.views);
    }
  }

  return { perDay, versionSeam: versionSeamFor(versions, ordered) };
}

/** The two classes the top products and top sources tables drop (AECI-1460). */
export const AUTOMATION_CLASSES = [
  'identified_automation',
  'suspected_automation',
] as const satisfies readonly AdminTrafficClass[];

/** The tables' class filter for one UTC day, or why there is none. */
export interface AutomationClassFilter {
  /** ANDed into the tables' `WHERE`. Undefined when the day is unclassified. */
  predicate: SQL | undefined;
  /** The day's latest classifier version, or null when the day has no rows. */
  version: string | null;
  /** True when no filter applies, so the tables are unfiltered and say so. */
  unclassified: boolean;
}

/**
 * The predicate the digest's and the overview's top products and top sources
 * tables use since AECI-1460, which retired `AutomationExclusion`.
 *
 * It drops a view classed `identified_automation` or `suspected_automation` on
 * `day`'s latest classifier version, the same version the class section counts
 * that day on. Every other view stays, including `unresolved` ones and views the
 * classifier has not reached yet.
 *
 * **`NOT EXISTS` is load-bearing.** A view with no classification row makes the
 * subquery empty, so `NOT EXISTS` is TRUE and the row is kept. A join or a
 * `class NOT IN (...)` test would be NULL for that row, and a NULL `WHERE` drops
 * it. Same three-valued-logic trap `OPERATOR_PAIR_MATCH` documents.
 *
 * The subquery correlates on the unaliased `page_views` table, so a caller that
 * aliases `pageViews` breaks it. `productAttributedViews` does not.
 *
 * A day with no classification rows gets no predicate and `unclassified: true`.
 * The tables then print unfiltered with a note. Three bound parameters, and no
 * compound `SELECT`, so D1's limits are not in play.
 */
export async function automationClassFilterForDay(
  db: Db,
  day: string,
): Promise<AutomationClassFilter> {
  const { perDay } = await latestVersionPerDay(db, day, day);
  const version = perDay.get(day) ?? null;
  if (version === null) return { predicate: undefined, version: null, unclassified: true };
  const [a, b] = AUTOMATION_CLASSES;
  return {
    predicate: sql`not exists (
      select 1 from ${pageViewClassifications} as pvc
       where pvc.page_view_id = ${pageViews.id}
         and pvc.classifier_version = ${version}
         and pvc.class in (${a}, ${b})
    )`,
    version,
    unclassified: false,
  };
}

/** One Unresolved client of a day: a §9.8 `(user_agent_hash, cf_asn)` pair. */
export interface TopUnresolvedClient {
  /** Null when the client sent no User-Agent header. One such client per network. */
  userAgentHash: string | null;
  /** Null when the row carried no network, which is itself evidence (`evidence_no_asn`). */
  cfAsn: number | null;
  asOrganization: string | null;
  views: number;
  distinctUrls: number;
  reasonCodes: string[];
}

/** `group_concat` output is comma-joined JSON arrays. A bad value yields no codes. */
function parseReasonCodes(concatenated: string | null): string[] {
  if (!concatenated) return [];
  try {
    const arrays = JSON.parse(`[${concatenated}]`) as string[][];
    return [...new Set(arrays.flat())].sort(compareText);
  } catch {
    return [];
  }
}

/**
 * The day's largest Unresolved clients, on the day's latest version, with internal
 * traffic excluded (AECI-1579). Read-only and log-class (ADR 0022). A day with no
 * classification rows returns an empty list.
 *
 * **No `HUMAN` filter, deliberately.** A row with `is_bot = 1` from the ASN rule
 * alone is `unresolved` (`BOT_TRAFFIC_CLASSIFICATION.md` §2.12), and that is the
 * client this list exists to find. `7484a43e` on AS14618 is one. The stored class
 * alone decides.
 *
 * **A privacy row groups nothing.** Privacy-signal rows null both the hash and the
 * ASN, so grouping them would add many people into one client and could fire the
 * alert. Same reasoning as `detectUaHashSwarms`.
 *
 * **A blank user agent is listed, per network.** Ingest also stores a NULL hash when
 * the header is missing, and a crawler that sends none is what this list is for. With
 * no network as well there is nothing to group on, so that row is not listed.
 *
 * Distinct URLs counts `concrete_path`, because `path` is a route pattern and a
 * crawler reading every product would count as one.
 */
export async function readTopUnresolvedClients(
  db: Db,
  day: string,
): Promise<TopUnresolvedClient[]> {
  const { perDay } = await latestVersionPerDay(db, day, day);
  const version = perDay.get(day);
  if (version === undefined) return [];

  const rows = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      cfAsn: pageViews.cfAsn,
      // `max()` rather than a group key: the holder is a label, see `detectAsnRotators`.
      asOrganization: sql<string | null>`max(${pageViews.cfAsOrganization})`,
      views: count(),
      distinctUrls: countDistinct(pageViews.concretePath),
      reasonCodes: sql<
        string | null
      >`group_concat(distinct ${pageViewClassifications.reasonCodes})`,
    })
    .from(pageViewClassifications)
    .innerJoin(pageViews, eq(pageViews.id, pageViewClassifications.pageViewId))
    .where(
      and(
        eq(pageViewClassifications.viewDay, day),
        eq(pageViewClassifications.classifierVersion, version),
        eq(pageViewClassifications.class, 'unresolved'),
        or(
          sql`${pageViews.userAgentHash} is not null`,
          sql`${pageViews.cfAsn} is not null and coalesce(${pageViews.privacySignal}, 0) = 0`,
        ),
        NOT_INTERNAL,
      ),
    )
    .groupBy(pageViews.userAgentHash, pageViews.cfAsn)
    .orderBy(desc(count()), asc(pageViews.userAgentHash), asc(pageViews.cfAsn))
    .limit(TOP_UNRESOLVED_CLIENTS_LIMIT);

  return rows.map((r) => ({
    userAgentHash: r.userAgentHash,
    cfAsn: r.cfAsn,
    asOrganization: r.asOrganization ?? null,
    views: r.views,
    distinctUrls: r.distinctUrls,
    reasonCodes: parseReasonCodes(r.reasonCodes),
  }));
}

/** One Unresolved browser identity of a day, summed across every network it used. */
export interface TopUnresolvedIdentity {
  userAgentHash: string;
  views: number;
  /** Distinct networks. A row with no network adds views but no network. */
  networks: number;
}

/**
 * The day's largest Unresolved browser identities, each summed across every
 * network it used, on the day's latest version, with internal traffic excluded
 * (AECI-1644). Read-only and log-class (ADR 0022). A day with no classification
 * rows returns an empty list.
 *
 * The population is {@link readTopUnresolvedClients}' exactly, with one change.
 * It groups by the hash alone, so a client that spreads over many networks adds
 * up to one row. A residential proxy pool hides from the per-network list that
 * way: `069245a2` held 14.6% on 389 networks on 2026-11-02, and no pair passed 2%.
 *
 * **A row with no user agent never joins a browser identity.** A NULL hash is not
 * an identity, and grouping it would add every no-user-agent client into one row.
 * Privacy rows null the hash too, so they drop out by the same test.
 *
 * `countDistinct` skips NULL, so a row with no network adds no network. No
 * compound `SELECT`, so D1's limits are not in play.
 */
export async function readTopUnresolvedIdentities(
  db: Db,
  day: string,
): Promise<TopUnresolvedIdentity[]> {
  const { perDay } = await latestVersionPerDay(db, day, day);
  const version = perDay.get(day);
  if (version === undefined) return [];

  const rows = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      views: count(),
      networks: countDistinct(pageViews.cfAsn),
    })
    .from(pageViewClassifications)
    .innerJoin(pageViews, eq(pageViews.id, pageViewClassifications.pageViewId))
    .where(
      and(
        eq(pageViewClassifications.viewDay, day),
        eq(pageViewClassifications.classifierVersion, version),
        eq(pageViewClassifications.class, 'unresolved'),
        sql`${pageViews.userAgentHash} is not null`,
        NOT_INTERNAL,
      ),
    )
    .groupBy(pageViews.userAgentHash)
    .orderBy(desc(count()), asc(pageViews.userAgentHash))
    .limit(TOP_UNRESOLVED_IDENTITIES_LIMIT);

  // The `where` drops NULL hashes, so the filter only narrows the type.
  return rows.flatMap((r) =>
    r.userAgentHash === null
      ? []
      : [{ userAgentHash: r.userAgentHash, views: r.views, networks: r.networks }],
  );
}

/**
 * Browser identities of one day that share a main network (AECI-1647). The main
 * network of an identity is its busiest network: the one that carried more of its
 * Unresolved views than any other. It need not carry a majority.
 */
export interface TopUnresolvedNetworkGroup {
  /** The shared main network. */
  cfAsn: number;
  /** Its holder, as Cloudflare reported it. A label only. */
  asOrganization: string | null;
  /** How many browser identities have this network as their main network. */
  identities: number;
  /** Their views across every network they used, the main one included. */
  views: number;
  /** The part of {@link views} that came from the main network itself. */
  mainNetworkViews: number;
}

/**
 * The day's largest groups of Unresolved browser identities that share a main
 * network, on the day's latest version, with internal traffic excluded
 * (AECI-1647). Read-only and log-class (ADR 0022). A day with no classification
 * rows returns an empty list.
 *
 * It closes the gap the two other lists leave. A program can split its traffic
 * over several browser strings as well as over many networks. On 2026-10-24 eight
 * identities on AS214483 each held 3.4% to 3.7%, so neither list warned, and
 * together they held 27.8% of the day.
 *
 * The population is {@link readTopUnresolvedIdentities}' exactly. One query
 * returns each `(user_agent_hash, cf_asn)` count, and the grouping runs here:
 *
 *  - An identity's main network is its busiest non-NULL network, ties to the
 *    lower ASN. An identity seen only with no network has no main network and
 *    joins no group.
 *  - A group's views are its members' views on every network, NULL included.
 *  - A group needs {@link NETWORK_GROUP_MIN_IDENTITIES} members.
 *
 * The query returns one row per pair of the day, not a top N, because the main
 * network depends on every pair of an identity. The most so far was 803 pairs, on
 * 2026-10-24. No compound `SELECT`, so D1's limits are not in play.
 */
export async function readTopUnresolvedNetworkGroups(
  db: Db,
  day: string,
): Promise<TopUnresolvedNetworkGroup[]> {
  const { perDay } = await latestVersionPerDay(db, day, day);
  const version = perDay.get(day);
  if (version === undefined) return [];

  const rows = await db
    .select({
      userAgentHash: pageViews.userAgentHash,
      cfAsn: pageViews.cfAsn,
      asOrganization: sql<string | null>`max(${pageViews.cfAsOrganization})`,
      views: count(),
    })
    .from(pageViewClassifications)
    .innerJoin(pageViews, eq(pageViews.id, pageViewClassifications.pageViewId))
    .where(
      and(
        eq(pageViewClassifications.viewDay, day),
        eq(pageViewClassifications.classifierVersion, version),
        eq(pageViewClassifications.class, 'unresolved'),
        sql`${pageViews.userAgentHash} is not null`,
        NOT_INTERNAL,
      ),
    )
    .groupBy(pageViews.userAgentHash, pageViews.cfAsn);

  return groupByMainNetwork(rows);
}

/** One `(user_agent_hash, cf_asn)` count, the input to {@link groupByMainNetwork}. */
export interface IdentityNetworkCount {
  userAgentHash: string | null;
  cfAsn: number | null;
  asOrganization: string | null;
  views: number;
}

/**
 * Groups identities by their main network. Pure, so the rule is tested without a
 * database. See {@link readTopUnresolvedNetworkGroups} for the rule.
 */
export function groupByMainNetwork(rows: IdentityNetworkCount[]): TopUnresolvedNetworkGroup[] {
  // The main-network rule is shared with the AECI-1659 candidate, so the email's
  // groups and the classifier's cannot disagree on which network is an identity's.
  const identities = mainNetworkByIdentity(rows);

  const groups = new Map<number, TopUnresolvedNetworkGroup>();
  for (const { total, main } of identities.values()) {
    if (main === null) continue;
    const group = groups.get(main.cfAsn) ?? {
      cfAsn: main.cfAsn,
      asOrganization: null,
      identities: 0,
      views: 0,
      mainNetworkViews: 0,
    };
    group.identities += 1;
    group.views += total;
    group.mainNetworkViews += main.views;
    // The holder is a label, so any member's reading will do. Keep the largest
    // string, as `max()` does in SQL, so the result does not depend on row order.
    if (
      main.asOrganization !== null &&
      (group.asOrganization === null || main.asOrganization > group.asOrganization)
    ) {
      group.asOrganization = main.asOrganization;
    }
    groups.set(main.cfAsn, group);
  }

  return [...groups.values()]
    .filter((g) => g.identities >= NETWORK_GROUP_MIN_IDENTITIES)
    .sort((a, b) => b.views - a.views || a.cfAsn - b.cfAsn)
    .slice(0, TOP_UNRESOLVED_NETWORK_GROUPS_LIMIT);
}

/**
 * Why a day's class counts cannot be compared with the prior day's, or null when
 * they can (AECI-1346). One rule for the panel's `delta_day` and the email.
 *
 *  - `day_unclassified`: the reported day has no counts at all.
 *  - `prior_unclassified`: the prior day has no counts to compare against.
 *  - `classifier`: the two days are counted on different latest versions (D19(c)).
 *  - `method`: a non-comparable §3d collection-method change falls between them.
 *
 * The classifier reason wins over the method reason when both hold, because it
 * is the one the class counts are defined by.
 */
export type ClassDeltaBlocker = 'day_unclassified' | 'prior_unclassified' | 'classifier' | 'method';

export function classDeltaBlocker(
  dayVersion: string | null | undefined,
  priorVersion: string | null | undefined,
  methodNotComparable: boolean,
): ClassDeltaBlocker | null {
  if (!dayVersion) return 'day_unclassified';
  if (!priorVersion) return 'prior_unclassified';
  if (dayVersion !== priorVersion) return 'classifier';
  if (methodNotComparable) return 'method';
  return null;
}

/**
 * The version seam across `[fromDay, toDay]`, or null when every classified day
 * in it is counted on one version (AECI-1461). The Activity feed's
 * `classification_version_seam` gate. Same rule as the overview's, through
 * {@link versionSeamFor}.
 */
export async function readWindowVersionSeam(
  db: Db,
  fromDay: string,
  toDay: string,
): Promise<AdminClassificationSummary['version_seam']> {
  const { perDay, ordered } = await latestVersionPerDay(db, fromDay, toDay);
  return versionSeamFor(perDay, ordered);
}

/**
 * The Activity feed's `class=` filter (AECI-1461): the page view's class at its
 * own latest classification, or, for {@link ADMIN_PAGE_VIEW_NULL_FILTER}, no
 * classification at all.
 *
 * **"Latest" must be {@link readRowClassifications}' rule exactly**: greatest
 * `evaluated_at`, ties to the larger `id`. Otherwise a filtered row could show a
 * different class from the one it was filtered on. It is per row, not the day's
 * latest version that {@link automationClassFilterForDay} uses.
 *
 * The scalar subquery is NULL for an unclassified view, so `= ?` drops it, which
 * is right for a named class. The sentinel is a separate `NOT EXISTS`. Both
 * correlate on the unaliased `page_views` and use the `page_view_id` prefix of
 * `page_view_classifications_view_version_idx`. One bound parameter.
 */
export function latestClassPredicate(cls: string): SQL {
  if (cls === ADMIN_PAGE_VIEW_NULL_FILTER) {
    return sql`not exists (
      select 1 from ${pageViewClassifications} as pvc
       where pvc.page_view_id = ${pageViews.id}
    )`;
  }
  return sql`(
    select pvc.class from ${pageViewClassifications} as pvc
     where pvc.page_view_id = ${pageViews.id}
     order by pvc.evaluated_at desc, pvc.id desc
     limit 1
  ) = ${cls}`;
}

/** Whole UTC days touched by `[from, to)`. The evidence window is not day-aligned:
 *  it ends `SPA_FOLLOWUP_WINDOW_MINUTES` past a midnight. */
function daysTouched(from: string, to: string): number {
  const start = Date.parse(from.slice(0, 10));
  return Math.max(1, Math.ceil((Date.parse(to) - start) / DAY_MS));
}

/**
 * The latest stored classification of each page view in `ids`. A row with none
 * is absent from the map, and the caller renders `classification: null`, never
 * a class. The ids go in as one JSON array through `json_each(?)`, so the page
 * size never reaches D1's bound-parameter cap.
 */
export async function readRowClassifications(
  db: Db,
  ids: readonly number[],
): Promise<Map<number, AdminPageViewClassification>> {
  const out = new Map<number, AdminPageViewClassification>();
  if (ids.length === 0) return out;

  const rows = await db
    .select({
      id: pageViewClassifications.id,
      pageViewId: pageViewClassifications.pageViewId,
      class: pageViewClassifications.class,
      reasonCodes: pageViewClassifications.reasonCodes,
      classifierVersion: pageViewClassifications.classifierVersion,
      evaluatedAt: pageViewClassifications.evaluatedAt,
      evidenceFrom: pageViewClassifications.evidenceFrom,
      evidenceTo: pageViewClassifications.evidenceTo,
    })
    .from(pageViewClassifications)
    .where(
      sql`${pageViewClassifications.pageViewId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
    );

  const latest = new Map<number, (typeof rows)[number]>();
  for (const r of rows) {
    const current = latest.get(r.pageViewId);
    if (
      !current ||
      r.evaluatedAt > current.evaluatedAt ||
      (r.evaluatedAt === current.evaluatedAt && r.id > current.id)
    ) {
      latest.set(r.pageViewId, r);
    }
  }

  for (const [pageViewId, r] of latest) {
    const codes = Array.isArray(r.reasonCodes) ? r.reasonCodes : [];
    out.set(pageViewId, {
      class: r.class as AdminTrafficClass,
      reason_codes: codes,
      classifier_version: r.classifierVersion,
      evaluated_at: r.evaluatedAt,
      evidence_window: {
        from: r.evidenceFrom,
        to: r.evidenceTo,
        timezone: 'UTC',
        days: daysTouched(r.evidenceFrom, r.evidenceTo),
      },
      evidence_complete: !codes.some((c) => c.startsWith('evidence_')),
    });
  }
  return out;
}
