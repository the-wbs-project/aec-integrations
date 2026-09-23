/**
 * The gate every OWNER write on an integration shares (AECI-1006 / ADR 0035 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.6): who may write, in what order the
 * refusals are asked, and the in-batch race guard.
 *
 * AECI-1005's claim is the owner's first write and asks "may I take this row?".
 * Every later owner write (1006 edit, 1010 retire) asks the same question plus one
 * more: "have I taken it?". The refusal order is the claim's, with that one step
 * added last:
 *
 *   1. an unknown id, or a row the caller neither owns nor has an endpoint on → 404
 *      (a non-owner must not learn the row exists);
 *   2. an endpoint vendor that is not the owner → 403 `INTEGRATION_NOT_OWNER`,
 *      or 409 `INTEGRATION_OWNER_UNKNOWN` when nobody is on file;
 *   3. the owner of a connector-powered row whose vendor holds no active
 *      entitlement → 403 `INTEGRATION_ENTITLEMENT_REQUIRED` (AECI-1090, the
 *      AECI-1040 carve-out to decision 9 and its ruling 2). Until AECI-1090 this
 *      step refused every connector-powered row with `INTEGRATION_CONNECTOR_POWERED`.
 *      An entitled owner passes on to the same steps as any other owner, and the
 *      edit handler then freezes `mechanism_kind` (ruling 5);
 *   4. the owner of an unclaimed row → 409 `INTEGRATION_NOT_CLAIMED`. Claiming is
 *      the act that fences promote, so an unclaimed row is still AECi's to write
 *      and an edit here would be overwritten by the next promote;
 *   5. the owner of a RETIRED row → 409 `INTEGRATION_RETIRED` (AECI-1010), the same
 *      answer every other vendor write on a retired row gets. Restore first.
 *
 * The AECI-1010 retire and restore keep their own copy of steps 1-4
 * (`refusalFor` in `routes/vendor-integration-retire.ts`), because restore is the
 * one owner write that must reach a retired row. So this gate is the edit's.
 *
 * There is no capability step. A seat is the whole gate (AECI-1003 decision 15)
 * except on a connector-powered row, where step 3 is the named entitlement
 * exception (`lib/integration-entitlement.ts`).
 *
 * `connector_evidenced_pairs` rows (AECI-1090) take the same steps through
 * {@link evidencedOwnerWriteRefusal}: every such row is connector-powered by
 * construction, so step 3 always applies there.
 */

import { ApiErrorCode, orderedPairSlugs } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations, productVendors, products } from '../db/schema';
import { ApiError, notFoundError } from '../errors';

import { NOTIFICATION_SENT_ACTION } from './attestation-notify';
import { isConnectorPoweredEdge } from './connector-powered';
import { isClaimed, ONE_ROW } from './integration-claims';
import {
  hasActiveEntitlement,
  integrationEntitlementRequired,
  type EntitlementSession,
} from './integration-entitlement';
import { assertIntegrationLive, liveIntegrationWhere } from './live-integration';

type IntegrationRow = typeof integrations.$inferSelect;
export type EvidencedPairRow = typeof connectorEvidencedPairs.$inferSelect;

/** Which of the row's two endpoint products the caller's vendor owns, through
 *  `product_vendors`. Empty when it owns neither. */
export async function ownedEndpointIds(
  db: Db,
  vendorId: string,
  row: Pick<IntegrationRow, 'sourceProductId' | 'targetProductId'>,
): Promise<readonly string[]> {
  const hits = await db
    .select({ productId: productVendors.productId })
    .from(productVendors)
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        or(
          eq(productVendors.productId, row.sourceProductId),
          eq(productVendors.productId, row.targetProductId),
        ),
      ),
    );
  return [...new Set(hits.map((hit) => hit.productId))];
}

/** Both endpoint slugs, for the purge, the notification snapshot and the recrawl. */
export async function endpointSlugs(
  db: Db,
  sourceId: string,
  targetId: string,
): Promise<readonly [string, string] | null> {
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, [sourceId, targetId]));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  const a = slug.get(sourceId);
  const b = slug.get(targetId);
  return a && b ? [a, b] : null;
}

/**
 * Why this caller may not make an owner write to this row, or `null` when it may.
 * Shared by the pre-check and the lost-race re-read, so a race answers exactly
 * what the pre-check would have answered a moment later.
 */
export async function ownerWriteRefusal(
  db: Db,
  vendorId: string,
  row: IntegrationRow,
  session: EntitlementSession,
): Promise<ApiError | null> {
  const ownership = await ownershipRefusal(db, vendorId, row);
  if (ownership) return ownership;
  // Step 3, the AECI-1040 carve-out: asked after ownership, so a non-owner still
  // gets the ownership answer, and only on a connector-powered row, so an ordinary
  // row keeps the seat as its whole gate.
  if (isConnectorPoweredEdge(row) && !hasActiveEntitlement(session)) {
    return integrationEntitlementRequired(session);
  }
  return claimedAndLiveRefusal(row);
}

/**
 * {@link ownerWriteRefusal} for a `connector_evidenced_pairs` row (AECI-1090). The
 * same steps in the same order. The pair's two endpoints are `product_a_id` and
 * `product_b_id`, and the entitlement step always applies, because every row of
 * that table is connector-powered (ADR 0035 decision 9's predicate).
 */
export async function evidencedOwnerWriteRefusal(
  db: Db,
  vendorId: string,
  pair: EvidencedPairRow,
  session: EntitlementSession,
): Promise<ApiError | null> {
  const ownership = await ownershipRefusal(db, vendorId, {
    id: pair.id,
    builtByVendorId: pair.builtByVendorId,
    sourceProductId: pair.productAId,
    targetProductId: pair.productBId,
  });
  if (ownership) return ownership;
  if (!hasActiveEntitlement(session)) return integrationEntitlementRequired(session);
  return claimedAndLiveRefusal(pair);
}

/** Steps 1 and 2: the claim's ownership answers. */
async function ownershipRefusal(
  db: Db,
  vendorId: string,
  row: Pick<IntegrationRow, 'id' | 'builtByVendorId' | 'sourceProductId' | 'targetProductId'>,
): Promise<ApiError | null> {
  if (row.builtByVendorId !== vendorId) {
    if ((await ownedEndpointIds(db, vendorId, row)).length === 0) {
      return notFoundError('integration', { id: row.id });
    }
    if (row.builtByVendorId === null) {
      return new ApiError(
        409,
        ApiErrorCode.INTEGRATION_OWNER_UNKNOWN,
        'No owner is on file for this integration. Contest the owner field to ask AECi to record you as the owner.',
      );
    }
    return new ApiError(
      403,
      ApiErrorCode.INTEGRATION_NOT_OWNER,
      'Another company is recorded as the owner of this integration. Contest a field if something on it is wrong.',
    );
  }
  return null;
}

/** Steps 4 and 5: claimed, then live. Both tables carry `claimed_at` and
 *  `retired_at` with the same meaning (migrations `0044` and `0049`). */
function claimedAndLiveRefusal(row: {
  readonly claimedAt: string | null;
  readonly retiredAt: string | null;
}): ApiError | null {
  if (!isClaimed(row)) {
    return new ApiError(
      409,
      ApiErrorCode.INTEGRATION_NOT_CLAIMED,
      'Claim this integration before you edit it. POST /api/vendor/integrations/:id/claim takes it from AECi.',
    );
  }
  // AECI-1010: last. An owner retire requires a claim, so for this route's callers
  // (claimed owners) the claim answer comes first. An AECi retire (AECI-1046) can
  // also reach an unclaimed vendor-created row; that owner already stopped above.
  try {
    assertIntegrationLive(row);
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  return null;
}

/**
 * The `WHERE` of an owner write's guarded `UPDATE`: this row, still owned by the
 * caller, still claimed, not retired. An `owner` contest accepted by AECi between the handler's
 * read and its batch reassigns `built_by_vendor_id` and clears `claimed_at`
 * (ADR 0035), and this is what stops the old owner's write landing after it.
 */
export function ownerWriteWhere(integrationId: string, vendorId: string) {
  return and(
    eq(integrations.id, integrationId),
    eq(integrations.builtByVendorId, vendorId),
    isNotNull(integrations.claimedAt),
    // AECI-1010: and still live, so a retire that lands between the read and the
    // batch stops the edit at the sentinel.
    liveIntegrationWhere,
  );
}

/**
 * {@link ownerWriteWhere} for a `connector_evidenced_pairs` row (AECI-1090): this
 * pair, still owned by the caller, still claimed, not retired. The same race it
 * guards: an AECi `owner` accept, or a retire, landing between the read and the
 * batch.
 */
export function evidencedOwnerWriteWhere(pairId: string, vendorId: string) {
  return and(
    eq(connectorEvidencedPairs.id, pairId),
    eq(connectorEvidencedPairs.builtByVendorId, vendorId),
    isNotNull(connectorEvidencedPairs.claimedAt),
    isNull(connectorEvidencedPairs.retiredAt),
  );
}

/**
 * A batch statement that ABORTS the batch when the guarded `UPDATE` before it
 * changed zero rows. Push it immediately after that UPDATE.
 *
 * Same mechanism as `claimRaceSentinel` and `contestStillOpenSentinel`: D1 has no
 * interactive transactions, so a batch cannot branch on whether its guard matched.
 * Without this the loser would still commit its audit row and notifications for a
 * write that did not happen. `json('integration-owner-write-lost')` is malformed
 * JSON, so it raises and rolls the whole batch back.
 */
export function ownerWriteSentinel(db: Db) {
  // FROM a one-row constant, not from the integration (the AECI-1005 review fix):
  // if the row was deleted between the read and the batch, a
  // `FROM integrations WHERE id = ?` source returns nothing, the guard never runs,
  // and the audit and notification rows commit for a write that matched nothing.
  return db
    .select({ guard: sql`CASE WHEN changes() = 0 THEN json('integration-owner-write-lost') END` })
    .from(ONE_ROW);
}

/** True for the error {@link ownerWriteSentinel} raises, in D1 or SQLite. Nothing
 *  else in an owner-write batch calls `json()`, so the match is unambiguous. */
export function isOwnerWriteRaceError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes('integration-owner-write-lost')) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// ─── The edit notification (AECI-1006) ───────────────────────────────────────

/** `metadata.kind` on the `notification.sent` row an owner edit writes. */
export const UPDATE_NOTIFICATION_KIND = 'integration_update';

/** What an edit `notification.sent` row records. `vendorId` is the RECIPIENT,
 *  which is what the feed's `json_extract(metadata, '$.vendorId')` filter matches. */
export interface UpdateNotificationMetadata {
  kind: typeof UPDATE_NOTIFICATION_KIND;
  vendorId: string;
  integrationId: string;
  integrationName: string | null;
  ownerVendorId: string;
  ownerName: string | null;
  fields: readonly string[];
  pairSlugs: readonly [string, string] | null;
}

/**
 * The `notification.sent` row telling one endpoint vendor that the owner edited an
 * integration on its product. Pushed into the SAME batch as the edit, so a
 * rolled-back edit cannot leave a notification behind. `entity_type` follows the
 * claim notification (`claimNotificationAudit`): `integration`, or
 * `connector_evidenced_pair` for a pair (AECI-1090).
 */
export function updateNotificationAudit(
  actor: { actorId: string | null; actorType: AuditLogEntry['actorType'] },
  metadata: Omit<UpdateNotificationMetadata, 'kind'>,
  anchor: 'integration' | 'evidenced_pair' = 'integration',
): AuditLogEntry {
  const full: UpdateNotificationMetadata = {
    kind: UPDATE_NOTIFICATION_KIND,
    ...metadata,
    pairSlugs: metadata.pairSlugs ? orderedPairSlugs(...metadata.pairSlugs) : null,
  };
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action: NOTIFICATION_SENT_ACTION,
    entityType: anchor === 'evidenced_pair' ? 'connector_evidenced_pair' : 'integration',
    entityId: metadata.integrationId,
    metadata: full,
  };
}
