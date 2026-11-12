/**
 * License grants that wait for an acceptance (AECI-1615, counsel Q5;
 * `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 5; `DATABASE_SCHEMA.md` §8.6h).
 *
 * The Managed plan agreement v1.1 says a granted subscription "does not start until an
 * owner seat accepts it in the portal ... or until a person with authority for your
 * company signs a deal that names this agreement by version and date". So an AECi grant
 * writes one `license_grants` row, `pending_acceptance`, and NO license. This module
 * builds every statement that moves a grant, and like `lib/license.ts` it never runs a
 * batch: the caller appends the statements to its own `db.batch`.
 *
 *   - {@link createLicenseGrantStatements}: the INSERT and its `license_grant.created`
 *     audit row (the admin grant and ban-term routes).
 *   - {@link activateLicenseGrantStatements}: the ONLY path that writes a grant's
 *     licenses. The owner's in-portal accept (`routes/vendor-license-grants.ts`) and a
 *     recorded signed deal at create (ruling R5) both use it. "No grant is live without
 *     an acceptance row" holds by construction: the acceptance INSERT and the license
 *     INSERTs are in the same batch, behind one guarded status flip.
 *   - {@link closeLicenseGrantStatements}: withdraw (AECi) and expire (the 11:00 sweep).
 *
 * ── THE ACTIVATION BATCH, IN ORDER ──────────────────────────────────────────────
 *  1. a guarded UPDATE to `accepted` (`WHERE status = 'pending_acceptance'`), then
 *     `changedOneRowSentinel`, so a race (a second accept, a withdraw, the expiry) writes
 *     nothing at all;
 *  2. the acceptance INSERT and its `agreement.accepted` audit row
 *     (`agreementAcceptanceStatements`, the one acceptance writer, `source: 'grant'`);
 *  3. `grantLicensesStatements` (the one license writer) with the grant's UUIDv5 license
 *     ids and `license_grant_id`. `starts_at` is the later of the requested start and
 *     now. A ban-term item is assigned to its product, unless that product took a live
 *     license while the grant waited, or left the vendor: then it lands in the pool and
 *     the result carries a warning (ruling R6). `productsStillJoinedSentinel` follows,
 *     so a product that leaves the vendor between the read and the batch writes nothing;
 *  4. the `license_grant.accepted` audit row.
 * The caller appends `unbannedSeatExistsSentinel` last.
 *
 * Grants live before AECI-1615 have no row here and stay live (ruling R3).
 */

import {
  ApiErrorCode,
  LicenseGrantItemSchema,
  legalAgreementTextSha256,
  PLANS_PAGE_CURRENT_VERSION,
  type AdminLicenseGrant,
  type AgreementAcceptanceMethod,
  type LicenseGrantItem,
  type LicenseGrantKind,
  type LicenseGrantStatus,
} from '@aeci/shared';
import type { AuditLogActorType, AuditLogEntry } from '@aeci/shared/audit-log';
import { licensePlanSnapshot, type VendorPlanSnapshot } from '@aeci/shared/entitlements';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/client';
import { licenseGrants, productVendors } from '../db/schema';
import { ApiError } from '../errors';
import {
  agreementAcceptanceStatements,
  uncheckedBoxFor,
  type AcceptanceRequestEvidence,
  type AcceptanceSigner,
} from './agreement-acceptances';
import { auditInsert, type BatchStmt } from './audit';
import { grantLicensesStatements, toIsoTimestamp, type LicenseBefore } from './license';
import { ONE_ROW } from './integration-claims';
import { changedOneRowSentinel } from './license-release-requests';
import { uuidv5 } from './uuidv5';

/** `audit_log.entity_type` of every row this module writes; `entity_id` is the grant id. */
export const LICENSE_GRANT_ENTITY_TYPE = 'license_grant';

/** The audit actions. Registered in `@aeci/shared/audit-vendor-actions`. */
export const LICENSE_GRANT_ACTION = {
  created: 'license_grant.created',
  accepted: 'license_grant.accepted',
  withdrawn: 'license_grant.withdrawn',
  expired: 'license_grant.expired',
} as const;

/** The status a grant starts in. */
export const PENDING: LicenseGrantStatus = 'pending_acceptance';

/** The agreement every grant pins. */
export const GRANT_AGREEMENT = 'managed_plan' as const;

/**
 * The namespace every grant license id is minted under:
 * `uuidv5('https://aecintegrations.com/admin/license-grants', URL_NAMESPACE)`.
 * Pinned as a literal so a refactor cannot re-mint the ids, which would turn a retry
 * of an old grant into a second grant. `admin-licenses.spec.ts` re-derives it.
 */
export const LICENSE_GRANT_NAMESPACE = '430cf19f-d3b1-5318-9e2e-7753dc1577ab';

/**
 * The license ids of one grant: `uuidv5('license:{grantId}:{i}')` for i in
 * `0..count-1`. UUID-shaped, so every later route that takes a license id in its
 * path validates them like any other. Unchanged by AECI-1615: a grant's licenses keep
 * the ids the grant would have written before.
 */
export function grantLicenseIds(grantId: string, count: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      uuidv5(`license:${grantId.toLowerCase()}:${i}`, LICENSE_GRANT_NAMESPACE),
    ),
  );
}

export type LicenseGrantRow = typeof licenseGrants.$inferSelect;

const ItemsSchema = z.array(LicenseGrantItemSchema);

/** The ban-term items of a grant. Throws on a row whose JSON is not the stored shape:
 *  this module is its only writer. */
export function grantItems(row: Pick<LicenseGrantRow, 'itemsJson'>): LicenseGrantItem[] {
  return ItemsSchema.parse(JSON.parse(row.itemsJson));
}

/** The grant as AECi's Billing tab and grant responses show it. */
export function toAdminLicenseGrant(
  row: LicenseGrantRow,
  acceptanceMethod: string | null = null,
): AdminLicenseGrant {
  return {
    id: row.id,
    kind: row.kind as LicenseGrantKind,
    status: row.status as LicenseGrantStatus,
    source: row.source,
    quantity: row.quantity,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    reference: row.reference,
    notes: row.notes,
    terms_version: row.termsVersion,
    items: grantItems(row),
    granted_by: row.grantedBy,
    acceptance_id: row.acceptanceId,
    acceptance_method:
      acceptanceMethod === 'portal_checkbox' || acceptanceMethod === 'signed_deal'
        ? acceptanceMethod
        : null,
    decided_at: row.decidedAt,
    decided_by: row.decidedBy,
    withdraw_reason: row.withdrawReason,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

/** The grant as an audit state. Snake case, like the license ledger. */
function grantState(row: LicenseGrantRow) {
  return {
    kind: row.kind,
    status: row.status,
    source: row.source,
    quantity: row.quantity,
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    reference: row.reference,
    terms_version: row.termsVersion,
    items: grantItems(row),
    acceptance_id: row.acceptanceId,
    decided_at: row.decidedAt,
  };
}

interface Actor {
  actorId: string | null;
  actorType: AuditLogActorType;
}

function grantEntry(
  actor: Actor,
  action: string,
  before: LicenseGrantRow | null,
  after: LicenseGrantRow,
  vendorPlan: VendorPlanSnapshot | null,
  metadata: Record<string, unknown>,
): AuditLogEntry {
  return {
    actorId: actor.actorId,
    actorType: actor.actorType,
    action,
    entityType: LICENSE_GRANT_ENTITY_TYPE,
    entityId: after.id,
    vendorId: after.vendorId,
    vendorPlan,
    beforeState: before ? grantState(before) : null,
    afterState: grantState(after),
    metadata: { ...metadata, grant_id: after.id, billing_account_id: after.billingAccountId },
  };
}

// ─── Create ──────────────────────────────────────────────────────────────────

export interface CreateLicenseGrantParams extends Actor {
  id: string;
  billingAccountId: string;
  vendorId: string;
  kind: LicenseGrantKind;
  source: 'complimentary' | 'invoice';
  quantity: number;
  startsAt: string | null;
  endsAt: string;
  reference: string | null;
  notes: string | null;
  items: readonly LicenseGrantItem[];
  termsVersion: string;
  grantedBy: string | null;
  now: string;
  vendorPlan: VendorPlanSnapshot | null;
  /** `metadata.source` on the audit row. */
  auditSource: string;
}

export interface CreateLicenseGrantBatch {
  stmts: BatchStmt[];
  auditEntry: AuditLogEntry;
  /** The row as the INSERT writes it. */
  row: LicenseGrantRow;
}

/** The pending grant's INSERT and its `license_grant.created` audit row. */
export function createLicenseGrantStatements(
  db: Db,
  p: CreateLicenseGrantParams,
): CreateLicenseGrantBatch {
  const now = toIsoTimestamp(p.now);
  const row: LicenseGrantRow = {
    id: p.id,
    billingAccountId: p.billingAccountId,
    vendorId: p.vendorId,
    kind: p.kind,
    source: p.source,
    quantity: p.quantity,
    startsAt: p.startsAt === null ? null : toIsoTimestamp(p.startsAt),
    endsAt: toIsoTimestamp(p.endsAt),
    reference: p.reference,
    notes: p.notes,
    itemsJson: JSON.stringify(p.items),
    termsVersion: p.termsVersion,
    status: PENDING,
    grantedBy: p.grantedBy,
    acceptanceId: null,
    decidedAt: null,
    decidedBy: null,
    withdrawReason: null,
    createdAt: now,
    updatedAt: now,
  };
  const auditEntry = grantEntry(p, LICENSE_GRANT_ACTION.created, null, row, p.vendorPlan, {
    source: p.auditSource,
    ...(p.notes ? { notes: p.notes } : {}),
  });
  return {
    stmts: [db.insert(licenseGrants).values(row), auditInsert(db, auditEntry)],
    auditEntry,
    row,
  };
}

// ─── Activate ────────────────────────────────────────────────────────────────

/** The acceptance the activation records. */
export interface GrantAcceptanceInput {
  method: AgreementAcceptanceMethod;
  /** The accepting person's email: the owner's sign-in email, or the deal's signer. */
  email: string;
  /** The accepting owner seat; null on a signed deal. */
  profileId: string | null;
  signer: AcceptanceSigner;
  /** `owner` on a portal accept; null on a signed deal. */
  seatRole: string | null;
  /** The owner's request headers, for IP and user agent (portal accept only). */
  requestHeaders?: Headers | null;
  evidence?: AcceptanceRequestEvidence | null;
  dealReference?: string | null;
  dealSignedAt?: string | null;
}

export interface ActivateLicenseGrantParams extends Actor {
  /** The grant, as read (or as the create batch writes it). Must be pending. */
  grant: LicenseGrantRow;
  now: string;
  /** Every license on every billing account of the vendor, as pre-read. */
  vendorLicenses: readonly LicenseBefore[];
  vendorWasVerified: boolean;
  /** Products that hold a live license now (any account). A ban-term item on one of them
   *  lands unassigned (ruling R6). */
  licensedProductIds: ReadonlySet<string>;
  /** Products joined to the vendor now (`product_vendors`). A ban-term item on any other
   *  product lands unassigned: assigning it would license another vendor's product. */
  ownedProductIds: ReadonlySet<string>;
  acceptance: GrantAcceptanceInput;
  /** `metadata.source` on the license and grant audit rows. */
  auditSource: string;
  /** Extra metadata for the `license_grant.accepted` row (no personal data). */
  extraMetadata?: Record<string, unknown>;
}

/** A ban-term item that landed in the pool: its product was licensed meanwhile
 *  (`product_already_licensed`), or is no longer joined to the vendor
 *  (`product_not_owned`). */
export interface ActivationWarning {
  code: 'product_already_licensed' | 'product_not_owned';
  productId: string;
  licenseId: string;
}

export interface ActivateLicenseGrantBatch {
  stmts: BatchStmt[];
  /** Every audit row in the batch, in statement order. Forward them after the commit. */
  auditEntries: AuditLogEntry[];
  acceptanceId: string;
  licenseIds: string[];
  /** The products this activation put a license on. */
  assignedProductIds: string[];
  warnings: ActivationWarning[];
  verifiedFlipped: boolean;
  /** The licenses as written, grouped as the `licenses-granted` emails go: one group
   *  per end date. */
  groups: { endsAt: string; count: number }[];
}

/** `{ [key]: productIds }` for the warnings with that code, or nothing. */
function pooledMetadata(
  warnings: readonly ActivationWarning[],
  code: ActivationWarning['code'],
  key: string,
): Record<string, string[]> {
  const ids = warnings.filter((w) => w.code === code).map((w) => w.productId);
  return ids.length > 0 ? { [key]: ids } : {};
}

/**
 * Aborts the activation when a product it assigns is no longer joined to the vendor at
 * that point in the batch: a `product_vendors` row went between the pre-read and the
 * batch. The `changedOneRowSentinel` pattern (`json(...)` on a non-JSON string), so the
 * caller re-reads to tell it apart from the status and seat sentinels.
 */
export function productsStillJoinedSentinel(
  db: Db,
  vendorId: string,
  productIds: readonly string[],
): BatchStmt {
  const joined = db
    .select({ n: sql`count(*)` })
    .from(productVendors)
    .where(
      and(
        eq(productVendors.vendorId, vendorId),
        inArray(productVendors.productId, [...productIds]),
      ),
    );
  return db
    .select({
      guard: sql`CASE WHEN (${joined}) < ${productIds.length} THEN json('license-grant-product-left') END`,
    })
    .from(ONE_ROW);
}

/**
 * The activation batch (module header). Throws `400` when the grant is not pending in
 * the row handed in; a grant that left pending since the read is the sentinel's job.
 */
export async function activateLicenseGrantStatements(
  db: Db,
  p: ActivateLicenseGrantParams,
): Promise<ActivateLicenseGrantBatch> {
  const now = toIsoTimestamp(p.now);
  const grant = p.grant;
  if (grant.status !== PENDING) {
    throw new ApiError(422, ApiErrorCode.LICENSE_GRANT_NOT_PENDING, 'This grant is not waiting.', {
      details: { state: grant.status },
    });
  }
  const vendorPlan = licensePlanSnapshot(p.vendorLicenses, now);

  const acceptance = agreementAcceptanceStatements(db, {
    document: GRANT_AGREEMENT,
    version: grant.termsVersion,
    source: 'grant',
    email: p.acceptance.email,
    profileId: p.acceptance.profileId,
    vendorId: grant.vendorId,
    billingAccountId: grant.billingAccountId,
    acceptedAt: now,
    requestHeaders: p.acceptance.requestHeaders ?? null,
    evidence: p.acceptance.evidence ?? null,
    signer: p.acceptance.signer,
    actorId: p.actorId,
    actorType: p.actorType,
    vendorPlan,
    grant: {
      licenseGrantId: grant.id,
      grantEndsAt: grant.endsAt,
      pinnedVersion: grant.termsVersion,
      method: p.acceptance.method,
      textSha256: legalAgreementTextSha256(GRANT_AGREEMENT, grant.termsVersion),
      seatRole: p.acceptance.seatRole,
      dealReference: p.acceptance.dealReference ?? null,
      dealSignedAt: p.acceptance.dealSignedAt ?? null,
    },
    // AECI-1615 ruling 16: the portal accept is the Billing tab's box, which always
    // starts unticked (`vendor-pending-grant-card.ts`); the body's `accepted: true` is
    // the tick. A signed deal has no box, so both columns stay NULL.
    checkbox: p.acceptance.method === 'portal_checkbox' ? uncheckedBoxFor(GRANT_AGREEMENT) : null,
    // AECI-1619 (ruling 16): both methods record the Plans page current at activation,
    // the page the grant's subscription is described by from that day.
    plansVersion: PLANS_PAGE_CURRENT_VERSION,
  });

  const after: LicenseGrantRow = {
    ...grant,
    status: 'accepted',
    acceptanceId: acceptance.acceptanceId,
    decidedAt: now,
    decidedBy: p.actorId,
    updatedAt: now,
  };
  const flip = db
    .update(licenseGrants)
    .set({
      status: 'accepted',
      acceptanceId: acceptance.acceptanceId,
      decidedAt: now,
      decidedBy: p.actorId,
      updatedAt: now,
    })
    .where(and(eq(licenseGrants.id, grant.id), eq(licenseGrants.status, PENDING)));

  // The requested start, unless it has passed: a subscription never starts before it
  // was accepted.
  const startsAt =
    grant.startsAt && Date.parse(grant.startsAt) > Date.parse(now) ? grant.startsAt : now;
  const licenseStmts: BatchStmt[] = [];
  const licenseAudits: AuditLogEntry[] = [];
  const licenseIds: string[] = [];
  const assignedProductIds: string[] = [];
  const warnings: ActivationWarning[] = [];
  const groups: { endsAt: string; count: number }[] = [];
  const lapsedItemProductIds: string[] = [];
  let verifiedFlipped = false;
  const shared = {
    vendorId: grant.vendorId,
    now,
    actorId: p.actorId,
    actorType: p.actorType,
    source: p.auditSource,
    vendorLicenses: p.vendorLicenses,
    planLicenses: p.vendorLicenses,
    billingAccountId: grant.billingAccountId,
    licenseSource: grant.source as 'complimentary' | 'invoice',
    startsAt,
    reference: grant.reference,
    grantedBy: grant.grantedBy,
    termsVersion: grant.termsVersion,
    licenseGrantId: grant.id,
  };

  if (grant.kind === 'ban_term') {
    const items = grantItems(grant);
    const ids = await grantLicenseIds(grant.id, items.length);
    // Group by end date, in first-appearance order. Each item keeps its ordinal id. An
    // item whose own term has passed while the grant waited is skipped: a license born
    // past its end would only lapse at the next 11:00 run.
    const byEnd = new Map<string, number[]>();
    items.forEach((item, i) => {
      if (Date.parse(item.ends_at) <= Date.parse(now)) {
        lapsedItemProductIds.push(item.product_id);
        return;
      }
      const group = byEnd.get(item.ends_at) ?? [];
      group.push(i);
      byEnd.set(item.ends_at, group);
    });
    let groupIndex = 0;
    for (const [endsAt, indexes] of byEnd) {
      // The builder assigns the first `productIds.length` licenses, so the items that
      // can still be assigned go first.
      const pooledCode = (i: number): ActivationWarning['code'] | null => {
        const productId = items[i]!.product_id;
        if (!p.ownedProductIds.has(productId)) return 'product_not_owned';
        if (p.licensedProductIds.has(productId)) return 'product_already_licensed';
        return null;
      };
      const assignable = indexes.filter((i) => pooledCode(i) === null);
      const pooled = indexes.filter((i) => pooledCode(i) !== null);
      const ordered = [...assignable, ...pooled];
      const batch = grantLicensesStatements(db, {
        ...shared,
        vendorWasVerified: groupIndex === 0 ? p.vendorWasVerified : true,
        extraMetadata: {
          grant_id: grant.id,
          ban_term_grant: true,
          restored_from_license_ids: ordered.map((i) => items[i]!.ended_license_id),
        },
        count: ordered.length,
        endsAt,
        productIds: assignable.map((i) => items[i]!.product_id),
        licenseIds: ordered.map((i) => ids[i]!),
      });
      licenseStmts.push(...batch.stmts);
      licenseAudits.push(...batch.auditEntries);
      verifiedFlipped ||= batch.verifiedFlipped;
      for (const i of assignable) assignedProductIds.push(items[i]!.product_id);
      for (const i of pooled) {
        warnings.push({
          code: pooledCode(i)!,
          productId: items[i]!.product_id,
          licenseId: ids[i]!,
        });
      }
      licenseIds.push(...ordered.map((i) => ids[i]!));
      groups.push({ endsAt, count: ordered.length });
      groupIndex += 1;
    }
  } else {
    const ids = await grantLicenseIds(grant.id, grant.quantity);
    const batch = grantLicensesStatements(db, {
      ...shared,
      vendorWasVerified: p.vendorWasVerified,
      extraMetadata: { grant_id: grant.id, ...(grant.notes ? { notes: grant.notes } : {}) },
      count: grant.quantity,
      endsAt: grant.endsAt,
      licenseIds: ids,
    });
    licenseStmts.push(...batch.stmts);
    licenseAudits.push(...batch.auditEntries);
    verifiedFlipped = batch.verifiedFlipped;
    licenseIds.push(...ids);
    groups.push({ endsAt: grant.endsAt, count: grant.quantity });
  }

  const acceptedEntry = grantEntry(p, LICENSE_GRANT_ACTION.accepted, grant, after, vendorPlan, {
    source: p.auditSource,
    method: p.acceptance.method,
    acceptance_id: acceptance.acceptanceId,
    license_ids: licenseIds,
    ...pooledMetadata(warnings, 'product_already_licensed', 'pooled_product_ids'),
    ...pooledMetadata(warnings, 'product_not_owned', 'not_owned_product_ids'),
    ...(lapsedItemProductIds.length > 0 ? { lapsed_item_product_ids: lapsedItemProductIds } : {}),
    ...p.extraMetadata,
  });

  return {
    stmts: [
      flip,
      changedOneRowSentinel(db),
      ...acceptance.stmts,
      ...licenseStmts,
      ...(assignedProductIds.length > 0
        ? [productsStillJoinedSentinel(db, grant.vendorId, assignedProductIds)]
        : []),
      auditInsert(db, acceptedEntry),
    ],
    auditEntries: [acceptance.auditEntry, ...licenseAudits, acceptedEntry],
    acceptanceId: acceptance.acceptanceId,
    licenseIds,
    assignedProductIds,
    warnings,
    verifiedFlipped,
    groups,
  };
}

// ─── Withdraw and expire ────────────────────────────────────────────────────

export interface CloseLicenseGrantParams extends Actor {
  grant: LicenseGrantRow;
  status: 'withdrawn' | 'expired';
  now: string;
  /** Required for a withdraw. */
  reason?: string | null;
  vendorPlan: VendorPlanSnapshot | null;
  /** `metadata.source` on the audit row. */
  auditSource: string;
}

export interface CloseLicenseGrantBatch {
  stmts: BatchStmt[];
  auditEntry: AuditLogEntry;
  row: LicenseGrantRow;
}

/**
 * A pending grant withdrawn or expired: the guarded UPDATE, `changedOneRowSentinel` (a
 * grant accepted or closed since the read aborts the batch, audit row included), and its
 * audit row.
 */
export function closeLicenseGrantStatements(
  db: Db,
  p: CloseLicenseGrantParams,
): CloseLicenseGrantBatch {
  const now = toIsoTimestamp(p.now);
  const withdrawReason = p.status === 'withdrawn' ? (p.reason ?? null) : null;
  const row: LicenseGrantRow = {
    ...p.grant,
    status: p.status,
    decidedAt: now,
    decidedBy: p.actorId,
    withdrawReason,
    updatedAt: now,
  };
  const auditEntry = grantEntry(
    p,
    p.status === 'withdrawn' ? LICENSE_GRANT_ACTION.withdrawn : LICENSE_GRANT_ACTION.expired,
    p.grant,
    row,
    p.vendorPlan,
    { source: p.auditSource, ...(withdrawReason ? { reason: withdrawReason } : {}) },
  );
  return {
    stmts: [
      db
        .update(licenseGrants)
        .set({
          status: p.status,
          decidedAt: now,
          decidedBy: p.actorId,
          withdrawReason,
          updatedAt: now,
        })
        .where(and(eq(licenseGrants.id, p.grant.id), eq(licenseGrants.status, PENDING))),
      changedOneRowSentinel(db),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
    row,
  };
}

/** Pending ban-term grants on an account that name `endedLicenseId` (the "already
 *  restored" refusal counts them). */
export async function pendingBanTermEndedIds(
  db: Db,
  billingAccountId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ itemsJson: licenseGrants.itemsJson })
    .from(licenseGrants)
    .where(
      and(
        eq(licenseGrants.billingAccountId, billingAccountId),
        eq(licenseGrants.kind, 'ban_term'),
        eq(licenseGrants.status, PENDING),
      ),
    );
  const out = new Set<string>();
  for (const row of rows) for (const item of grantItems(row)) out.add(item.ended_license_id);
  return out;
}

/** The pending-email ledger keys, one per grant per owner seat. */
export const licenseGrantPendingKey = (grantId: string, profileId: string) =>
  `license-grant-pending:${grantId.toLowerCase()}:${profileId}`;
export const licenseGrantReminderKey = (grantId: string, profileId: string) =>
  `license-grant-pending-reminder:${grantId.toLowerCase()}:${profileId}`;
