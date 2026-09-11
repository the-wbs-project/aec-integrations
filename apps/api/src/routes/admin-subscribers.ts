/**
 * `GET /api/admin/subscribers` (AECI-859 / Phase 8.3 P5.2) — the mailing-list
 * roster, paginated. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.4/§6,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * **This is the first row-level read surface `mailing_list` has ever had.** The
 * table is written by `POST /api/subscribe` and `POST /api/unsubscribe`
 * (`routes/landing-forms.ts`) and, until now, read only in aggregate: the §5.4
 * growth and churn series, the overview card's `active_subscribers`, and the
 * 00:15 snapshot cron. An operator could see how many people were on the list and
 * could not see who, or when any one of them joined.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching (§6 conventions). The queries live in `lib/admin-audience.ts`; this
 * handler parses, fans out, and wraps the envelope — the same division as
 * `routes/admin-feedback.ts`.
 *
 * ─── Two choices worth knowing before extending this ─────────────────────────
 *
 * **1. `total` is filtered and `subscribers` is not, and both are needed.**
 * `total` drives the paginator, so it has to count what the current `status` and
 * `search` actually match. The filter chips need the opposite — the lifetime
 * stock behind each choice, regardless of which one is selected — and that comes
 * from `subscriberTotals()`, the identical call `/api/admin/audience` makes.
 * Re-deriving it here from a second query is exactly how two screens end up
 * reporting different subscriber counts on the same day.
 *
 * **2. No window filter, deliberately — same reasoning as the feedback inbox.**
 * A roster is read end to end rather than measured over a period, and the
 * windowed signup figures already ride on `/api/admin/audience` as
 * `window_totals`. Adding `?from=&to=` here would give an operator two different
 * ways to ask the same question and one more way to misread the answer.
 */

import {
  AdminSubscribersQuerySchema,
  AdminSubscribersResponseSchema,
  type AdminSubscribersResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { listSubscribers, subscriberTotals } from '../lib/admin-audience';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

type AdminContext = Context<{ Bindings: Env }>;

export interface AdminSubscribersDeps {
  now?: () => Date;
}

export function createAdminSubscribersHandler(
  dbFor: DbFactory = getDb,
  deps: AdminSubscribersDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminSubscribersQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    const [{ rows, total }, subscribers] = await Promise.all([
      listSubscribers(db, query),
      subscriberTotals(db),
    ]);

    const body: AdminSubscribersResponse = {
      data: rows,
      page: query.page,
      perPage: query.perPage,
      total,
      generated_at: now.toISOString(),
      source: 'live',
      // Present and normally empty, matching the feedback inbox: a future caveat
      // then needs no envelope change on either side of the wire.
      notes: [],
      subscribers,
    };

    validateResponseInDev(c.env, () => {
      AdminSubscribersResponseSchema.parse(body);
    });

    return json(body);
  };
}
