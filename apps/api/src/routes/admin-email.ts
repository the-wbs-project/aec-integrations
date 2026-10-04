/**
 * `/admin/email` reads (AECI-1223): what we sent, and whether it arrived.
 * Source of truth: `docs/ADMIN_PANEL_SPEC.md` §5.14 / §6 / §13 D23,
 * `docs/API_CONTRACTS.md` §6.10.
 *
 *   GET  /api/admin/email/summary        per-template 7- and 30-day counts
 *   GET  /api/admin/email/sends          the send ledger, newest first, filtered
 *   POST /api/admin/email/sends/search   the same list for one exact address
 *
 * Admin-gated (`requireAdmin()` in `index.ts`), read-only: no `audit_log` row, no
 * `rateLimit()` (reads are never limited, `waf-rate-limits.md` §6), no caching.
 *
 * ─── Why the search is a POST ─────────────────────────────────────────────────
 *
 * Both Workers record every request URL in Workers Logs (`invocation_logs: true`). An
 * address in a query string would be written there on every search, which undoes the
 * hash-only ledger (ADR 0038, §13 D23). So the address travels in the body, and the GET
 * refuses an `address` parameter outright rather than silently ignoring it: a caller who
 * put one in the URL has already logged it, and should be told.
 *
 * Nothing in this file logs the request body or the address. A validation error names the
 * field, never its value.
 */

import {
  AdminEmailSearchBodySchema,
  AdminEmailSearchResponseSchema,
  AdminEmailSendsQuerySchema,
  AdminEmailSendsResponseSchema,
  AdminEmailSummaryResponseSchema,
  type AdminEmailSearchResponse,
  type AdminEmailSendsResponse,
} from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import {
  listEmailSends,
  listUnmatchedEvents,
  readEmailSummary,
  searchHash,
} from '../lib/admin-email';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { isProductionTier, tierLabel } from '../lib/notifications/delivery-policy';

type AdminContext = Context<{ Bindings: Env }>;

export interface AdminEmailDeps {
  now?: () => Date;
}

/** `GET /api/admin/email/summary`. No parameters: the windows are fixed at 7 and 30 days. */
export function createAdminEmailSummaryHandler(
  dbFor: DbFactory = getDb,
  deps: AdminEmailDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const { db } = dbFor(c.env);
    const body = await readEmailSummary(db, clock(), {
      production: isProductionTier(c.env),
      environment: tierLabel(c.env),
    });
    validateResponseInDev(c.env, () => {
      AdminEmailSummaryResponseSchema.parse(body);
    });
    return json(body);
  };
}

/** `GET /api/admin/email/sends`. Refuses `address` (see the header). */
export function createAdminEmailSendsHandler(
  dbFor: DbFactory = getDb,
  deps: AdminEmailDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    const params = new URL(c.req.url).searchParams;
    if (params.has('address')) {
      throw new ApiError(
        400,
        'ADDRESS_NOT_ALLOWED_IN_URL',
        'Search by address with POST /api/admin/email/sends/search. An address must not be put in a URL.',
        { field: 'address' },
      );
    }
    const query = AdminEmailSendsQuerySchema.parse(Object.fromEntries(params));
    const { db } = dbFor(c.env);
    const { rows, total } = await listEmailSends(db, query, null);

    const body: AdminEmailSendsResponse = {
      data: rows,
      page: query.page,
      perPage: query.perPage,
      total,
      generated_at: clock().toISOString(),
    };
    validateResponseInDev(c.env, () => {
      AdminEmailSendsResponseSchema.parse(body);
    });
    return json(body);
  };
}

/** `POST /api/admin/email/sends/search`. A read with a body; writes nothing. */
export function createAdminEmailSearchHandler(
  dbFor: DbFactory = getDb,
  deps: AdminEmailDeps = {},
): (c: AdminContext) => Promise<Response> {
  const clock = deps.now ?? (() => new Date());
  return async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Body must be JSON');
    }
    const { address, ...filters } = AdminEmailSearchBodySchema.parse(raw);
    const hash = await searchHash(address);

    const { db } = dbFor(c.env);
    const [{ rows, total }, unmatched] = await Promise.all([
      listEmailSends(db, filters, hash),
      listUnmatchedEvents(db, hash),
    ]);

    const body: AdminEmailSearchResponse = {
      data: rows,
      page: filters.page,
      perPage: filters.perPage,
      total,
      generated_at: clock().toISOString(),
      unmatched_events: unmatched,
    };
    validateResponseInDev(c.env, () => {
      AdminEmailSearchResponseSchema.parse(body);
    });
    return json(body);
  };
}
