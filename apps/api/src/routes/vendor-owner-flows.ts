/**
 * The owner of a Sync Service pair maintains its data flows (AECI-2039, ruling 4 on
 * AECI-2035, `STAGE_2_ATTESTATIONS_SPEC.md` §14.10, `API_CONTRACTS.md` §6.15a).
 *
 *   POST   /api/vendor/owned-integrations/:id/flows   — add a flow; adding confirms it.
 *   PUT    /api/vendor/owned-flows/:claimId/answer    — Yes confirms, No removes it.
 *   DELETE /api/vendor/owned-flows/:claimId/answer    — clear the owner's answer (204).
 *   PATCH  /api/vendor/owned-flows/:claimId           — change its direction.
 *
 * ── THE GATE ────────────────────────────────────────────────────────────────
 * `requireVendor()` → `rateLimit('write')` at the mount, then
 * `resolveOwnerFlowTarget` / `resolveOwnerFlowClaim` (`lib/owner-flows.ts`): owner,
 * then Sync Service, then claimed, then live. A seat is the whole remaining gate, on
 * any plan (AECI-2038). Endpoint vendors get the owner gate's 403, so AECI-705 stands
 * for them. They still use `/api/vendor/claims` on rows no connector delivers.
 *
 * ── ONE BATCH ───────────────────────────────────────────────────────────────
 * Every write is one `db.batch`:
 *
 *   1. the guarded row `UPDATE` (`updated_at`, `vendor_edited_at`), which is the race
 *      guard: an owner reassign, an unclaim or a retire landing after the read stops
 *      the batch at `ownerWriteSentinel`. `vendor_edited_at` is the "Maintained by"
 *      date (§4.5.8). `updated_at` moves the owner's freshness cursor;
 *   2. a new `claims` row, for an added flow (`origin = 'vendor'`);
 *   3. retract-then-insert on `claim_owner_answers`. The retract precedes the insert,
 *      or the partial unique index rejects the insert;
 *   4. the audit rows: `integration.updated` (`reason: 'owner-flow'`), `claim.created`
 *      for an added flow, `claim_owner_answer.created` / `.retracted` per row;
 *   5. on an added flow, one `portal-claim-added` notification per endpoint vendor.
 *
 * After commit: purge `pair:{a}__{b}`, both endpoint `product:` tags and the
 * connector's `product:` tag, and queue the pair re-crawl. Claims do not feed Algolia.
 *
 * Promote is untouched: it writes nothing to a claimed row, its claims included.
 */

import {
  AddOwnerFlowSchema,
  ApiErrorCode,
  ChangeOwnerFlowSchema,
  OwnerFlowsResponseSchema,
  SetOwnerFlowAnswerSchema,
  claimDirectionForContext,
  claimDirectionFromContext,
  type ClaimDirection,
  type OwnerFlowsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import {
  claimOwnerAnswers,
  claims,
  connectorEvidencedPairs,
  integrations,
  productVendors,
  products,
  vendors,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json, noContent } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { claimProvenance, assertClaimProvenance } from '../lib/attestation-authority';
import { claimAddedNotificationAudit } from '../lib/claim-added-notification';
import { loadDataObjectResolver } from '../lib/data-object-vocabulary';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  evidencedOwnerWriteWhere,
  isOwnerWriteRaceError,
  ownerWriteSentinel,
  ownerWriteWhere,
} from '../lib/integration-owner-writes';
import {
  liveOwnerAnswerId,
  loadOwnedFlows,
  ownerFlowContextOf,
  resolveOwnerFlowClaim,
  resolveOwnerFlowTarget,
  type OwnerFlowTarget,
} from '../lib/owner-flows';
import { publicSiteBase } from '../lib/public-urls';
import { pairCacheTag } from './promote-pair';
import { attestationEditRecrawl } from './vendor-recrawl';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  sessionVendorId,
  stampCauseProductPlan,
  vendorAuditEntry,
  vendorRecrawlEnabled,
  withRecrawlProduct,
  type VendorContext,
} from './vendor-shared';

/** One answer change on one claim: the live row to retract, the stance to insert. */
export interface AnswerChange {
  readonly claimId: string;
  /** The live `claim_owner_answers` id to retract, or `null`. */
  readonly retractId: string | null;
  /** The new stance, or `null` to clear. */
  readonly asserted: boolean | null;
}

/** What one write adds beyond the answer changes. */
export interface WriteExtras {
  /** A new claim row, for an added flow. */
  readonly newClaim?: {
    readonly id: string;
    readonly dataObject: { id: string; slug: string; name: string };
    readonly direction: ClaimDirection;
  };
}

/** The three slugs the purge, the recrawl and the notification snapshot read. */
interface TargetSlugs {
  readonly a: string | null;
  readonly b: string | null;
  readonly connector: string | null;
}

async function targetSlugs(db: Db, target: OwnerFlowTarget): Promise<TargetSlugs> {
  const rows = await db
    .select({ id: products.id, slug: products.slug })
    .from(products)
    .where(inArray(products.id, [target.productAId, target.productBId, target.connectorProductId]));
  const slug = new Map(rows.map((r) => [r.id, r.slug]));
  return {
    a: slug.get(target.productAId) ?? null,
    b: slug.get(target.productBId) ?? null,
    connector: slug.get(target.connectorProductId) ?? null,
  };
}

/** The guarded row `UPDATE` for either table. */
function rowGuard(db: Db, target: OwnerFlowTarget, vendorId: string, now: string): BatchStmt {
  return target.anchor === 'integration'
    ? db
        .update(integrations)
        .set({ updatedAt: now, vendorEditedAt: now })
        .where(ownerWriteWhere(target.id, vendorId))
    : db
        .update(connectorEvidencedPairs)
        .set({ updatedAt: now, vendorEditedAt: now })
        .where(evidencedOwnerWriteWhere(target.id, vendorId));
}

/** `audit_log.entity_type` of the row. */
function rowEntityType(target: OwnerFlowTarget): 'integration' | 'connector_evidenced_pair' {
  return target.anchor === 'integration' ? 'integration' : 'connector_evidenced_pair';
}

/**
 * The `portal-claim-added` rows for an added flow: one per vendor of either endpoint,
 * except the owner, each framed against the recipient's own product (endpoint A when it
 * holds both).
 */
async function addedFlowNotifications(
  c: VendorContext,
  db: Db,
  target: OwnerFlowTarget,
  vendorId: string,
  claim: NonNullable<WriteExtras['newClaim']>,
  slugs: TargetSlugs,
): Promise<AuditLogEntry[]> {
  const session = c.get('auth');
  const [holders, owner, names] = await Promise.all([
    db
      .select({ vendorId: productVendors.vendorId, productId: productVendors.productId })
      .from(productVendors)
      .where(
        or(
          eq(productVendors.productId, target.productAId),
          eq(productVendors.productId, target.productBId),
        ),
      ),
    db.query.vendors.findFirst({ columns: { companyName: true }, where: eq(vendors.id, vendorId) }),
    db
      .select({ id: products.id, slug: products.slug, name: products.name })
      .from(products)
      .where(inArray(products.id, [target.productAId, target.productBId])),
  ]);
  const product = new Map(names.map((p) => [p.id, { slug: p.slug, name: p.name }]));
  const holdsA = new Map<string, boolean>();
  for (const row of holders) {
    if (row.vendorId === vendorId) continue;
    holdsA.set(
      row.vendorId,
      (holdsA.get(row.vendorId) ?? false) || row.productId === target.productAId,
    );
  }
  // Sorted by id: an id ordering stays BINARY (`API_CONTRACTS.md` §3.2).
  return [...holdsA.keys()].sort().map((recipient) => {
    const recipientIsA = holdsA.get(recipient) ?? false;
    return claimAddedNotificationAudit(
      'portal-claim-added',
      { actorId: session.userId, actorType: auditActorType(session) },
      {
        vendorId: recipient,
        addedByVendorId: vendorId,
        addedByName: owner?.companyName ?? null,
        integrationId: target.id,
        integrationName: target.name,
        claimId: claim.id,
        dataObject: { slug: claim.dataObject.slug, name: claim.dataObject.name },
        direction: claimDirectionForContext(claim.direction, recipientIsA),
        counterpartProduct:
          product.get(recipientIsA ? target.productBId : target.productAId) ?? null,
        pairSlugs: slugs.a && slugs.b ? [slugs.a, slugs.b] : null,
      },
    );
  });
}

/**
 * What a caller outside this module adds to one owner flow write (AECI-2042): a data
 * flow report accept rides the same batch. `prefix` runs first (the report's guarded
 * UPDATE and its sentinel), `audits` join the batch's audit rows, and `onRace` gives the
 * answer when any sentinel aborts it.
 */
export interface OwnerFlowWriteAddOn {
  readonly prefix: readonly BatchStmt[];
  readonly audits: readonly AuditLogEntry[];
  readonly onRace: () => Promise<ApiError>;
}

/**
 * Commit one owner flow write and answer with the row's flows. Everything that can
 * fail was resolved by the caller, so the batch is the only remaining step.
 */
export async function commitOwnerFlowWrite(
  c: VendorContext,
  db: Db,
  target: OwnerFlowTarget,
  changes: readonly AnswerChange[],
  extras: WriteExtras = {},
  addOn?: OwnerFlowWriteAddOn,
): Promise<OwnerFlowsResponse> {
  return commit(c, db, target, changes, extras, addOn);
}

async function commit(
  c: VendorContext,
  db: Db,
  target: OwnerFlowTarget,
  changes: readonly AnswerChange[],
  extras: WriteExtras = {},
  addOn?: OwnerFlowWriteAddOn,
): Promise<OwnerFlowsResponse> {
  const session = c.get('auth');
  const vendorId = sessionVendorId(c);
  const actor = { actorId: session.userId, actorType: auditActorType(session) };
  const now = new Date().toISOString();
  const slugs = await targetSlugs(db, target);
  const meta = { source: AUDIT_SOURCE, vendorId, integrationId: target.id, anchor: target.anchor };

  const stmts: BatchStmt[] = [
    ...(addOn?.prefix ?? []),
    rowGuard(db, target, vendorId, now),
    ownerWriteSentinel(db),
  ];
  const audits: AuditLogEntry[] = [
    ...(addOn?.audits ?? []),
    {
      ...actor,
      action: 'integration.updated',
      entityType: rowEntityType(target),
      entityId: target.id,
      afterState: { vendor_edited_at: now },
      metadata: { ...meta, reason: 'owner-flow', fields: ['data_flows'], connectorPowered: true },
    },
  ];

  if (extras.newClaim) {
    const provenance = claimProvenance(vendorId);
    const row = {
      id: extras.newClaim.id,
      integrationId: target.anchor === 'integration' ? target.id : null,
      connectorEvidencedPairId: target.anchor === 'evidenced_pair' ? target.id : null,
      dataObjectId: extras.newClaim.dataObject.id,
      direction: extras.newClaim.direction,
      origin: provenance.origin,
      createdByVendorId: provenance.createdByVendorId,
      createdAt: now,
      updatedAt: now,
    };
    assertClaimProvenance(row);
    stmts.push(db.insert(claims).values(row));
    audits.push({
      ...actor,
      action: 'claim.created',
      entityType: 'claim',
      entityId: row.id,
      afterState: {
        anchor_id: target.id,
        data_object_slug: extras.newClaim.dataObject.slug,
        direction: row.direction,
        origin: row.origin,
      },
      metadata: { ...meta, claimId: row.id, reason: 'owner-flow' },
    });
  }

  for (const change of changes) {
    if (change.retractId) {
      // Retract BEFORE insert: `claim_owner_answers_live_key` is checked per statement.
      stmts.push(
        db
          .update(claimOwnerAnswers)
          .set({ retractedAt: now, updatedAt: now })
          .where(
            and(eq(claimOwnerAnswers.id, change.retractId), isNull(claimOwnerAnswers.retractedAt)),
          ),
      );
      audits.push({
        ...actor,
        action: 'claim_owner_answer.retracted',
        entityType: 'claim_owner_answer',
        entityId: change.retractId,
        afterState: { retracted_at: now },
        metadata: { ...meta, claimId: change.claimId },
      });
    }
    if (change.asserted !== null) {
      const id = crypto.randomUUID();
      stmts.push(
        db.insert(claimOwnerAnswers).values({
          id,
          claimId: change.claimId,
          vendorId,
          asserted: change.asserted,
          createdAt: now,
          updatedAt: now,
        }),
      );
      audits.push({
        ...actor,
        action: 'claim_owner_answer.created',
        entityType: 'claim_owner_answer',
        entityId: id,
        afterState: { asserted: change.asserted },
        metadata: { ...meta, claimId: change.claimId },
      });
    }
  }

  const notifications = extras.newClaim
    ? await addedFlowNotifications(c, db, target, vendorId, extras.newClaim, slugs)
    : [];
  // The owner usually sells neither endpoint, so the cause product is `null` then.
  stampCauseProductPlan(c, audits, null);
  stmts.push(
    ...[...audits, ...notifications].map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
  );

  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    if (!isOwnerWriteRaceError(error)) throw error;
    if (addOn) throw await addOn.onRace();
    // Ask the gate again, so a race answers what the pre-check would have a moment later.
    await resolveOwnerFlowTarget(db, vendorId, target.id);
    throw new ApiError(
      409,
      ApiErrorCode.INTEGRATION_CHANGED_WHILE_SAVING,
      'This integration changed while it was being saved. Reload and try again.',
    );
  }

  const tags = [
    ...(slugs.a && slugs.b
      ? [pairCacheTag(slugs.a, slugs.b), `product:${slugs.a}`, `product:${slugs.b}`]
      : []),
    ...(slugs.connector ? [`product:${slugs.connector}`] : []),
  ];
  const base = publicSiteBase(c.env);
  const recrawl =
    slugs.a && slugs.b && vendorRecrawlEnabled(c) && base
      ? attestationEditRecrawl(base, slugs.a, slugs.b)
      : undefined;
  afterVendorWrite(c, tags, [...audits, ...notifications], withRecrawlProduct(recrawl, null), db);

  return flowsBody(db, target);
}

/** The row's flows after the write, as `OwnedIntegration.flows` carries them. */
async function flowsBody(db: Db, target: OwnerFlowTarget): Promise<OwnerFlowsResponse> {
  const connector = await db.query.products.findFirst({
    columns: { productRole: true, connectorKind: true },
    where: eq(products.id, target.connectorProductId),
  });
  const ctx = ownerFlowContextOf(target, connector);
  const flows = await loadOwnedFlows(db, [{ id: target.id, anchor: target.anchor, ctx }]);
  return { integration_id: target.id, flows: flows.get(target.id) ?? [] };
}

function respond(c: VendorContext, body: OwnerFlowsResponse, status = 200): Response {
  validateResponseInDev(c.env, () => OwnerFlowsResponseSchema.parse(body));
  return json(body, { status });
}

function param(c: VendorContext, name: 'id' | 'claimId'): string {
  const value = c.req.param(name);
  if (!value) throw new ApiError(400, 'VALIDATION_FAILED', `Missing ${name}`, { field: name });
  return value;
}

/** The claim with this identity on the row, or `undefined`. One probe of `claims_identity_key`. */
async function claimWithIdentity(
  db: Db,
  target: OwnerFlowTarget,
  dataObjectId: string,
  direction: ClaimDirection,
): Promise<{ id: string } | undefined> {
  return db.query.claims.findFirst({
    columns: { id: true },
    where: and(
      eq(claims.anchorId, target.id),
      eq(claims.dataObjectId, dataObjectId),
      eq(claims.direction, direction),
    ),
  });
}

/** `POST /api/vendor/owned-integrations/:id/flows`. Adding confirms. 201 on a new claim. */
export function createAddOwnerFlowHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    // The id is a path param, so the gate runs before the body is read.
    const target = await resolveOwnerFlowTarget(db, vendorId, param(c, 'id'));
    const payload = await parseJsonBody(c, AddOwnerFlowSchema);
    const resolve = await loadDataObjectResolver(db);
    const term = resolve(payload.data_object);
    if (!term) {
      throw new ApiError(400, 'VALIDATION_FAILED', `Unknown data object "${payload.data_object}"`, {
        field: 'data_object',
      });
    }
    // Framed against endpoint A, as `OwnedIntegration.product_a` is.
    const direction = claimDirectionFromContext(payload.direction, true);
    const existing = await claimWithIdentity(db, target, term.id, direction);
    if (existing) {
      // The flow is already listed: adding it again is confirming it.
      const retractId = await liveOwnerAnswerId(db, existing.id);
      return respond(
        c,
        await commit(c, db, target, [{ claimId: existing.id, retractId, asserted: true }]),
      );
    }
    const claimId = crypto.randomUUID();
    const body = await commit(c, db, target, [{ claimId, retractId: null, asserted: true }], {
      newClaim: { id: claimId, dataObject: term, direction },
    });
    return respond(c, body, 201);
  };
}

/** `PUT /api/vendor/owned-flows/:claimId/answer`. Yes confirms. No removes the flow. */
export function createSetOwnerFlowAnswerHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const claim = await resolveOwnerFlowClaim(db, vendorId, param(c, 'claimId'));
    const payload = await parseJsonBody(c, SetOwnerFlowAnswerSchema);
    const retractId = await liveOwnerAnswerId(db, claim.id);
    return respond(
      c,
      await commit(c, db, claim.target, [
        { claimId: claim.id, retractId, asserted: payload.asserted },
      ]),
    );
  };
}

/** `DELETE /api/vendor/owned-flows/:claimId/answer`. Clears the answer. 204, also when none. */
export function createClearOwnerFlowAnswerHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const claim = await resolveOwnerFlowClaim(db, vendorId, param(c, 'claimId'));
    const retractId = await liveOwnerAnswerId(db, claim.id);
    // Nothing to clear: no write, no audit row claiming a change that did not happen.
    if (retractId === null) return noContent();
    await commit(c, db, claim.target, [{ claimId: claim.id, retractId, asserted: null }]);
    return noContent();
  };
}

/**
 * `PATCH /api/vendor/owned-flows/:claimId`. A flow's identity is its data object and
 * direction (`claims_identity_key`), so a new direction is a different flow: the old
 * one is removed and the new one confirmed, in ONE batch. Never an `UPDATE` of
 * `claims.direction`: that would rewrite the history the endpoint vendors and AECi saw.
 */
export function createChangeOwnerFlowHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);
    const claim = await resolveOwnerFlowClaim(db, vendorId, param(c, 'claimId'));
    const payload = await parseJsonBody(c, ChangeOwnerFlowSchema);
    const direction = claimDirectionFromContext(payload.direction, true);
    if (direction === claim.direction) return respond(c, await flowsBody(db, claim.target));
    const plan = await planOwnerFlowChange(db, claim, direction);
    const body = await commit(c, db, claim.target, plan.changes, plan.extras);
    return respond(c, body);
  };
}

/**
 * The answer changes that remove a flow (`direction = null`) or move it to a new
 * direction, as the owner's own routes write them. Shared with the data flow report
 * accept (AECI-2042), so an accepted report changes the flow exactly as the owner
 * would have. A new direction is a different flow: the old one is answered No and the
 * new one confirmed, never an `UPDATE` of `claims.direction`.
 */
export async function planOwnerFlowChange(
  db: Db,
  claim: { readonly id: string; readonly dataObjectId: string; readonly target: OwnerFlowTarget },
  direction: ClaimDirection | null,
): Promise<{ changes: AnswerChange[]; extras: WriteExtras }> {
  const removeOld: AnswerChange = {
    claimId: claim.id,
    retractId: await liveOwnerAnswerId(db, claim.id),
    asserted: false,
  };
  if (direction === null) return { changes: [removeOld], extras: {} };
  const term = await db.query.taxonomyDataObjects.findFirst({
    columns: { id: true, slug: true, name: true },
    where: (t, { eq: is }) => is(t.id, claim.dataObjectId),
  });
  if (!term) throw notFoundError('claim', { id: claim.id });
  const existing = await claimWithIdentity(db, claim.target, term.id, direction);
  if (existing) {
    const retractId = await liveOwnerAnswerId(db, existing.id);
    return {
      changes: [removeOld, { claimId: existing.id, retractId, asserted: true }],
      extras: {},
    };
  }
  const claimId = crypto.randomUUID();
  return {
    changes: [removeOld, { claimId, retractId: null, asserted: true }],
    extras: { newClaim: { id: claimId, dataObject: term, direction } },
  };
}
