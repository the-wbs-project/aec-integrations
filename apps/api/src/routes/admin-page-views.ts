/**
 * `GET /api/admin/page-views` (AECI-577 / Phase 8.3 P1.3) — the §5.2 Activity
 * feed: a reverse-chronological page of individual visits. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.2/§6, `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching. Paginated with `PageQuerySchema` + the standard envelope so the list
 * shape matches `/api/admin/requests`; `total` is a row count, not a group count.
 *
 * This is the consent-independent counterpart to PostHog's Activity explorer.
 * PostHog only ever sees traffic that clicked Accept, and a single-page arrival
 * from a search engine never does — `page_views` sees all of it, which is why the
 * privacy and honesty constraints below are not decoration.
 *
 * ─── Three deliberate choices ────────────────────────────────────────────────
 *
 * **The internal-ASN filter is resolved twice.** §13 D10 constraint 2 is "show
 * both numbers, never substitute". On a count endpoint that is free. On a row
 * feed it is not: `exclude_internal=1` removes rows, so if the counts were
 * computed the same way the operator would see a smaller number with nothing to
 * compare it against — the substitution the constraint forbids. So `countFilter`
 * always asks (both figures are computed whenever the var is set, toggle or no
 * toggle) and `rowFilter` carries the caller's flag, governing only which rows
 * come back. `/api/admin/overview` already sets this precedent — it always asks,
 * because its whole job is to show both figures side by side.
 *
 * Consequently `internal_filter.applied` means **"the row list was filtered"**
 * here, and the note is built from `countFilter` rather than `rowFilter`: the
 * note describes what the COUNTS did, and the counts always ask. Building it
 * from `rowFilter` would report the ASN filter as absent on a request whose
 * `window_total.excluding_internal` is populated. (Before AECI-752 that mattered
 * more than it does now — the not-applied message read "every figure is
 * unfiltered", which was flatly false here. The message is narrowed to its own
 * axis now, but the `countFilter` choice is still the correct one.)
 *
 * **The `/admin/*` + `/account` exclusion is not a filter.** §13 D12 makes it a
 * floor beneath the caller's filters, folded into `inWindow()` inside
 * `listPageViews` — no query string can surface an operator row. It is also
 * deliberately silent: unlike the ASN filter it is not a heuristic over real
 * visitors, so there is no false-positive class to disclose and no "N excluded"
 * line to render.
 *
 * **`writer` filters on a fact, not a claim (AECI-871).** Every other column filter
 * here selects something the request asserted — `source` comes from `Referer`,
 * which §9.7 records a confirmed production forgery of. `writer_provenance` is
 * stamped by our own SSR Worker on a header it strips a client copy of first, so it
 * is the one axis in this feed a visitor cannot set. Its NULL bucket
 * (`writer=__none__`) means "written before AECI-871" and will be most of the table
 * for a while; it is selectable for the same reason the `source` NULL bucket is.
 *
 * **`class` is a row filter with its own second number (AECI-1461).** It removes
 * rows the same way `exclude_internal` does, so the same D10 constraint-2 problem
 * arrives with it. `window_total` keeps following the row list, and when `class`
 * is sent the handler also counts the window without it
 * (`window_total_all_classes` / `window_visitors_all_classes`). The operator always
 * sees the figure the class was cut from. The two extra counts run only when the
 * filter is sent, because without it `window_total` already is that figure.
 *
 * Two classification notes ride the envelope. `classification_is_heuristic` is
 * unconditional, because the Class column is always on screen (the overview's
 * rule for the same note). `classification_version_seam` is gated on the window
 * spanning a classifier change, the D19(c) flag a class-filtered count needs.
 *
 * **Every caveat the window earns travels with it.** `trafficNotes(..., {
 * sources: true, unique: true })` emits all four the feed owes its reader:
 * unclassified rows counted as human, missing `referrer_source` (null reads as
 * *unknown*, never as `Direct`), `Direct` as a mixed bucket (AECI-585 records the
 * `navigation` flag at ingest, but this feed does not group on it yet and no
 * earlier row can be separated at all), and the approximate §9.8 visitor
 * definition.
 */

import {
  AdminPageViewsQuerySchema,
  AdminPageViewsResponseSchema,
  type AdminNote,
  type AdminPageViewsResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import {
  countUniqueVisitorsBoth,
  countViewsBoth,
  internalFilterNote,
  isPartial,
  listPageViews,
  note,
  pageViewFilterPredicate,
  resolveInternalFilter,
  toAdminInternalFilter,
  toAdminWindow,
  trafficNotes,
  utcRangeWindow,
} from '../lib/admin-analytics';
import { readWindowVersionSeam } from '../lib/admin-classification';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-traffic.ts`.
type AdminContext = Context<{ Bindings: Env }>;

export interface AdminPageViewsDeps {
  now?: () => Date;
}

export function createAdminPageViewsHandler(
  dbFor: DbFactory = getDb,
  deps: AdminPageViewsDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminPageViewsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    const w = utcRangeWindow(query.from, query.to);
    // Two states, one var: see the module header.
    const rowFilter = resolveInternalFilter(c.env, query.exclude_internal);
    const countFilter = resolveInternalFilter(c.env, true);
    // The column filters apply to the counts too, so `window_total` reconciles
    // with the paginated `total` instead of describing a different population.
    const columns = pageViewFilterPredicate(query);
    // AECI-1461. The same predicate without `class`: the figure a class was cut from.
    const allClasses =
      query.class === undefined ? null : pageViewFilterPredicate({ ...query, class: undefined });

    const [
      page,
      windowTotal,
      windowVisitors,
      totalAllClasses,
      visitorsAllClasses,
      biasNotes,
      seam,
    ] = await Promise.all([
      listPageViews(db, w, query.traffic, rowFilter, columns, query.page, query.perPage),
      countViewsBoth(db, w, query.traffic, countFilter, columns),
      countUniqueVisitorsBoth(db, w, query.traffic, countFilter, columns),
      allClasses === null ? null : countViewsBoth(db, w, query.traffic, countFilter, allClasses),
      allClasses === null
        ? null
        : countUniqueVisitorsBoth(db, w, query.traffic, countFilter, allClasses),
      trafficNotes(db, w, { sources: true, unique: true }),
      readWindowVersionSeam(db, w.fromDay, w.toDay),
    ]);

    const notes: AdminNote[] = [
      ...biasNotes,
      internalFilterNote(countFilter),
      note(
        'classification_is_heuristic',
        'Traffic classes are a heuristic judgement about requests. browser_with_human_evidence means the app ran with nothing contradicting it, not that a human was present.',
      ),
    ];
    if (seam) {
      notes.push(
        note(
          'classification_version_seam',
          `The window spans a classifier change from ${seam.from_version} to ${seam.to_version} on ${seam.changed_on}. Each row shows its own latest version, so rows either side of the change were judged by different rules.`,
          { ...seam },
        ),
      );
    }
    if (isPartial(w, now)) {
      notes.push(
        note(
          'partial_day',
          'The window includes the current UTC day, whose counts are still filling.',
          { day: w.toDay },
        ),
      );
    }

    const body: AdminPageViewsResponse = {
      data: page.rows,
      page: query.page,
      perPage: query.perPage,
      total: page.total,
      traffic: query.traffic,
      window: toAdminWindow(w),
      generated_at: now.toISOString(),
      source: 'live',
      notes,
      internal_filter: toAdminInternalFilter(rowFilter),
      window_total: windowTotal,
      window_visitors: windowVisitors,
      window_total_all_classes: totalAllClasses,
      window_visitors_all_classes: visitorsAllClasses,
    };

    validateResponseInDev(c.env, () => {
      AdminPageViewsResponseSchema.parse(body);
    });

    return json(body);
  };
}
