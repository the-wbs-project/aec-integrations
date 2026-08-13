/**
 * `GET /api/admin/metrics/timeseries` (AECI-574 / Phase 8.3 P1.1) — one metric,
 * day-bucketed over a UTC window. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §6,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching (`json()` sets `private, no-store`).
 *
 * ─── Snapshot first, live fallback (P2.1 / AECI-581) ─────────────────────────
 *
 * P1.1 aggregated on every request and said so: `source: 'live'`. P2.1 added the
 * `metrics_daily` snapshot table, and this handler now reads it per day and falls
 * back to live aggregation for any day it does not cover — a storage swap behind
 * an unchanged shape, which is why the metric keys were already §7.1's
 * `namespace.metric` strings: they are `metrics_daily.metric` verbatim.
 *
 * `source` reports which happened (`snapshot` / `live` / `mixed`). `mixed` is the
 * normal case, not an edge: the cron captures the prior COMPLETE UTC day, so any
 * window reaching today has at least one uncovered day by construction.
 *
 * **The internal-ASN filter bypasses the snapshot entirely.** `metrics_daily`
 * stores the unfiltered figure only — `ANALYTICS_INTERNAL_ASNS` (§13 D10) is
 * read-time configuration, and baking today's list into a stored row would rot
 * silently the moment it changed. When the filter is applied the whole window is
 * aggregated live, which `page_views`' 400-day retention always supports.
 *
 * ─── Three honesty obligations this endpoint carries ─────────────────────────
 *
 * **A reconstructed day says so, per point.** The pre-snapshot segment is
 * backfilled, and for the three `audit_log`-derived `catalog.*` series it can
 * only ever be approximate (§4). `points[].reconstructed` marks exactly which
 * days, and `series_partly_reconstructed` states it in prose — a chart that
 * silently blends reconstructed and measured data is what §1.1 forbids.
 *
 * **`catalog.*` are additions, never totals.** They count `audit_log` `*.created`
 * events. §4 shows net totals are not recoverable — 827 `integration.created`
 * events back 496 live rows, because the 2026-07-25 reset removed rows without
 * per-row audit. Every `catalog.*` response therefore carries
 * `catalog_series_is_additions_only`, and a window reaching back past the audit
 * log's own first row additionally carries `catalog_series_starts_at` so a
 * leading run of zeros is not misread as a quiet period.
 *
 * **`from`/`to` are inclusive dates, and the response says what that became.**
 * `from=to` is a legal single-day range. The `window` block reports the resulting
 * half-open `[from, to)` instants, so the boundary is never left to inference.
 * The series is zero-filled across every day in the window — a chart should never
 * have to distinguish "no data" from "no key".
 */

import {
  AdminTimeseriesQuerySchema,
  AdminTimeseriesResponseSchema,
  type AdminMetricSource,
  type AdminNote,
  type AdminTimeseriesPoint,
  type AdminTimeseriesResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import {
  earliestAuditDay,
  enumerateDays,
  internalFilterNote,
  isPartial,
  metricSeries,
  metricSupportsInternalFilter,
  note,
  resolveInternalFilter,
  snapshotSeries,
  toAdminInternalFilter,
  toAdminWindow,
  trafficNotes,
  utcRangeWindow,
  type SnapshotPoint,
} from '../lib/admin-analytics';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-summary.ts`.
type AdminContext = Context<{ Bindings: Env }>;

export interface AdminTimeseriesDeps {
  now?: () => Date;
}

export function createAdminTimeseriesHandler(
  dbFor: DbFactory = getDb,
  deps: AdminTimeseriesDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminTimeseriesQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    // Throws 400 on a reversed range, a non-existent calendar date, or a window
    // longer than `page_views` retention.
    const w = utcRangeWindow(query.from, query.to);
    const filter = resolveInternalFilter(c.env, query.exclude_internal);

    const days = enumerateDays(w);

    // Snapshot first, live for the rest. `filter.applied` skips the snapshot
    // entirely — see the module header for why a stored row cannot carry a
    // config-dependent figure.
    const snapshot: Map<string, SnapshotPoint> = filter.applied
      ? new Map()
      : await snapshotSeries(db, query.metric, w);
    const uncovered = days.filter((day) => !snapshot.has(day));

    // One live query covering the whole window, run only when something is
    // missing from the snapshot — which, because today is never captured, is the
    // common case rather than the exception.
    const live =
      uncovered.length > 0
        ? await metricSeries(db, query.metric, w, filter)
        : { perDay: new Map<string, number>(), perDayFiltered: null };
    const { perDay, perDayFiltered } = live;

    const points: AdminTimeseriesPoint[] = days.map((day) => {
      const captured = snapshot.get(day);
      return {
        day,
        value: captured ? captured.value : (perDay.get(day) ?? 0),
        // Only the live path can produce this: the snapshot stores the unfiltered
        // figure, and when the filter IS applied nothing comes from the snapshot.
        value_excluding_internal: perDayFiltered ? (perDayFiltered.get(day) ?? 0) : null,
        reconstructed: captured?.reconstructed ?? false,
      };
    });

    const source: AdminMetricSource =
      snapshot.size === 0 ? 'live' : uncovered.length === 0 ? 'snapshot' : 'mixed';

    // `traffic.unique_visitors` is the one metric whose buckets do not sum to a
    // meaningful window total — a visitor active on three days appears in three
    // buckets. Summing the series is the correct total for every other metric and
    // is the only total that agrees with the chart, so it is what we report; the
    // window-distinct figure is the overview's `unique_visitors`, which is
    // labelled for a single day.
    const sum = (xs: Array<number | null>): number =>
      xs.reduce<number>((acc, x) => acc + (x ?? 0), 0);
    const total = {
      total: sum(points.map((p) => p.value)),
      excluding_internal: perDayFiltered
        ? sum(points.map((p) => p.value_excluding_internal))
        : null,
    };

    const notes: AdminNote[] = [];
    if (query.metric.startsWith('traffic.')) {
      notes.push(
        ...(await trafficNotes(db, w, { unique: query.metric === 'traffic.unique_visitors' })),
      );
    }
    if (query.metric.startsWith('catalog.')) {
      notes.push(
        note(
          'catalog_series_is_additions_only',
          'This series counts creation events from the audit log. It is additions per day, not a net total — rows removed later still count on the day they were added.',
          { metric: query.metric },
        ),
      );
      const earliest = await earliestAuditDay(db);
      if (earliest && earliest > w.fromDay) {
        notes.push(
          note(
            'catalog_series_starts_at',
            `The audit log begins ${earliest}; days before that read zero for want of data, not for want of activity.`,
            { earliest_day: earliest },
          ),
        );
      }
    }
    if (query.exclude_internal && !metricSupportsInternalFilter(query.metric)) {
      // Asked for, but there is no ASN on a catalog/profile row to filter against.
      // Say so rather than returning nulls the caller has to interpret.
      notes.push(
        note(
          'internal_filter_unavailable',
          `Internal-traffic filtering does not apply to ${query.metric}; only traffic.* metrics carry a network ASN.`,
          { metric: query.metric },
        ),
      );
    } else {
      notes.push(internalFilterNote(filter));
    }
    if (isPartial(w, now)) {
      notes.push(
        note(
          'partial_day',
          'The window includes the current UTC day, whose bucket is still filling.',
          { day: w.toDay },
        ),
      );
    }
    const reconstructed = points.filter((p) => p.reconstructed);
    const lastReconstructed = reconstructed.at(-1);
    if (lastReconstructed) {
      notes.push(
        note(
          'series_partly_reconstructed',
          `${reconstructed.length} day(s) up to ${lastReconstructed.day} were reconstructed from the audit log after the fact, not captured on the day. Treat that segment as approximate.`,
          {
            reconstructed_days: reconstructed.length,
            reconstructed_through: lastReconstructed.day,
          },
        ),
      );
    }

    const body: AdminTimeseriesResponse = {
      metric: query.metric,
      interval: query.interval,
      window: toAdminWindow(w),
      generated_at: now.toISOString(),
      source,
      notes,
      internal_filter: toAdminInternalFilter(filter),
      points,
      total,
    };

    validateResponseInDev(c.env, () => {
      AdminTimeseriesResponseSchema.parse(body);
    });

    return json(body);
  };
}
