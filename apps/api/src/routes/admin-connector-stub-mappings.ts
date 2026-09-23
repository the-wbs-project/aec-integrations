/**
 * AECi-side mapping authoring (AECI-724 — `docs/ADMIN_PANEL_SPEC.md` §5.9).
 *
 *   PATCH /api/admin/connector-stub-mappings/:id — behind `requireAdmin()`.
 *
 * Edits one `connector_stub_mappings` row's product pointer and depth fields, and only on
 * a `vendor`-managed catalogue: any other catalogue is **409 `CATALOG_REVIEW_MANAGED`**,
 * because the review-app sync would overwrite the edit on its next page. The gate, the
 * validation, the batch and the purge set are `lib/connector-mapping-edit.ts`, shared
 * with the vendor seat's route so the two actors cannot diverge.
 *
 * Order: 404 (unknown id) → 409 (not vendor-managed) → body (400 / 422) → conflicts
 * (409 `MAPPING_CONFLICT`) → one `db.batch` with the audit row → post-commit purge and
 * forward. No `workflow_instances` row (that CHECK is closed; `audit_log` is the
 * ledger, as for AECI-720's flip) and no `rateLimit()`, like every `requireAdmin()`
 * write (`waf-rate-limits.md` §6.2).
 */

import {
  CONNECTOR_OPERATOR_DECIDER,
  ConnectorStubMappingEditResponseSchema,
  UpdateConnectorStubMappingSchema,
} from '@aeci/shared';

import { getDb } from '../db/client';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditActorType } from '../lib/authz';
import {
  applyMappingEdit,
  assertVendorManaged,
  loadMappingForEdit,
  mappingNotFound,
} from '../lib/connector-mapping-edit';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { afterVendorWrite, parseJsonBody, type VendorContext } from './vendor-shared';

/** The audit `source` facet and forward tag. */
export const ADMIN_MAPPING_AUDIT_SOURCE = 'admin-connector-mapping';

export function createAdminUpdateConnectorStubMappingHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing mapping id', { field: 'id' });
    }
    const { db } = writeDb(c, dbFor);

    const target = await loadMappingForEdit(db, id);
    if (!target) throw mappingNotFound(id);
    assertVendorManaged(target);

    const input = await parseJsonBody(c, UpdateConnectorStubMappingSchema);
    const result = await applyMappingEdit(db, target, input, {
      userId: session.userId,
      actorType: auditActorType(session),
      decidedBy: CONNECTOR_OPERATOR_DECIDER,
      auditSource: ADMIN_MAPPING_AUDIT_SOURCE,
    });

    if (result.auditEntries.length > 0) {
      afterVendorWrite(c, result.purgeTags, result.auditEntries, undefined, undefined, {
        auditSource: ADMIN_MAPPING_AUDIT_SOURCE,
        purgeSource: 'moderation',
      });
    }

    validateResponseInDev(c.env, () => {
      ConnectorStubMappingEditResponseSchema.parse(result.response);
    });
    return json(result.response);
  };
}
