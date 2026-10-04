import { z } from 'zod';

import { AdminInternalNoteSchema, AdminReasonSchema } from './admin-reason';
import {
  CONNECTOR_POWERED_EDIT_FIELDS,
  INTEGRATION_EDIT_FIELDS,
  integrationEditValueProblem,
  type IntegrationEditField,
} from './integration-edits';
import { UpdateVendorProductSchema, UpdateVendorProfileSchema } from './vendor';

/**
 * AECi field corrections with a lock (AECI-1237, ADR 0039,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5).
 *
 * An AECi admin corrects one factual field on a record a vendor holds, and the
 * correction is LOCKED: a later vendor write to that field answers
 * `409 FIELD_LOCKED_BY_AECI` until an admin lifts the lock. One lock row per
 * (entity, field) in `field_overrides`; lifting keeps the row as history.
 *
 * Four rules the shapes here encode:
 *
 * 1. **Factual fields only.** The allow-list is cut from what the vendor PATCH
 *    routes accept. Left out: the logo (its own admin path, ADR 0032), "How teams
 *    use it" (ADR 0033), the company and product descriptions (marketing copy, not a
 *    fact; a takedown is AECI-1238), the four taxonomy facets (join rewrites over
 *    AECi's own vocabulary) and every name (a rename is a correction request).
 * 2. **The value passes the vendor's own rule for the field.** The vendor PATCH
 *    schema for a company or product field, `integrationEditValueProblem` for an
 *    integration field. AECi cannot store a value the vendor could not.
 * 3. **`direction` is the stored frame** (`a_to_b`, `b_to_a`, `both`). An admin has
 *    no caller product to frame it against.
 * 4. **The reason is the vendor's to read**, the internal note never is
 *    (`AdminOverrideReasonSchema`, AECI-1159).
 *
 * i18n note: framework-agnostic package (no `$localize`). The admin panel and the
 * portal render their own copy.
 */

/** `field_overrides.entity_type`: promote's entity vocabulary. */
export const FIELD_OVERRIDE_ENTITY_TYPES = [
  'vendor',
  'product',
  'integration',
  'connector_evidenced_pair',
] as const;
export type FieldOverrideEntityType = (typeof FIELD_OVERRIDE_ENTITY_TYPES)[number];
export const FieldOverrideEntityTypeSchema = z.enum(FIELD_OVERRIDE_ENTITY_TYPES);

/** The company fields AECi may correct: the vendor PATCH set minus the description
 *  and the logo. */
export const VENDOR_OVERRIDE_FIELDS = [
  'website',
  'headquarters',
  'founded_year',
  'public_private',
  'parent_company',
  'contact_email',
  'phone_number',
  'linkedin_url',
  'x_url',
  'facebook_url',
  'instagram_url',
  'youtube_url',
  'crunchbase_url',
  'wiki_url',
  'github_org',
] as const;
export type VendorOverrideField = (typeof VENDOR_OVERRIDE_FIELDS)[number];

/** The product fields AECi may correct: the three links. */
export const PRODUCT_OVERRIDE_FIELDS = [
  'website',
  'tool_integrations_url',
  'api_docs_url',
] as const;
export type ProductOverrideField = (typeof PRODUCT_OVERRIDE_FIELDS)[number];

/** Every field name that can carry a lock, across the four entity types. */
export type FieldOverrideField = VendorOverrideField | ProductOverrideField | IntegrationEditField;

/** The stored canonical directions an admin may set (rule 3). */
export const STORED_DIRECTIONS = ['a_to_b', 'b_to_a', 'both'] as const;
export type StoredDirection = (typeof STORED_DIRECTIONS)[number];

/**
 * The fields AECi may lock on one entity type. On a connector-powered
 * `integrations` row pass `connectorPowered`: its `mechanism_kind` is frozen
 * (AECI-1040 ruling 5), so it is not offered. An evidenced pair has no such column.
 */
export function fieldOverrideFieldsFor(
  entityType: FieldOverrideEntityType,
  opts: { connectorPowered?: boolean } = {},
): readonly FieldOverrideField[] {
  switch (entityType) {
    case 'vendor':
      return VENDOR_OVERRIDE_FIELDS;
    case 'product':
      return PRODUCT_OVERRIDE_FIELDS;
    case 'integration':
      return opts.connectorPowered ? CONNECTOR_POWERED_EDIT_FIELDS : INTEGRATION_EDIT_FIELDS;
    case 'connector_evidenced_pair':
      return CONNECTOR_POWERED_EDIT_FIELDS;
  }
}

/** Whether `field` may carry a lock on `entityType` (rule 1). */
export function isFieldOverrideField(
  entityType: FieldOverrideEntityType,
  field: string,
  opts: { connectorPowered?: boolean } = {},
): field is FieldOverrideField {
  return (fieldOverrideFieldsFor(entityType, opts) as readonly string[]).includes(field);
}

/** A locked value: text, the founded year, or `null` for a cleared field. */
export type FieldOverrideValue = string | number | null;
export const FieldOverrideValueSchema = z.union([z.string().max(2048), z.number(), z.null()]);

/**
 * The value as it will be stored, or the reason it cannot be (rules 2 and 3). The
 * caller has already checked the field with {@link isFieldOverrideField}.
 */
export function parseFieldOverrideValue(
  entityType: FieldOverrideEntityType,
  field: FieldOverrideField,
  value: FieldOverrideValue,
): { ok: true; value: FieldOverrideValue } | { ok: false; problem: string } {
  if (entityType === 'vendor' || entityType === 'product') {
    const schema =
      entityType === 'vendor'
        ? UpdateVendorProfileSchema.shape[field as VendorOverrideField]
        : UpdateVendorProductSchema.shape[field as ProductOverrideField];
    const normalized = typeof value === 'string' && value.trim() === '' ? null : value;
    const parsed = schema.safeParse(normalized);
    if (!parsed.success) return { ok: false, problem: 'This value is not valid for this field' };
    return { ok: true, value: (parsed.data ?? null) as FieldOverrideValue };
  }
  if (typeof value === 'number') return { ok: false, problem: 'This field takes text' };
  const text = value === null ? null : value.trim() === '' ? null : value.trim();
  const editField = field as IntegrationEditField;
  if (editField === 'direction') {
    return text !== null && (STORED_DIRECTIONS as readonly string[]).includes(text)
      ? { ok: true, value: text }
      : { ok: false, problem: `Direction must be one of: ${STORED_DIRECTIONS.join(', ')}` };
  }
  const problem = integrationEditValueProblem(editField, text);
  return problem ? { ok: false, problem } : { ok: true, value: text };
}

// ─── Admin writes ────────────────────────────────────────────────────────────

/**
 * `POST /api/admin/field-overrides`. The field must be on the entity type's
 * allow-list. Whether the value is valid, and on a connector-powered row whether
 * the field is frozen, the handler decides, so a refusal names `value` or `field`.
 */
export const AdminSetFieldOverrideSchema = z
  .object({
    entityType: FieldOverrideEntityTypeSchema,
    entityId: z.string().uuid(),
    field: z.string().min(1).max(64),
    value: FieldOverrideValueSchema,
    reason: AdminReasonSchema,
    internalNote: AdminInternalNoteSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (!isFieldOverrideField(body.entityType, body.field)) {
      ctx.addIssue({
        code: 'custom',
        path: ['field'],
        message: 'AEC Integrations cannot correct this field on this record',
      });
    }
  });
export type AdminSetFieldOverrideInput = z.input<typeof AdminSetFieldOverrideSchema>;

/** `POST /api/admin/field-overrides/:id/lift`: the vendor reason and the note. */
export const AdminLiftFieldOverrideSchema = z
  .object({ reason: AdminReasonSchema, internalNote: AdminInternalNoteSchema })
  .strict();
export type AdminLiftFieldOverrideInput = z.input<typeof AdminLiftFieldOverrideSchema>;

/** One lock, as the admin panel reads it. Both reasons and the note are here. */
export const AdminFieldOverrideSchema = z.object({
  id: z.string().uuid(),
  entity_type: FieldOverrideEntityTypeSchema,
  entity_id: z.string().uuid(),
  /** The record's name when it was read, for the list. `null` when it is gone. */
  entity_name: z.string().nullable(),
  field: z.string(),
  value: FieldOverrideValueSchema,
  reason: z.string(),
  internal_note: z.string().nullable(),
  vendor_id: z.string().nullable(),
  set_by: z.string().nullable(),
  set_at: z.string(),
  lifted_by: z.string().nullable(),
  lifted_at: z.string().nullable(),
  lift_reason: z.string().nullable(),
});
export type AdminFieldOverride = z.infer<typeof AdminFieldOverrideSchema>;

/** `POST /api/admin/field-overrides` and `…/:id/lift` echo the lock row. */
export const AdminFieldOverrideResponseSchema = z.object({ override: AdminFieldOverrideSchema });
export type AdminFieldOverrideResponse = z.infer<typeof AdminFieldOverrideResponseSchema>;

/** `GET /api/admin/vendors/:id/field-overrides`: every unlifted lock on the vendor,
 *  its products and the integrations it owns, newest first. */
export const AdminFieldOverridesResponseSchema = z.object({
  overrides: z.array(AdminFieldOverrideSchema),
});
export type AdminFieldOverridesResponse = z.infer<typeof AdminFieldOverridesResponseSchema>;

// The vendor read shapes (`locked_fields`) live in `./locked-fields`, a leaf module,
// because `./vendor` imports them and this module imports `./vendor`.
export * from './locked-fields';
