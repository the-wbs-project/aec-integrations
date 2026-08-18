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
 * here, and the note is built from `countFilter`: `internalFilterNote`'s
 * not-applied wording ("every figure is unfiltered") would be false on this
 * endpoint, since `window_total.excluding_internal` is populated regardless.
 *
 * **The `/admin/*` + `/account` exclusion is not a filter.** §13 D12 makes it a
 * floor beneath the caller's filters, folded into `inWindow()` inside
 * `listPageViews` — no query string can surface an operator row. It is also
 * deliberately silent: unlike the ASN filter it is not a heuristic over real
 * visitors, so there is no false-positive class to disclose and no "N excluded"
 * line to render.
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

    const [page, windowTotal, windowVisitors, biasNotes] = await Promise.all([
      listPageViews(db, w, query.traffic, rowFilter, columns, query.page, query.perPage),
      countViewsBoth(db, w, query.traffic, countFilter, columns),
      countUniqueVisitorsBoth(db, w, query.traffic, countFilter, columns),
      trafficNotes(db, w, { sources: true, unique: true }),
    ]);

    const notes: AdminNote[] = [...biasNotes, internalFilterNote(countFilter)];
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
    };

    validateResponseInDev(c.env, () => {
      AdminPageViewsResponseSchema.parse(body);
    });

    return json(body);
  };
}
