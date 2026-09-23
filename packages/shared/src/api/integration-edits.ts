import { z } from 'zod';

import {
  CONTEST_VALUE_MAX_LENGTH,
  INTEGRATION_CONTEST_FIELDS,
  contestValueProblem,
  type IntegrationContestField,
} from './integration-contests';
import { IntegrationMechanismKindSchema, type IntegrationMechanismKind } from './integrations';

/**
 * Owner edits of an integration's standard fields (AECI-1006 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6).
 *
 *   PATCH /api/vendor/integrations/:id — the owner edits its claimed row (200).
 *
 * Five rules the shapes encode:
 *
 * 1. **The standard fields are the contestable content fields.** AECI-1008 named
 *    them: the eleven `integrations` columns a non-owner may contest. The owner
 *    edits exactly those. `owner` is not here (reassigning the owner is AECi's
 *    decision, through an `owner` contest), and neither is `notes`, which is
 *    AECi's own curation column and is not contestable either (§11b.3).
 * 2. **Only a claimed owner edits.** The server compares the session's vendor with
 *    `built_by_vendor_id` and requires `claimed_at`. An owner that has not claimed
 *    gets `409 INTEGRATION_NOT_CLAIMED`. Nothing in the body says who owns what.
 * 3. **A PATCH carries only what changes.** An omitted field is untouched. `null`
 *    clears a field, except `name`, `mechanism_kind` and `direction`, which a
 *    pair page needs. A field sent with its current value is dropped, and a body
 *    that changes nothing writes nothing at all.
 * 4. **`direction` is caller-relative on the wire, canonical in the DB**, framed
 *    against `context_product_id`, exactly as contests and claims frame it.
 * 5. **No edit may make the row connector-powered.** An owner cannot type an
 *    ordinary row into that state, where only an entitled owner could write it
 *    again (AECI-1003 decision 9, carved open by AECI-1040). `iPaaS` and
 *    `integrator` are refused.
 * 6. **No edit may move a connector-powered row out of that state either**
 *    (AECI-1090, AECI-1040 ruling 5). On a connector-powered row the owner edits
 *    {@link CONNECTOR_POWERED_EDIT_FIELDS}: every field but `mechanism_kind`,
 *    which decides the row's lane. A `connector_evidenced_pairs` row has no such
 *    column at all, so the same ten fields are its whole edit set.
 *
 * i18n note: framework-agnostic package (no `$localize`). The messages below are
 * for API consumers and logs; the portal renders its own copy.
 */

/** The eleven fields an owner edits: every contestable field except `owner`. */
export const INTEGRATION_EDIT_FIELDS = INTEGRATION_CONTEST_FIELDS.filter(
  (field): field is Exclude<IntegrationContestField, 'owner'> => field !== 'owner',
);
export type IntegrationEditField = Exclude<IntegrationContestField, 'owner'>;

/**
 * The fields an owner edits on a connector-powered row (AECI-1090 / AECI-1040
 * ruling 5 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6): every standard field except
 * the frozen ones in {@link CONNECTOR_POWERED_FROZEN_EDIT_FIELDS}. It is the whole
 * edit set of a `connector_evidenced_pairs` row, which has no `mechanism_kind`
 * column, and the edit set of a connector-powered `integrations` row, whose
 * `mechanism_kind` is frozen.
 */
export const CONNECTOR_POWERED_FROZEN_EDIT_FIELDS: ReadonlySet<IntegrationEditField> =
  new Set<IntegrationEditField>(['mechanism_kind']);
export const CONNECTOR_POWERED_EDIT_FIELDS: readonly IntegrationEditField[] =
  INTEGRATION_EDIT_FIELDS.filter((field) => !CONNECTOR_POWERED_FROZEN_EDIT_FIELDS.has(field));

/** The fields a pair page cannot render without, so an edit may change but never
 *  clear them. */
export const INTEGRATION_EDIT_REQUIRED_FIELDS: ReadonlySet<IntegrationEditField> =
  new Set<IntegrationEditField>(['name', 'mechanism_kind', 'direction']);

/**
 * The `mechanism_kind` values that mean a third party delivers the connection.
 *
 * The API Worker's `isConnectorPoweredEdge` (`apps/api/src/lib/connector-powered.ts`)
 * is the authority; this list is its kind disjunct, copied so the portal can leave
 * the two values out of its picker. `integration-edits.spec.ts` in the API Worker
 * asserts the two agree for every value of the enum, so the copy cannot drift.
 */
export const CONNECTOR_DELIVERED_MECHANISM_KINDS: ReadonlySet<IntegrationMechanismKind> =
  new Set<IntegrationMechanismKind>(['iPaaS', 'integrator']);

/** The `mechanism_kind` values an owner may choose, in enum order. */
export const OWNER_EDITABLE_MECHANISM_KINDS: readonly IntegrationMechanismKind[] =
  IntegrationMechanismKindSchema.options.filter(
    (kind) => !CONNECTOR_DELIVERED_MECHANISM_KINDS.has(kind),
  );

/**
 * Why `value` cannot be saved into `field`, or `null` when it can.
 *
 * `value` is the WIRE form (`direction` caller-relative). It reuses the contest
 * rule for everything a contest also checks (lengths, `http(s)` URLs, the two
 * enums) and adds the two rules only an edit has: clearing a required field, and
 * choosing a connector-delivered kind.
 */
export function integrationEditValueProblem(
  field: IntegrationEditField,
  value: string | null,
): string | null {
  if (value === null) {
    return INTEGRATION_EDIT_REQUIRED_FIELDS.has(field) ? 'This field cannot be cleared' : null;
  }
  const problem = contestValueProblem(field, value);
  if (problem) return problem;
  if (
    field === 'mechanism_kind' &&
    CONNECTOR_DELIVERED_MECHANISM_KINDS.has(value as IntegrationMechanismKind)
  ) {
    return 'A connector-delivered integration type cannot be set here';
  }
  return null;
}

/** One field on the PATCH: trimmed, capped, `null` to clear, omitted to leave. An
 *  empty string after trimming means "clear", like `null`. Exported for the
 *  AECI-1011 create body, which takes the same eleven fields with the same caps. */
export function integrationEditFieldSchema(field: IntegrationEditField) {
  return z
    .string()
    .trim()
    .max(CONTEST_VALUE_MAX_LENGTH[field])
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();
}

/**
 * `PATCH /api/vendor/integrations/:id`.
 *
 * `.strict()`: an unknown key, `owner`, `notes` and `built_by_vendor_id` included,
 * is a `400` rather than a silently dropped field. At least one field is required.
 * `context_product_id` frames `direction`; it must be one of the integration's two
 * endpoint products, and omitted means the caller's own endpoint (source first).
 */
export const UpdateVendorIntegrationSchema = z
  .object({
    name: integrationEditFieldSchema('name'),
    mechanism_kind: integrationEditFieldSchema('mechanism_kind'),
    mechanism_name: integrationEditFieldSchema('mechanism_name'),
    direction: integrationEditFieldSchema('direction'),
    description: integrationEditFieldSchema('description'),
    listing_url: integrationEditFieldSchema('listing_url'),
    docs_url: integrationEditFieldSchema('docs_url'),
    website: integrationEditFieldSchema('website'),
    mechanism_url: integrationEditFieldSchema('mechanism_url'),
    pricing_model: integrationEditFieldSchema('pricing_model'),
    maturity: integrationEditFieldSchema('maturity'),
    context_product_id: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => INTEGRATION_EDIT_FIELDS.some((field) => body[field] !== undefined), {
    message: 'Send at least one field to change',
  });
export type UpdateVendorIntegrationInput = z.input<typeof UpdateVendorIntegrationSchema>;
export type UpdateVendorIntegrationParsed = z.output<typeof UpdateVendorIntegrationSchema>;

/** The row as the edit left it. Timestamps are ISO-8601. */
export const UpdatedVendorIntegrationSchema = z.object({
  id: z.string().uuid(),
  /** The fields this request actually changed, in {@link INTEGRATION_EDIT_FIELDS}
   *  order. Empty when every sent value equalled the one on record, in which case
   *  nothing was written. */
  changed: z.array(
    z.enum(INTEGRATION_EDIT_FIELDS as [IntegrationEditField, ...IntegrationEditField[]]),
  ),
  /** `'vendor'` after any real change (§13.9's maintenance transfer). */
  maintained_by: z.enum(['aeci', 'vendor']),
  last_reviewed_at: z.string().nullable(),
  updated_at: z.string(),
});
export type UpdatedVendorIntegration = z.infer<typeof UpdatedVendorIntegrationSchema>;

export const UpdateVendorIntegrationResponseSchema = z.object({
  integration: UpdatedVendorIntegrationSchema,
});
export type UpdateVendorIntegrationResponse = z.infer<typeof UpdateVendorIntegrationResponseSchema>;

/**
 * One edit event addressed to this vendor (`kind: 'integration_update'`) on
 * `GET /api/vendor/notifications`.
 *
 * Written in the SAME batch as the edit, as a `notification.sent` audit row, to
 * every vendor of either endpoint product other than the owner. Vendor edits go
 * live with no moderation (decision 8), so this is how the other side learns its
 * product's integration changed, and a contest is its recourse.
 */
export const VendorIntegrationUpdateNotificationSchema = z.object({
  kind: z.literal('integration_update'),
  id: z.string().uuid(),
  integration_id: z.string().uuid(),
  integration_name: z.string().nullable(),
  /** The owner that edited it, by name as it was at edit time. */
  owner_name: z.string().nullable(),
  /** The changed fields. Plain strings: a snapshot that may predate a vocabulary
   *  change renders as-is rather than failing the whole feed. */
  fields: z.array(z.string()),
  pair_path: z.string().nullable(),
  created_at: z.string(),
});
export type VendorIntegrationUpdateNotification = z.infer<
  typeof VendorIntegrationUpdateNotificationSchema
>;
