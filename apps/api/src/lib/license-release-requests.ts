/**
 * Early-unassign requests (AECI-1373, E4.4; `VENDOR_SIGNUP_PROCESS.md` §2 decision 11,
 * §3 step 8): the pieces the vendor route, the admin route and the Billing read share.
 *
 * An owner seat asks AECi to take a live license off its product before renewal
 * (`routes/vendor-license-release.ts`). An operator approves or declines it
 * (`routes/admin-license-release-requests.ts`). An approve unassigns the license
 * through `unassignLicenseStatements` in `lib/license.ts`, the one license writer, with
 * the audit action overridden to `license.release_approved`. This module writes no
 * license row itself.
 */

import type { AdminLicenseReleaseRequest, LicenseReleaseRequestStatus } from '@aeci/shared';
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { licenseReleaseRequests, licenses, products, vendors } from '../db/schema';
import { ONE_ROW } from './integration-claims';

/** `audit_log.action` for each step. The approve row is written by the license builder. */
export const LICENSE_RELEASE_ACTION = {
  requested: 'license.release_requested',
  approved: 'license.release_approved',
  declined: 'license.release_declined',
} as const;

/** `metadata.source` on every row this feature writes from the admin side. */
export const LICENSE_RELEASE_ADMIN_SOURCE = 'admin-license-release';

/** `license-release-request-alert:{requestId}`. One alert per saved request. */
export const licenseReleaseAlertKey = (requestId: string) =>
  `license-release-request-alert:${requestId}`;

/** The partial unique index that allows one OPEN request per license. */
const OPEN_LICENSE_KEY = 'license_release_requests_open_license_key';

/**
 * True for the error the partial unique index raises when a second open request for
 * one license reaches the batch: a concurrent ask committed between the open-request
 * read and this INSERT. D1 names the index columns, SQLite may name the index.
 */
export function isOpenReleaseRequestConflict(error: unknown): boolean {
  return causeChainMatches(
    error,
    new RegExp(
      `UNIQUE constraint failed: license_release_requests\\.license_id|${OPEN_LICENSE_KEY}`,
      'i',
    ),
  );
}

/**
 * A batch statement that ABORTS the batch when the guarded UPDATE right before it
 * changed no row. The `productRequestStillOpenSentinel` pattern: `json('…')` on a
 * non-JSON string raises "malformed JSON", which rolls the whole batch back. The
 * decision batch places one after the request UPDATE (another admin decided it) and,
 * on an approve, one after the license UPDATE (the license ended, was unassigned or
 * moved since the read), so a lost race writes nothing at all.
 *
 * FROM a one-row constant, so the guard is evaluated exactly once.
 */
export function changedOneRowSentinel(db: Db) {
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('license-release-race') END` })
    .from(ONE_ROW);
}

/** True for the error {@link changedOneRowSentinel} raises, in D1 or SQLite. */
export function isReleaseRaceError(error: unknown): boolean {
  return causeChainMatches(error, /malformed JSON/i);
}

function causeChainMatches(error: unknown, pattern: RegExp): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (pattern.test(String((current as { message?: unknown }).message ?? current))) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

const requestProducts = alias(products, 'release_request_products');

/**
 * The joined select the admin queue, the decision and the Billing read go through: the
 * request, its vendor and its request-time product (both snapshots, so `LEFT JOIN`),
 * and the license as it stands now.
 */
export function releaseRequestSelect(db: Db) {
  return db
    .select({
      request: licenseReleaseRequests,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      // Aliased (AECI-1511): the Billing read batches this select, where D1 rebuilds rows
      // from column NAMES, so a second bare `slug` collapses into `vendors.slug` and
      // every later field shifts.
      productSlug: sql<string | null>`${requestProducts.slug}`.as('request_product_slug'),
      productName: requestProducts.name,
      licenseSource: licenses.source,
      licenseStartsAt: licenses.startsAt,
      licenseEndsAt: licenses.endsAt,
      licenseEndedAt: licenses.endedAt,
      licenseAssignedProductId: licenses.assignedProductId,
    })
    .from(licenseReleaseRequests)
    .leftJoin(vendors, eq(vendors.id, licenseReleaseRequests.vendorId))
    .leftJoin(requestProducts, eq(requestProducts.id, licenseReleaseRequests.productId))
    .leftJoin(licenses, eq(licenses.id, licenseReleaseRequests.licenseId));
}

export type ReleaseRequestJoinedRow = Awaited<
  ReturnType<ReturnType<typeof releaseRequestSelect>['where']>
>[number];

/** The operator's wire shape. */
export function toAdminLicenseReleaseRequest(
  r: ReleaseRequestJoinedRow,
): AdminLicenseReleaseRequest {
  const row = r.request;
  return {
    id: row.id,
    status: row.status as LicenseReleaseRequestStatus,
    license_id: row.licenseId,
    vendor_id: row.vendorId,
    vendor:
      r.vendorSlug !== null && r.vendorName !== null
        ? { id: row.vendorId, slug: r.vendorSlug, name: r.vendorName }
        : null,
    billing_account_id: row.billingAccountId,
    product_id: row.productId,
    product:
      row.productId !== null && r.productSlug !== null && r.productName !== null
        ? { id: row.productId, slug: r.productSlug, name: r.productName }
        : null,
    requested_by: row.requestedBy,
    reason: row.reason,
    created_at: row.createdAt,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt,
    decision_note: row.decisionNote,
    license:
      r.licenseSource !== null && r.licenseStartsAt !== null
        ? {
            source: r.licenseSource,
            starts_at: r.licenseStartsAt,
            ends_at: r.licenseEndsAt,
            ended_at: r.licenseEndedAt,
            assigned_product_id: r.licenseAssignedProductId,
          }
        : null,
  };
}
