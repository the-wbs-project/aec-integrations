import { z } from 'zod';

import {
  AdminConnectorMappingSchema,
  ConnectorMappingConfidenceSchema,
  ConnectorMappingStatusSchema,
} from './admin-connectors';
import { HttpsUrlSchema } from './https-url';

/**
 * Mapping authoring on a VENDOR-MANAGED connector catalogue (AECI-724 —
 * `docs/ADMIN_PANEL_SPEC.md` §5.9, `docs/STAGE_2_SPEC.md` §8.9(1)–(2)).
 *
 *   PATCH /api/admin/connector-stub-mappings/:id  — behind `requireAdmin()`
 *   PATCH /api/vendor/connector-stub-mappings/:id — behind `requireVendor()`, for the
 *     seat holder of the vendor that owns the catalogue's connector-role product
 *
 * Both take this body. The admin route returns {@link ConnectorStubMappingEditResponseSchema};
 * the seat's route returns the vendor-shaped twin in `vendor-connector-catalog.ts`
 * (AECI-1127), which drops the curation `notes` and ships `decided_by` as a kind.
 *
 * ── THE GATE IS `managed_by = 'vendor'` ─────────────────────────────────────
 * The review-app sync upserts `connector_stub_mappings` wholesale, so on a
 * `review`-managed catalogue an edit here is exactly the row the next page would
 * overwrite. A `vendor`-managed catalogue has the promote lane frozen (AECI-720's
 * `CATALOG_VENDOR_MANAGED`), which is the one state in which this row is safe. Any
 * other catalogue is refused with **409 `CATALOG_REVIEW_MANAGED`**. The two gates are
 * exact complements, so the promote lane and this endpoint never write the same row.
 *
 * ── WHAT IS EDITABLE ────────────────────────────────────────────────────────
 * The product pointer and the depth of the assertion, nothing else:
 *
 *   - `productId` + `status` — the pointer. They move together because of §9a.4's
 *     two-column invariant: `mapped` / `ruled_out` name a product, the three decision
 *     statuses name none. The MERGED row must satisfy it (422 otherwise).
 *   - `confidence`, `evidenceUrl` — how strongly and on what evidence.
 *
 * `decided_by`, `decided_at` and `checked_at` are stamped by the server, never sent:
 * whoever edits the row now stands behind it. `notes`, `stub_id` and `catalog_id` are
 * not writable here. `catalog_id` is a denormalised copy of the stub's catalogue.
 *
 * `.strict()`, so a caller cannot name a server-stamped column and have it silently
 * dropped. At least one field must be present.
 */
export const UpdateConnectorStubMappingSchema = z
  .object({
    status: ConnectorMappingStatusSchema.optional(),
    /** `null` clears the pointer. Required to be `null` on a decision status. */
    productId: z.string().uuid().nullable().optional(),
    confidence: ConnectorMappingConfidenceSchema.nullable().optional(),
    evidenceUrl: HttpsUrlSchema.nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Name at least one field to change.',
  });
export type UpdateConnectorStubMappingInput = z.infer<typeof UpdateConnectorStubMappingSchema>;

/**
 * The admin route's answer: the row after the edit, in the admin triage row's own
 * shape so the screen can replace it in place. The seat's route does NOT use this. `changed: false` is the 200 no-op: a body that matches the
 * stored row writes nothing, including no `audit_log` row.
 */
export const ConnectorStubMappingEditResponseSchema = z.object({
  catalog_id: z.string().min(1),
  stub_id: z.string().min(1),
  mapping: AdminConnectorMappingSchema,
  changed: z.boolean(),
});
export type ConnectorStubMappingEditResponse = z.infer<
  typeof ConnectorStubMappingEditResponseSchema
>;

/**
 * The `decided_by` value an AECi-side edit stamps. Never `auto-name-match`, so an
 * edited `mapped` row clears §9a.4's provenance gate. The audit row carries the exact
 * user id; this column carries who stands behind the row, in a form a reader of the
 * triage table can tell apart from a review-app reviewer's name.
 */
export const CONNECTOR_OPERATOR_DECIDER = 'aeci-operator';
export const connectorVendorDecider = (vendorSlug: string): string => `vendor:${vendorSlug}`;
