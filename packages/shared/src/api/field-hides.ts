import { z } from 'zod';

import { AdminInternalNoteSchema, AdminReasonSchema } from './admin-reason';
import {
  FieldOverrideEntityTypeSchema,
  PRODUCT_COLUMN_OVERRIDE_FIELDS,
  VENDOR_OVERRIDE_FIELDS,
  type FieldOverrideEntityType,
} from './field-overrides';
import { HttpsUrlSchema } from './https-url';
import {
  CONNECTOR_POWERED_EDIT_FIELDS,
  INTEGRATION_EDIT_FIELDS,
  INTEGRATION_EDIT_REQUIRED_FIELDS,
} from './integration-edits';
import { ListingHideReceivedAtSchema } from './listing-hides';

/**
 * The single-value hide, "under review" (AECI-1238 section B, ADR 0052 amendment,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.7).
 *
 * AECi receives a public source saying one value on a vendor-held record is wrong. It
 * hides that value within two business days while it checks, and decides within five.
 * The public page shows the field blank with an "Under review" marker. Hiding is an
 * interim step while AECi verifies. It is not a finding that the value is false.
 *
 * Rules the shapes here encode:
 *
 * 1. **The fields.** The AECI-1237 lockable fields plus `description` on a company and a
 *    product, MINUS what a public page cannot render blank: the four product taxonomy
 *    facets (a facet also decides browse, taxonomy and search membership) and the three
 *    required integration fields (`name`, `mechanism_kind`, `direction`).
 * 2. **Vendor-held records only.** The §11d.5 held test. The handler decides it.
 * 3. **A source and a received date on every hide.** The clocks run from `receivedAt`.
 * 4. **The reason is the vendor's to read**, the note never is. Neither, nor the source,
 *    is ever public: the public read carries only the field names (`under_review`).
 * 5. **Three ways out.** An admin restore (the value stands), an AECi correction of the
 *    field (`clear_kind: 'corrected'`), or the vendor's own edit that changes the field
 *    (`clear_kind: 'vendor_edit'`). The field stays editable while hidden.
 *
 * i18n note: framework-agnostic package (no `$localize`). The pages render their own copy.
 */

/** `field_hides.entity_type`: the same vocabulary as `field_overrides`. */
export const FIELD_HIDE_ENTITY_TYPES = FieldOverrideEntityTypeSchema.options;
export type FieldHideEntityType = FieldOverrideEntityType;
export const FieldHideEntityTypeSchema = FieldOverrideEntityTypeSchema;

/** Business days from `received_at` by which AECi hides the value (policy). */
export const FIELD_HIDE_DUE_BUSINESS_DAYS = 2;
/** Business days from `received_at` by which AECi decides, or sends a status reply. */
export const FIELD_HIDE_DECIDE_BUSINESS_DAYS = 5;

/** The company fields AECi may hide: every lockable field, plus the description. */
export const VENDOR_HIDE_FIELDS = [...VENDOR_OVERRIDE_FIELDS, 'description'] as const;
export type VendorHideField = (typeof VENDOR_HIDE_FIELDS)[number];

/** The product fields AECi may hide: the three links, plus the description. */
export const PRODUCT_HIDE_FIELDS = [...PRODUCT_COLUMN_OVERRIDE_FIELDS, 'description'] as const;
export type ProductHideField = (typeof PRODUCT_HIDE_FIELDS)[number];

/** The integration fields AECi may hide: the owner-edit set minus the required three. */
export const INTEGRATION_HIDE_FIELDS = INTEGRATION_EDIT_FIELDS.filter(
  (field) => !INTEGRATION_EDIT_REQUIRED_FIELDS.has(field),
);

/** The same on an evidenced pair, or a connector-powered row. */
export const CONNECTOR_POWERED_HIDE_FIELDS = CONNECTOR_POWERED_EDIT_FIELDS.filter(
  (field) => !INTEGRATION_EDIT_REQUIRED_FIELDS.has(field),
);

/** The fields AECi may hide on one entity type (rule 1). */
export function fieldHideFieldsFor(entityType: FieldHideEntityType): readonly string[] {
  switch (entityType) {
    case 'vendor':
      return VENDOR_HIDE_FIELDS;
    case 'product':
      return PRODUCT_HIDE_FIELDS;
    case 'integration':
      return INTEGRATION_HIDE_FIELDS;
    case 'connector_evidenced_pair':
      return CONNECTOR_POWERED_HIDE_FIELDS;
  }
}

/** Whether `field` may be hidden on `entityType`. */
export function isFieldHideField(entityType: FieldHideEntityType, field: string): boolean {
  return fieldHideFieldsFor(entityType).includes(field);
}

/** `field_hides.clear_kind`. */
export const FIELD_HIDE_CLEAR_KINDS = ['restored', 'corrected', 'vendor_edit'] as const;
export const FieldHideClearKindSchema = z.enum(FIELD_HIDE_CLEAR_KINDS);
export type FieldHideClearKind = z.infer<typeof FieldHideClearKindSchema>;

// ─── Admin writes ────────────────────────────────────────────────────────────

/** `POST /api/admin/field-hides`. */
export const AdminSetFieldHideSchema = z
  .object({
    entityType: FieldHideEntityTypeSchema,
    entityId: z.string().uuid(),
    field: z.string().min(1).max(64),
    sourceUrl: HttpsUrlSchema,
    receivedAt: ListingHideReceivedAtSchema,
    reason: AdminReasonSchema,
    internalNote: AdminInternalNoteSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!isFieldHideField(body.entityType, body.field)) {
      ctx.addIssue({
        code: 'custom',
        path: ['field'],
        message: 'AEC Integrations cannot hide this field on this record',
      });
    }
  });
export type AdminSetFieldHideInput = z.input<typeof AdminSetFieldHideSchema>;

/** `POST /api/admin/field-hides/:id/restore`: the vendor-visible reason. */
export const AdminRestoreFieldHideSchema = z.object({ reason: AdminReasonSchema }).strict();
export type AdminRestoreFieldHideInput = z.input<typeof AdminRestoreFieldHideSchema>;

/** `POST /api/admin/field-hides/:id/status-reply`: what AECi told the requester. */
export const AdminFieldHideStatusReplySchema = z.object({ note: AdminReasonSchema }).strict();
export type AdminFieldHideStatusReplyInput = z.input<typeof AdminFieldHideStatusReplySchema>;

/** One status reply, as the admin list shows the latest. */
export const AdminFieldHideStatusReplyEntrySchema = z.object({
  note: z.string(),
  at: z.string(),
  by: z.string().nullable(),
});
export type AdminFieldHideStatusReplyEntry = z.infer<typeof AdminFieldHideStatusReplyEntrySchema>;

/** One hide, as the admin panel reads it. The reason, note and source are here. */
export const AdminFieldHideSchema = z.object({
  id: z.string().uuid(),
  entity_type: FieldHideEntityTypeSchema,
  entity_id: z.string().uuid(),
  /** The record's name when it was read. `null` when it is gone. */
  entity_name: z.string().nullable(),
  field: z.string(),
  reason: z.string(),
  internal_note: z.string().nullable(),
  source_url: z.string(),
  received_at: z.string(),
  vendor_id: z.string().nullable(),
  set_by: z.string().nullable(),
  set_at: z.string(),
  cleared_by: z.string().nullable(),
  cleared_at: z.string().nullable(),
  clear_kind: FieldHideClearKindSchema.nullable(),
  clear_reason: z.string().nullable(),
  /** The instant the two-business-day hide window ends (`businessWindowEnd`). */
  hide_due: z.string(),
  /** The instant the five-business-day decision window ends. */
  decide_due: z.string(),
  /** The latest recorded status reply, or `null`. */
  last_status_reply: AdminFieldHideStatusReplyEntrySchema.nullable(),
});
export type AdminFieldHide = z.infer<typeof AdminFieldHideSchema>;

/** `POST /api/admin/field-hides`, `…/:id/restore` and `…/:id/status-reply` echo the row. */
export const AdminFieldHideResponseSchema = z.object({ hide: AdminFieldHideSchema });
export type AdminFieldHideResponse = z.infer<typeof AdminFieldHideResponseSchema>;

/** `GET /api/admin/vendors/:id/field-hides`: every active hide on the vendor, its
 *  products and the integrations it owns, newest first. */
export const AdminFieldHidesResponseSchema = z.object({ hides: z.array(AdminFieldHideSchema) });
export type AdminFieldHidesResponse = z.infer<typeof AdminFieldHidesResponseSchema>;

// The vendor read shape (`hidden_fields`) and the public `under_review` list live in
// `./hidden-fields`, a leaf module, because `./vendor` and the public shapes import them.
export * from './hidden-fields';
