import { z } from 'zod';

import {
  AdminInternalNoteSchema,
  AdminOverrideReasonSchema,
  AdminReasonSchema,
} from './admin-reason';
import { HttpsUrlSchema } from './https-url';

/**
 * The listing hide (AECI-1238, ADR 0052, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6).
 *
 * AECi takes a company or a product off the public site without deleting anything.
 * The row keeps its data. A restore puts it back exactly as it was. A company hide
 * also hides every product joined to the company, each through a CHILD hide row
 * that its restore clears.
 *
 * The three kinds come from counsel's removal-request table (`docs/runbooks/catalog.md`,
 * "Removal requests"). A hide is interim. It is not a finding that the listing is
 * false.
 */
export const LISTING_HIDE_KINDS = ['complaint_under_review', 'lawful_order', 'defunct'] as const;
export const ListingHideKindSchema = z.enum(LISTING_HIDE_KINDS);
export type ListingHideKind = z.infer<typeof ListingHideKindSchema>;

/** The two record types a listing hide covers. */
export const LISTING_HIDE_ENTITY_TYPES = ['vendor', 'product'] as const;
export const ListingHideEntityTypeSchema = z.enum(LISTING_HIDE_ENTITY_TYPES);
export type ListingHideEntityType = z.infer<typeof ListingHideEntityTypeSchema>;

/** Up to a day ahead of now, so a date typed in a time zone ahead of UTC passes. */
const RECEIVED_AT_SLACK_MS = 86_400_000;

/**
 * When AECi received the request: an ISO date (`2026-11-09`, what the admin form's
 * date input sends) or an ISO instant. Never in the future.
 */
export const ListingHideReceivedAtSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/, {
    message: 'Use a date like 2026-11-09.',
  })
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'Use a real date.' })
  .refine((value) => Date.parse(value) <= Date.now() + RECEIVED_AT_SLACK_MS, {
    message: 'The date the request was received cannot be in the future.',
  });

/**
 * `POST /api/admin/{vendors,products}/:id/hide`.
 *
 *   - `kind`: why AECi is hiding the listing.
 *   - `reason`: shown to the vendor, 1 to 1,000 characters (§11d.2).
 *   - `internalNote`: optional, never shown to a vendor.
 *   - `receivedAt`: when AECi received the request.
 *   - `sourceUrl`: the public source behind a complaint. Required for
 *     `complaint_under_review`, optional for the other two kinds.
 */
export const AdminListingHideBodySchema = z
  .object({
    kind: ListingHideKindSchema,
    reason: AdminReasonSchema,
    internalNote: AdminInternalNoteSchema,
    receivedAt: ListingHideReceivedAtSchema,
    sourceUrl: HttpsUrlSchema.nullable().optional(),
  })
  .superRefine((body, ctx) => {
    if (body.kind === 'complaint_under_review' && !body.sourceUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['sourceUrl'],
        message: 'A complaint under review needs the link to the public source.',
      });
    }
  });
export type AdminListingHideBody = z.infer<typeof AdminListingHideBodySchema>;

/** `POST /api/admin/{vendors,products}/:id/restore`: the vendor-visible reason and an
 *  optional internal note, the §11d.2 pair. */
export const AdminListingRestoreBodySchema = AdminOverrideReasonSchema;
export type AdminListingRestoreBody = z.infer<typeof AdminListingRestoreBodySchema>;

/** One `listing_hides` row, as the operator sees it. The internal note is here; it
 *  never reaches a vendor or a public read. */
export const AdminListingHideSchema = z.object({
  id: z.string().uuid(),
  entity_type: ListingHideEntityTypeSchema,
  entity_id: z.string(),
  /** The company hide this product row cascaded from, or `null` for a direct hide. */
  parent_id: z.string().nullable(),
  kind: ListingHideKindSchema,
  reason: z.string(),
  internal_note: z.string().nullable(),
  received_at: z.string(),
  source_url: z.string().nullable(),
  set_by: z.string().nullable(),
  set_at: z.string(),
  restored_by: z.string().nullable(),
  restored_at: z.string().nullable(),
  restore_reason: z.string().nullable(),
});
export type AdminListingHide = z.infer<typeof AdminListingHideSchema>;

/** One product of a company, as the "Listing visibility" confirm step lists it. */
export const AdminListingHideProductSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  hidden_at: z.string().nullable(),
  /** `true` when the product's active hide is its company's (a child row). */
  hidden_with_vendor: z.boolean(),
});
export type AdminListingHideProduct = z.infer<typeof AdminListingHideProductSchema>;

/** What a hide or restore answers. */
export const AdminListingHideResponseSchema = z.object({
  entity_type: ListingHideEntityTypeSchema,
  entity_id: z.string(),
  hidden_at: z.string().nullable(),
  /** The active hide after the write: the new row on a hide, `null` after a restore. */
  hide: AdminListingHideSchema.nullable(),
  /** A company write: the products it hid (a hide) or re-showed (a restore). */
  product_ids: z.array(z.string()),
});
export type AdminListingHideResponse = z.infer<typeof AdminListingHideResponseSchema>;

/**
 * The hide state a vendor sees on its own records (`GET /api/vendor/me`,
 * `VendorProduct`). The reason is the vendor-visible one. The internal note is never
 * here. `null` while the record is on the public site.
 */
export const VendorListingHiddenSchema = z.object({
  at: z.string(),
  kind: ListingHideKindSchema,
  reason: z.string(),
});
export type VendorListingHidden = z.infer<typeof VendorListingHiddenSchema>;
