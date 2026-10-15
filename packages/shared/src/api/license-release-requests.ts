import { z } from 'zod';

import { AdminReasonSchema } from './admin-reason';
import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';

/**
 * Early-unassign requests (AECI-1373, E4.4; `docs/VENDOR_SIGNUP_PROCESS.md` §2
 * decision 11 and §3 step 8). An owner seat asks AEC Integrations to take a live
 * license off its product before renewal. An approve puts the license back in the
 * vendor's pool, unassigned and still live, with its term dates unchanged. The product
 * drops to Free. A decline changes nothing on the license.
 *
 *   POST  /api/vendor/licenses/:id/release-request  — ask (201 `{ request }`).
 *   GET   /api/admin/license-release-requests       — the admin queue, by status.
 *   PATCH /api/admin/license-release-requests/:id   — approve or decline an open one.
 *
 * Wire shapes: `API_CONTRACTS.md` §6.10 (admin) and §6.14 (vendor). Table:
 * `DATABASE_SCHEMA.md` §8.6e. Screen: `ADMIN_PANEL_SPEC.md` §5.17.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * Zod's field errors.
 */

/** Every status a request can hold. `open` until an operator decides it. */
export const LICENSE_RELEASE_REQUEST_STATUSES = ['open', 'approved', 'declined'] as const;
export const LicenseReleaseRequestStatusSchema = z.enum(LICENSE_RELEASE_REQUEST_STATUSES);
export type LicenseReleaseRequestStatus = z.infer<typeof LicenseReleaseRequestStatusSchema>;

/** The longest reason an owner may give. */
export const LICENSE_RELEASE_REASON_MAX = 1000;

// ─── The vendor's request ────────────────────────────────────────────────────

/**
 * Body of `POST /api/vendor/licenses/:id/release-request`. `.strict()`: any other key
 * is a `400`. The reason is required (1 to 1,000, trimmed): the operator decides on it.
 */
export const CreateLicenseReleaseRequestSchema = z
  .object({
    reason: z.string().trim().min(1).max(LICENSE_RELEASE_REASON_MAX),
  })
  .strict();
export type CreateLicenseReleaseRequest = z.infer<typeof CreateLicenseReleaseRequestSchema>;

/** One request as the vendor sees it. `decision_note` is a decline's reason. */
export const VendorLicenseReleaseRequestSchema = z.object({
  id: z.string().uuid(),
  license_id: z.string(),
  /** The product the license was on when the owner asked. */
  product_id: z.string().nullable(),
  status: LicenseReleaseRequestStatusSchema,
  reason: z.string(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  decision_note: z.string().nullable(),
});
export type VendorLicenseReleaseRequest = z.infer<typeof VendorLicenseReleaseRequestSchema>;

/** `201` body of the vendor POST. */
export const CreateLicenseReleaseRequestResponseSchema = z.object({
  request: VendorLicenseReleaseRequestSchema,
});
export type CreateLicenseReleaseRequestResponse = z.infer<
  typeof CreateLicenseReleaseRequestResponseSchema
>;

// ─── The admin queue ─────────────────────────────────────────────────────────

/** The license as it stands NOW, so the operator sees whether it is still on the product. */
export const AdminLicenseReleaseLicenseSchema = z.object({
  /** `LICENSE_SOURCES`, unconstrained in D1. */
  source: z.string(),
  starts_at: z.string(),
  /** Scheduled end. `null` = monthly. */
  ends_at: z.string().nullable(),
  /** Stored end. `null` = live. */
  ended_at: z.string().nullable(),
  /** The product the license is on now. `null` = unassigned. */
  assigned_product_id: z.string().nullable(),
});
export type AdminLicenseReleaseLicense = z.infer<typeof AdminLicenseReleaseLicenseSchema>;

/**
 * One request as the operator sees it, on `/admin/requests` and on the Billing tab of
 * `/admin/vendors/:id`. `vendor` and `product` are joined at read time and are `null`
 * when the row is gone (snapshots, no FK). `requested_by` and `decided_by` are profile
 * ids with no FK, nulled by an account erasure. `license` is `null` only if the license
 * row is gone, which nothing does today.
 */
export const AdminLicenseReleaseRequestSchema = z.object({
  id: z.string().uuid(),
  status: LicenseReleaseRequestStatusSchema,
  license_id: z.string(),
  vendor_id: z.string(),
  vendor: LinkRefSchema.nullable(),
  billing_account_id: z.string(),
  /** The product the license was on when the owner asked. */
  product_id: z.string().nullable(),
  product: LinkRefSchema.nullable(),
  /** The requesting owner seat's `profiles.id`. `null` after an erasure. */
  requested_by: z.string().nullable(),
  reason: z.string(),
  created_at: z.string(),
  decided_by: z.string().nullable(),
  decided_at: z.string().nullable(),
  /** A decline's reason, shown to the vendor. `null` on an open or approved request. */
  decision_note: z.string().nullable(),
  license: AdminLicenseReleaseLicenseSchema.nullable(),
});
export type AdminLicenseReleaseRequest = z.infer<typeof AdminLicenseReleaseRequestSchema>;

/** Query of `GET /api/admin/license-release-requests`. `status` defaults to `open`. */
export const ListLicenseReleaseRequestsQuerySchema = PageQuerySchema.extend({
  status: LicenseReleaseRequestStatusSchema.default('open'),
});
export type ListLicenseReleaseRequestsQuery = z.infer<typeof ListLicenseReleaseRequestsQuerySchema>;

export const ListLicenseReleaseRequestsResponseSchema = paginatedResponseSchema(
  AdminLicenseReleaseRequestSchema,
);
export type ListLicenseReleaseRequestsResponse = z.infer<
  typeof ListLicenseReleaseRequestsResponseSchema
>;

/**
 * Body of `PATCH /api/admin/license-release-requests/:id`, discriminated on `action`.
 *
 *   - `approve`: take the license off its product now. It stays live and keeps its
 *     term dates. `409 LICENSE_NOT_ASSIGNED` when the license has ended, been
 *     unassigned, or moved to another product since the owner asked.
 *   - `decline`: `reason` (1 to 1,000) is shown to the vendor.
 *
 * A request that is no longer open answers `409 RELEASE_REQUEST_NOT_OPEN`.
 */
export const DecideLicenseReleaseRequestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve') }).strict(),
  z.object({ action: z.literal('decline'), reason: AdminReasonSchema }).strict(),
]);
export type DecideLicenseReleaseRequest = z.infer<typeof DecideLicenseReleaseRequestSchema>;
