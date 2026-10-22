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

import type {
  AdminClassificationSummary,
  AdminPageViewClassification,
  AdminTrafficClass,
} from '@aeci/shared';
import { and, eq, gte, lte, max, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { pageViewClassifications, pageViews } from '../db/schema';
import { NOT_INTERNAL } from './page-view-predicates';
import { TRAFFIC_CLASSES } from './traffic-classifier';

/**
 * The share of classified, non-internal views above which the overview warns
 * (`classification_unresolved_share`). Ruled 2026-10-21 (AECI-1345). Strictly
 * greater than: exactly half does not warn. `POST_LAUNCH_MONITORING.md` §3b.
 */
export const CLASSIFICATION_UNRESOLVED_SHARE_MAX = 0.5;

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
 * `operatorLeakViews` is the overview's existing D15(b) figure, passed through
 * so `internal_excluded.operator_leak_inferred` and `traffic.operator_leak_excluded`
 * are one number.
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
