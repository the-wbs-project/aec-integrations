import { z } from 'zod';

import {
  EntitlementStatusSchema,
  EntitlementTierSchema,
  VendorEntitlementResponseSchema,
} from './admin-entitlements';
import { PageQuerySchema, paginatedResponseSchema } from './common';
import { VendorSeatInviteSchema, VendorSeatSchema } from './vendor';
import { VendorSortSchema } from './vendors';

/**
 * Admin vendor surface contracts (AECI-652 / `docs/STAGE_2_PAID_TIERS_SPEC.md`
 * §5.6). The operator's way into a vendor that never filed a claim, behind
 * `requireAdmin()`:
 *
 *   GET    /api/admin/vendors                    — paginated list + name/slug search
 *   GET    /api/admin/vendors/:id                — basics, entitlement, seats, counts
 *   GET    /api/admin/vendors/:id/audit          — the `audit_log` viewer
 *   DELETE /api/admin/vendors/:id/seats/:userId  — revoke one seat
 *
 * Before this, the only vendor-management surface in the panel was the
 * entitlement control embedded in a `/admin/claims` card — so a vendor with no
 * claim row had nothing to hang it on, which blocked concierge onboarding
 * outright. §5.6 reverses the §11 deferral of "a standalone `/admin/vendors`
 * entitlement browser".
 *
 * **The entitlement WRITE is not here.** It stays `PATCH /api/admin/vendors/:id/
 * entitlement` (`admin-entitlements.ts`), which remains the sole writer that can
 * take `vendors.verified` back down, through the entitlement row. This module
 * adds three reads and one seat revoke — no second entitlement writer, and no
 * new writer of `vendors.verified` anywhere (the revoke reuses
 * `revokeSeatStatements`, which by construction never names `vendors`).
 *
 * Two conventions carried from `admin-claims.ts` and worth restating because
 * they are load-bearing here:
 *
 *  - **Required-nullable, never optional (R10).** A field that can genuinely be
 *    absent is `.nullable()`, so a missed construction site fails
 *    `validateResponseInDev` instead of shipping as `undefined`.
 *  - **`null` means UNAVAILABLE, `[]` means computed-and-empty.** The seats
 *    roster is the case that bit production on 2026-08-24: absent
 *    `SUPABASE_SERVICE_ROLE_KEY` must render "unavailable", never an empty list.
 *
 * The envelope is the **bare** `paginatedResponseSchema`, not the admin-console
 * `.extend({ generated_at, source, notes })` shape (`admin-panel.ts`).
 * `/admin/vendors` is an Operations surface — the `/admin/claims`,
 * `/admin/requests`, `/admin/reviewers` lineage — and `AdminNoteCode` is a closed
 * enum with an exhaustive renderer, so borrowing it would cost two extra files
 * for nothing this surface needs.
 */

// ─── GET /api/admin/vendors ──────────────────────────────────────────────────

/**
 * List filter. Deliberately NOT `VendorsListQuerySchema` (`vendors.ts`), whose
 * `verified` is `z.coerce.boolean()` — and `Boolean("false") === true`, so
 * `?verified=false` there filters for VERIFIED. The public directory never sends
 * `false` (its facet is a one-way "Verified only" toggle) so the bug has never
 * tripped; this surface needs a real tri-state, so it uses the enum form. The
 * public schema is fixed separately in AECI-691 — that is a public contract
 * change and does not belong buried in a new admin surface.
 *
 * `search` matches company name OR slug, substring, case-insensitively (SQLite
 * `LIKE` is case-insensitive for ASCII). Wildcards in the operator's box are
 * escaped, not honoured — see `likeContains` in `apps/api/src/lib/sql-like.ts`.
 */
export const AdminVendorsListQuerySchema = PageQuerySchema.extend({
  sort: VendorSortSchema,
  search: z.string().optional(),
  verified: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type AdminVendorsListQuery = z.infer<typeof AdminVendorsListQuerySchema>;

/**
 * One row on the operator's vendor list.
 *
 * `tier` / `status` come from a LEFT JOIN on `vendor_entitlements` and are `null`
 * together for a vendor with no entitlement row — which is the majority. They are
 * NOT derivable from `verified`: `verified` is the denormalized mirror (§2.1),
 * and showing both side by side is how an operator spots drift.
 *
 * `product_count` / `integration_count` are the same correlated subqueries the
 * public `/api/vendors` list already ships (`vendorListConfig.extras`), so they
 * cost one statement, not a fan-out.
 */
export const AdminVendorRowSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  company_name: z.string().min(1),
  /** The `vendors.verified` mirror, shown as-is. */
  verified: z.boolean(),
  /** `null` = no `vendor_entitlements` row at all, not "unknown". */
  tier: EntitlementTierSchema.nullable(),
  status: EntitlementStatusSchema.nullable(),
  /** `null` = perpetual OR no entitlement row; `tier`/`status` disambiguate. */
  period_end: z.string().nullable(),
  product_count: z.number().int().min(0),
  integration_count: z.number().int().min(0),
  updated_at: z.string(),
});
export type AdminVendorRow = z.infer<typeof AdminVendorRowSchema>;

export const AdminVendorsListResponseSchema = paginatedResponseSchema(AdminVendorRowSchema);
export type AdminVendorsListResponse = z.infer<typeof AdminVendorsListResponseSchema>;

// ─── GET /api/admin/vendors/:id ──────────────────────────────────────────────

/**
 * A seat on the vendor, admin view.
 *
 * Reuses `VendorSeatSchema` (the shape the vendor portal already renders) minus
 * `is_self` — an admin holds no seat, so the field would always be `false` and
 * inviting the reader to wonder. Adds the two fields the operator needs and a
 * peer does not: `role` (so a mis-provisioned row is visible rather than silently
 * filtered) and `work_email_verified` (the "does this person really work there?"
 * signal the claim queue shows).
 *
 * **`created_at` is ACCOUNT creation, not seat grant.** `profiles.created_at` is
 * when the Supabase user first got a profile row; the grant is a
 * `vendor_claim.granted` audit row. `profiles.updated_at` is no better — it moves
 * on any profile edit. The UI labels this "Account created" and points at the
 * audit trail for the grant; do not relabel it.
 *
 * `role` is a plain string, not an enum: `profiles_role_check` is a DB CHECK that
 * can gain a value without this file, and a roster that 500s on an unrecognised
 * role would be worse than one that shows it.
 */
export const AdminVendorSeatRowSchema = VendorSeatSchema.omit({ is_self: true }).extend({
  role: z.string(),
  work_email_verified: z.boolean(),
});
export type AdminVendorSeatRow = z.infer<typeof AdminVendorSeatRowSchema>;

/**
 * Claim counts by `vendor_requests.status`, scoped to this vendor AND the
 * products it owns (a product claim's `target_id` is a PRODUCT id, so a naive
 * `target_type='vendor'` test misses it).
 *
 * **All four statuses**, including `in_review`. `vendor_requests_status_check`
 * allows `open | in_review | resolved | rejected`; reporting three would give an
 * operator numbers that silently fail to sum.
 */
export const AdminVendorClaimCountsSchema = z.object({
  open: z.number().int().min(0),
  in_review: z.number().int().min(0),
  resolved: z.number().int().min(0),
  rejected: z.number().int().min(0),
});
export type AdminVendorClaimCounts = z.infer<typeof AdminVendorClaimCountsSchema>;

/**
 * The vendor's owned products broken down by `products.product_role`, so the
 * §5.2 **payer test** is answerable from the console (AECI-738).
 *
 * `STAGE_2_SPEC.md` §8.8(1): the test is *"does this vendor own any product with
 * `product_role IN ('application','hybrid')`?"* — `hybrid` counts as an endpoint.
 * Only a vendor **all** of whose products are `'connector'` is a pure connector
 * vendor, and it routes to the partnership track rather than being granted or
 * rejected (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2).
 *
 * **Derived per product, never per vendor.** `vendors` carries no connector
 * marker at all (no `role`/`kind`/`is_connector`), and it must not gain one:
 * Autodesk, Trimble, Deltek and Sage Group each own connector-role products
 * while being among the largest ENDPOINT accounts in the catalogue, so a
 * per-vendor flag would catch the exact inverse of the intent. Ownership is
 * every `product_vendors` row, not just the primary one — §8.8(1) asks what the
 * vendor owns, not what it owns first.
 *
 * `total` is carried rather than left to the caller to sum, because
 * `total === 0` is a distinct, load-bearing state: a vendor with no products is
 * **unknown**, not exempt, and must never read as a pure connector vendor.
 */
export const VendorProductRolesSchema = z.object({
  application: z.number().int().min(0),
  connector: z.number().int().min(0),
  hybrid: z.number().int().min(0),
  total: z.number().int().min(0),
});
export type VendorProductRoles = z.infer<typeof VendorProductRolesSchema>;

/**
 * The vendor detail payload.
 *
 * `seats` is `null` for UNAVAILABLE and `[]` for "no seats" — see the module note.
 * `seat_emails_available` says which of the two a `null` email on a present seat
 * means: `false` and every `email` is `null` because the GoTrue seam is
 * unreachable; `true` and a `null` email means that account genuinely has none.
 * Without it the surface cannot honestly distinguish them, which is exactly the
 * failure that produced "Account status unknown" on every row in production.
 */
export const AdminVendorDetailSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  company_name: z.string().min(1),
  description: z.string().nullable(),
  website: z.string().nullable(),
  headquarters: z.string().nullable(),
  logo_url: z.string().nullable(),
  verified: z.boolean(),
  promotion_status: z.string(),
  maintained_by: z.string(),
  last_reviewed_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),

  /** `null` = no entitlement on record (never granted, or cleared). */
  entitlement: VendorEntitlementResponseSchema.nullable(),

  seats: AdminVendorSeatRowSchema.array().nullable(),
  /** Whether the GoTrue email lookup succeeded at all (AECI-652 / the
   *  2026-08-24 incident). `false` ⇒ every `seats[].email` is `null` because the
   *  seam was unavailable, NOT because the accounts have no address. */
  seat_emails_available: z.boolean(),
  pending_invites: VendorSeatInviteSchema.array().nullable(),

  product_count: z.number().int().min(0),
  /** The same set as `product_count`, split by role (AECI-738). Both come out of
   *  ONE grouped read, and `product_count` is the sum — they cannot drift.
   *  Non-nullable, unlike the claim-queue copy: this runs inside the request's
   *  own `db.batch`, so it either resolves or the whole response fails. */
  product_roles: VendorProductRolesSchema,
  /** `true` ⇒ the vendor owns ≥1 product and EVERY one is `'connector'`.
   *  `false` when it owns an `application`/`hybrid` product **and** when it owns
   *  none at all — zero products is unknown, not exempt (read `product_roles.total`
   *  to tell those two apart). */
  is_pure_connector_vendor: z.boolean(),
  integration_count: z.number().int().min(0),
  claim_counts: AdminVendorClaimCountsSchema,
});
export type AdminVendorDetail = z.infer<typeof AdminVendorDetailSchema>;

// ─── GET /api/admin/vendors/:id/audit ────────────────────────────────────────

/**
 * Which half of the ledger to read.
 *
 *  - `entity` — what was done **to** this vendor: its own rows, its entitlement
 *    trail, its claims, its seat/invite lifecycle.
 *  - `actor`  — what this vendor's **people** did, including edits to their
 *    products, versions and attestations.
 *  - `all`    — the union, and the default. An operator's question is "what
 *    happened to this vendor", and the union was measured to stay a single
 *    index-driven scan, so making them choose up front is implementer's
 *    bookkeeping, not the user's.
 *
 * The two halves are separately selectable because they answer genuinely
 * different questions once a page is busy — a vendor with a hundred product
 * edits would otherwise bury its entitlement history.
 */
export const AdminVendorAuditScopeSchema = z.enum(['all', 'entity', 'actor']).default('all');
export type AdminVendorAuditScope = z.infer<typeof AdminVendorAuditScopeSchema>;

export const AdminVendorAuditQuerySchema = PageQuerySchema.extend({
  scope: AdminVendorAuditScopeSchema,
});
export type AdminVendorAuditQuery = z.infer<typeof AdminVendorAuditQuerySchema>;

/** Who performed an audited action. `null` for a `system`/`workflow` actor (cron,
 *  the promote Workflow) — those rows carry `actor_type` but no `actor_id`. */
export const AdminAuditActorSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string().nullable(),
  /** From the GoTrue seam; `null` when unavailable OR genuinely absent. The
   *  response-level `actor_emails_available` disambiguates. */
  email: z.string().nullable(),
});
export type AdminAuditActor = z.infer<typeof AdminAuditActorSchema>;

/**
 * One `audit_log` row, rendered.
 *
 * **`before_state` / `after_state` are `z.unknown().nullable()` on purpose.**
 * They are free-form JSON snapshots of only the changed fields, with no shared
 * contract, written by ~34 call sites across three years of schema — and the
 * table is hard-excluded from the retention prune, so today's reader is parsing
 * rows written by code that no longer exists. A `z.record(...)` would make
 * `validateResponseInDev` throw in dev the first time it met a scalar snapshot.
 * `z.unknown()` is non-optional in Zod 4, so this still satisfies R10: a MISSING
 * key is rejected, an explicit `null` is fine.
 *
 * `action` and `entity_type` are plain strings for the same reason — `entity_type`
 * carries no CHECK by deliberate design, and an enum here would turn a new writer
 * elsewhere into a 500 on this screen.
 */
export const AdminAuditRowSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  actor: AdminAuditActorSchema.nullable(),
  actor_type: z.string(),
  entity_type: z.string().nullable(),
  entity_id: z.string().nullable(),
  created_at: z.string(),
  before_state: z.unknown().nullable(),
  after_state: z.unknown().nullable(),
});
export type AdminAuditRow = z.infer<typeof AdminAuditRowSchema>;

/** Paginated envelope for `GET /api/admin/vendors/:id/audit`, plus the same
 *  GoTrue availability flag the detail payload carries — for identical reasons. */
export const AdminVendorAuditResponseSchema = paginatedResponseSchema(AdminAuditRowSchema).extend({
  actor_emails_available: z.boolean(),
});
export type AdminVendorAuditResponse = z.infer<typeof AdminVendorAuditResponseSchema>;
