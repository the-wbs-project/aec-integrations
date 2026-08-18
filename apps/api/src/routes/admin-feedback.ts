/**
 * `GET /api/admin/feedback` (AECI-586 / Phase 8.3 P5.1) — the feedback inbox,
 * paginated. Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.4/§6,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 * **This is the first read surface the `feedback` table has ever had.** It is
 * written by `POST /api/feedback` (`routes/landing-forms.ts`) and forwarded as a
 * fire-and-forget operator email to `ADMIN_ALERT_EMAIL` — and that email has been
 * the only way anyone has seen a submission since the table was created. Nothing
 * here re-shapes an existing view; the column set simply is the row.
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * caching. `PageQuerySchema` only — no window filter, deliberately: an inbox is
 * read end to end rather than measured, and the windowed count already rides on
 * `/api/admin/audience` as `feedback.in_window`.
 */

import {
  AdminFeedbackQuerySchema,
  AdminFeedbackResponseSchema,
  type AdminFeedbackResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { json } from '../http';
import { listFeedback } from '../lib/admin-audience';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

type AdminContext = Context<{ Bindings: Env }>;

export interface AdminFeedbackDeps {
  now?: () => Date;
}

export function createAdminFeedbackHandler(
  dbFor: DbFactory = getDb,
  deps: AdminFeedbackDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());

  return async (c) => {
    const query = AdminFeedbackQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const now = clock();
    const { db } = dbFor(c.env);

    const { rows, total } = await listFeedback(db, query.page, query.perPage);

    const body: AdminFeedbackResponse = {
      data: rows,
      page: query.page,
      perPage: query.perPage,
      total,
      generated_at: now.toISOString(),
      source: 'live',
      // Present and normally empty: a future caveat here then needs no envelope
      // change on either side of the wire.
      notes: [],
    };

    validateResponseInDev(c.env, () => {
      AdminFeedbackResponseSchema.parse(body);
    });

    return json(body);
  };
}
