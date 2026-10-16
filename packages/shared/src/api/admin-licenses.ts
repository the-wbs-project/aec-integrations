import { z } from 'zod';

import {
  ADMIN_GRANT_LICENSE_SOURCES,
  LICENSE_GRANT_NOTES_MAX,
  LICENSE_GRANT_QUANTITY_MAX,
  LICENSE_GRANT_REFERENCE_MAX,
  LICENSE_SOURCES,
} from '../entitlements';

import { EntitlementTermDateSchema } from './admin-entitlements';
import { AdminOverrideReasonSchema } from './admin-reason';

/**
 * Admin license grant contracts (AECI-1370, E4.1; `docs/VENDOR_SIGNUP_PROCESS.md` §3
 * step 5 and decisions 6, 16, 17).
 *
 *   POST /api/admin/vendors/:id/licenses, behind `requireAdmin()` and the `write`
 *   rate limit.
 *
 * A grant writes N UNASSIGNED licenses on the vendor's billing account. It assigns
 * nothing: assignment is the vendor's (E5). The licenses are written by
 * `grantLicensesStatements` in `apps/api/src/lib/license.ts`, the one license writer.
 *
 * ── IDEMPOTENT ON `grant_id` ────────────────────────────────────────────────────
 * The control mints `grant_id` when the form opens. The license ids derive from it,
 * so a double submit or a retry after a lost response cannot write 2N licenses: the
 * second call finds the first call's rows and answers 200 with them (`replayed`),
 * writing nothing and sending no email. A `grant_id` whose rows only partly match
 * the request is `409 LICENSE_GRANT_CONFLICT`.
 */

/** The sources an admin may grant. `stripe` is refused here: only E9's webhook writes it. */
export const AdminGrantLicenseSourceSchema = z.enum(ADMIN_GRANT_LICENSE_SOURCES);

/**
 * Body for `POST /api/admin/vendors/:id/licenses`.
 *
 * `ends_at` is required for both sources (an invoice or complimentary license always
 * has an end date, decision 6). Whether it falls after the start is checked in the
 * handler, as instants, because `starts_at` defaults to the server's now (Paid Tiers
 * §5.5). `reference` is required for `invoice`. `notes` is an internal note recorded
 * in the audit row's `metadata.notes`: `licenses` has no notes column.
 */
export const GrantLicensesSchema = z
  .object({
    grant_id: z.string().uuid(),
    quantity: z.number().int().min(1).max(LICENSE_GRANT_QUANTITY_MAX),
    source: AdminGrantLicenseSourceSchema,
    starts_at: EntitlementTermDateSchema.optional(),
    ends_at: EntitlementTermDateSchema,
    reference: z.string().trim().max(LICENSE_GRANT_REFERENCE_MAX).optional(),
    notes: z.string().trim().max(LICENSE_GRANT_NOTES_MAX).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.source === 'invoice' && !body.reference) {
      ctx.addIssue({
        code: 'custom',
        path: ['reference'],
        message: 'An invoice grant needs a reference: the invoice number or PO.',
      });
    }
  });
export type GrantLicensesInput = z.infer<typeof GrantLicensesSchema>;

/** One license as the grant wrote it (or, on a replay, as it stands). */
export const AdminGrantedLicenseSchema = z.object({
  id: z.string(),
  source: z.enum(LICENSE_SOURCES),
  starts_at: z.string(),
  ends_at: z.string().nullable(),
  reference: z.string().nullable(),
  assigned_product_id: z.string().nullable(),
});
export type AdminGrantedLicense = z.infer<typeof AdminGrantedLicenseSchema>;

/**
 * A condition the operator should know about that did not stop the grant (AECI-738:
 * warn, never gate). `pure_connector_vendor`: every product the vendor owns is a
 * connector, and connector vendors and licenses are parked (AECI-1343).
 */
export const GrantLicensesWarningSchema = z.object({
  code: z.enum(['pure_connector_vendor']),
  message: z.string(),
});
export type GrantLicensesWarning = z.infer<typeof GrantLicensesWarningSchema>;

/** Response for `POST /api/admin/vendors/:id/licenses`: 201 on a write, 200 on a replay. */
export const GrantLicensesResponseSchema = z.object({
  vendor_id: z.string(),
  billing_account_id: z.string(),
  grant_id: z.string(),
  /** `true`: this `grant_id` was already granted. Nothing was written or emailed. */
  replayed: z.boolean(),
  licenses: z.array(AdminGrantedLicenseSchema),
  warnings: z.array(GrantLicensesWarningSchema),
});
export type GrantLicensesResponse = z.infer<typeof GrantLicensesResponseSchema>;

// ─── PATCH /api/admin/licenses/:id (AECI-1371, E4.2) ────────────────────────
//
// Edit one license: move its end date, change its invoice reference, or revoke it.
// `docs/VENDOR_SIGNUP_PROCESS.md` §3 steps 5 and 11, decisions 11 and 14;
// `STAGE_2_PAID_TIERS_SPEC.md` §5.2.
//
// Every action is refused on an ended license (422 `INVALID_STATE_TRANSITION`): there
// is no un-end, and a new license is a new grant. A Stripe license refuses `extend`
// and `reference` (409 `LICENSE_SOURCE_STRIPE`): Stripe owns its term and its invoice.

/**
 * `extend`: a new scheduled end. It must fall strictly after the current end, as
 * instants. A license with no end date (an open-ended complimentary back-fill, ruled
 * 2026-10-14) takes any end after now and after its start: this is how AECi sets the
 * date it deferred.
 */
export const ExtendLicenseSchema = z
  .object({
    action: z.literal('extend'),
    ends_at: EntitlementTermDateSchema,
  })
  .strict();

/** `reference`: a new invoice number or PO. Invoice licenses only. Never blank. */
export const ReferenceLicenseSchema = z
  .object({
    action: z.literal('reference'),
    reference: z.string().trim().min(1).max(LICENSE_GRANT_REFERENCE_MAX),
  })
  .strict();

/**
 * `revoke`: end the license now (`end_reason = 'revoked'`). Mirrors
 * `AdminRevokeSeatSchema`: `reason` is required and the vendor reads it in its portal
 * messages; `internalNote` is optional and stays in the audit row. The license keeps
 * its product as history (decision 14). The product drops to Free because no live
 * license holds it any more.
 */
export const RevokeLicenseSchema = AdminOverrideReasonSchema.extend({
  action: z.literal('revoke'),
}).strict();

/** Body for `PATCH /api/admin/licenses/:id`. Discriminated on `action`. */
export const UpdateLicenseSchema = z.discriminatedUnion('action', [
  ExtendLicenseSchema,
  ReferenceLicenseSchema,
  RevokeLicenseSchema,
]);
export type UpdateLicenseInput = z.infer<typeof UpdateLicenseSchema>;
/** What a client sends: `internalNote` may be absent (the parsed type always has the key). */
export type UpdateLicenseBody = z.input<typeof UpdateLicenseSchema>;
export type UpdateLicenseAction = UpdateLicenseInput['action'];

/** One license as it stands after the edit. */
export const AdminUpdatedLicenseSchema = AdminGrantedLicenseSchema.extend({
  ended_at: z.string().nullable(),
  end_reason: z.string().nullable(),
});
export type AdminUpdatedLicense = z.infer<typeof AdminUpdatedLicenseSchema>;

/** Response for `PATCH /api/admin/licenses/:id` (200). */
export const UpdateLicenseResponseSchema = z.object({
  vendor_id: z.string(),
  billing_account_id: z.string(),
  action: z.enum(['extend', 'reference', 'revoke']),
  /** `false`: the license already stood as asked (the same reference). Nothing written. */
  changed: z.boolean(),
  license: AdminUpdatedLicenseSchema,
});
export type UpdateLicenseResponse = z.infer<typeof UpdateLicenseResponseSchema>;
