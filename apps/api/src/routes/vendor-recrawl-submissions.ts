/**
 * `GET /api/vendor/recrawl-submissions` (AECI-1187) — the vendor's search-engine
 * submission history. Source of truth: `API_CONTRACTS.md` §6.14,
 * `DATABASE_SCHEMA.md` §9.6a and §9.6b.
 *
 * One row per (submission, this vendor's cause). The query starts from
 * `recrawl_submission_causes`, filtered on the session vendor, and inner-joins the
 * submission it points at. So a URL whose submission was caused by two vendors'
 * edits (a pair page both endpoints edited) shows each vendor only its own cause
 * row, never the other's. A submission with no cause for this vendor never
 * appears. A URL refused N times yields N submission rows with the same cause,
 * one per attempt.
 *
 * ── SCOPING ─────────────────────────────────────────────────────────────────
 * `vendorId` comes from `sessionVendorId(c)`, never the request. There is no RLS
 * (ADR 0016), so {@link vendorRecrawlSubmissionsWhere} is the whole authorization
 * below the guard. The `(vendor_id, submission_id)` index carries it.
 *
 * ── NOT GATED, NOT LIMITED, NOT AUDITED ─────────────────────────────────────
 * Submission itself is Managed-only (`STAGE_2_PAID_TIERS_SPEC.md` §13.1a), but
 * reading your own history is not a capability (decision 3, 2026-10-04; §4.3
 * "reads never are"). A Free vendor gets 200 with an empty list, or with the
 * rows from a period when it held a plan. Reads are never rate-limited
 * (ADR 0026). A pure read writes no `audit_log` row.
 *
 * ── JOINS ───────────────────────────────────────────────────────────────────
 * `audit_log` and `products` are LEFT joins: a cause may carry no audit id, and a
 * product may have been deleted since. Neither may drop a row. The audit row
 * named by a vendor cause is the vendor's own write, so its `action` is the
 * vendor's to see. The product is the vendor's own product at write time.
 *
 * ── ORDER ───────────────────────────────────────────────────────────────────
 * `submitted_at DESC, submission id DESC, cause id DESC`. All three are
 * timestamp or integer orderings, so they stay BINARY (`API_CONTRACTS.md` §3.2).
 * One drain run shares one `submitted_at`, so the two id terms make the page
 * boundaries stable.
 */

import {
  ListVendorRecrawlSubmissionsQuerySchema,
  ListVendorRecrawlSubmissionsResponseSchema,
  type ListVendorRecrawlSubmissionsResponse,
  type RecrawlSubmissionChannel,
  type VendorRecrawlSubmission,
} from '@aeci/shared';
import { and, count, desc, eq, type SQL } from 'drizzle-orm';

import { getDb } from '../db/client';
import { auditLog, products, recrawlSubmissionCauses, recrawlSubmissions } from '../db/schema';
import { json } from '../http';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';

import { sessionVendorId, type VendorContext } from './vendor-shared';

/**
 * The scoping predicate. The vendor filter is on the CAUSE row, not on anything
 * derived from the URL: a pair URL belongs to two vendors, and only the cause
 * says whose edit sent it. Exported so the spec can pin its shape.
 */
export function vendorRecrawlSubmissionsWhere(
  vendorId: string,
  channel?: RecrawlSubmissionChannel,
): SQL {
  const byVendor = eq(recrawlSubmissionCauses.vendorId, vendorId);
  return channel ? and(byVendor, eq(recrawlSubmissions.channel, channel))! : byVendor;
}

export function createListVendorRecrawlSubmissionsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const query = ListVendorRecrawlSubmissionsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);
    const where = vendorRecrawlSubmissionsWhere(vendorId, query.channel);

    const [rows, totals] = await db.batch([
      db
        .select({
          submissionId: recrawlSubmissions.id,
          url: recrawlSubmissions.url,
          channel: recrawlSubmissions.channel,
          outcome: recrawlSubmissions.outcome,
          submittedAt: recrawlSubmissions.submittedAt,
          auditLogId: recrawlSubmissionCauses.auditLogId,
          action: auditLog.action,
          productId: recrawlSubmissionCauses.productId,
          productSlug: products.slug,
          productName: products.name,
          queuedAt: recrawlSubmissionCauses.queuedAt,
        })
        .from(recrawlSubmissionCauses)
        .innerJoin(
          recrawlSubmissions,
          eq(recrawlSubmissions.id, recrawlSubmissionCauses.submissionId),
        )
        .leftJoin(auditLog, eq(auditLog.id, recrawlSubmissionCauses.auditLogId))
        .leftJoin(products, eq(products.id, recrawlSubmissionCauses.productId))
        .where(where)
        .orderBy(
          desc(recrawlSubmissions.submittedAt),
          desc(recrawlSubmissions.id),
          desc(recrawlSubmissionCauses.id),
        )
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db
        .select({ value: count() })
        .from(recrawlSubmissionCauses)
        .innerJoin(
          recrawlSubmissions,
          eq(recrawlSubmissions.id, recrawlSubmissionCauses.submissionId),
        )
        .where(where),
    ]);

    const body: ListVendorRecrawlSubmissionsResponse = {
      data: rows.map(
        (r): VendorRecrawlSubmission => ({
          submission_id: r.submissionId,
          url: r.url,
          channel: r.channel as VendorRecrawlSubmission['channel'],
          outcome: r.outcome as VendorRecrawlSubmission['outcome'],
          submitted_at: r.submittedAt,
          cause: {
            audit_log_id: r.auditLogId,
            action: r.action,
            product_id: r.productId,
            product_slug: r.productSlug,
            product_name: r.productName,
            queued_at: r.queuedAt,
          },
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => ListVendorRecrawlSubmissionsResponseSchema.parse(body));
    return json(body);
  };
}
