/**
 * `GET /api/admin/traffic/breakdown` (AECI-574 / Phase 8.3 P1.1) — grouped
 * `page_views` counts over a UTC window. Source of truth:
 * `docs/ADMIN_PANEL_SPEC.md` §5.3/§6, `docs/API_CONTRACTS.md` §6.10.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching.
 *
 * Five dimensions — `source | country | path | product | bot`. Pagination is over
 * GROUPS and uses `PageQuerySchema` + the standard paginated envelope so the list
 * shape matches `/api/admin/requests` (§6); `total` is the distinct-group count.
 *
 * ─── Three deliberate choices ────────────────────────────────────────────────
 *
 * **NULL groups are shown, not dropped.** A row with no `referrer_source` or no
 * `cf_country` gets its own bucket with `key: null`. Dropping them is how a
 * source breakdown quietly starts claiming attribution it does not have —
 * `window_total` is returned precisely so the caller can see the groups
 * reconcile. `label` carries an ASCII fallback; the UI keys off `key === null` to
 * render its own localized placeholder.
 *
 * **`traffic` defaults to `human`**, matching §5.2's filter default, and
 * `dimension=bot` forces the bot population — grouping human rows by `bot_name`
 * would return a single empty bucket.
 *
 * **`window_total` is the population's total for the whole window**, the same
 * figure for every dimension. For `dimension=product` the groups therefore sum to
 * LESS than it (most views are not product pages); that is intentional and lets
 * the UI show "product pages were N% of traffic" without a second request.
 */

import {
  AdminTrafficBreakdownQuerySchema,
  AdminTrafficBreakdownResponseSchema,
  type AdminNote,
  type AdminTrafficBreakdownResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import {
  breakdown,
  countViewsBoth,
  internalFilterNote,
  isPartial,
  note,
  resolveInternalFilter,
  toAdminInternalFilter,
  toAdminWindow,
  trafficNotes,
  utcRangeWindow,
} from '../lib/admin-analytics';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

// The `requireAdmin()` gate (index.ts) enforces access and sets `c.get('auth')`,
// but this handler reads no auth context — so it is typed on Bindings alone,
// mirroring `routes/admin-summary.ts`.
type AdminContext = Context<{ Bindings: Env }>;

export interface AdminTrafficBreakdownDeps {
  now?: () => Date;
}

export function createAdminTrafficBreakdownHandler(
  dbFor: DbFactory = getDb,
  deps: AdminTrafficBreakdownDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminTrafficBreakdownQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    const w = utcRangeWindow(query.from, query.to);
    const filter = resolveInternalFilter(c.env, query.exclude_internal);
    // Grouping humans by `bot_name` yields one empty bucket, so the dimension
    // decides the population here rather than trusting the caller.
    const traffic = query.dimension === 'bot' ? 'bot' : query.traffic;

    const [page, windowTotal, biasNotes] = await Promise.all([
      breakdown(db, query.dimension, w, traffic, filter, query.page, query.perPage),
      countViewsBoth(db, w, traffic, filter),
      trafficNotes(db, w, { sources: query.dimension === 'source' }),
    ]);

    const notes: AdminNote[] = [...biasNotes, internalFilterNote(filter)];
    if (isPartial(w, now)) {
      notes.push(
        note(
          'partial_day',
          'The window includes the current UTC day, whose counts are still filling.',
          { day: w.toDay },
        ),
      );
    }

    const body: AdminTrafficBreakdownResponse = {
      data: page.rows,
      page: query.page,
      perPage: query.perPage,
      total: page.groups,
      dimension: query.dimension,
      traffic,
      window: toAdminWindow(w),
      generated_at: now.toISOString(),
      source: 'live',
      notes,
      internal_filter: toAdminInternalFilter(filter),
      window_total: windowTotal,
    };

    validateResponseInDev(c.env, () => {
      AdminTrafficBreakdownResponseSchema.parse(body);
    });

    return json(body);
  };
}
