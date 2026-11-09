/**
 * The removal election (AECI-1618, `STAGE_2_5_SPEC.md` §12.2): for 30 UTC days after
 * Managed ends on a product, an owner seat may blank the text the vendor wrote. Vendor
 * Terms promise this.
 *
 * Description, the "How teams use it" narrative and the two doc URLs only. Tags stay as
 * catalog data, and reviews are not the vendor's. The window is computed from the license
 * end date, so nothing has to close it. `usefulness_source` and `maintained_by` stay, so
 * promote cannot refill the fields.
 */

import {
  ApiErrorCode,
  CreateRemovalElectionResponseSchema,
  CreateRemovalElectionSchema,
  REMOVAL_ELECTION_FIELDS,
  RemovalElectionResponseSchema,
  type CreateRemovalElectionResponse,
  type RemovalElectionField,
  type RemovalElectionResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { auditLog, billingAccounts, licenses, products } from '../db/schema';
import { ApiError } from '../errors';
import { json } from '../http';
import { auditInsert, landedAuditEntries, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import {
  activeLocksOn,
  fieldsUnlockedSentinel,
  isSentinelJsonAbort,
  lockRaceRefusal,
} from '../lib/field-overrides';
import { vendorEditHideClears } from '../lib/field-hides';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireOwnedProduct,
  requireSeatOwner,
  sessionVendorId,
  vendorAuditEntry,
  type OwnedProduct,
  type VendorContext,
} from './vendor-shared';

export const AUTHORED_CONTENT_REMOVED_ACTION = 'product.authored_content_removed';

/** Terms: "For 30 days after that date". Counted in whole UTC days. */
export const REMOVAL_ELECTION_DAYS = 30;

const DAY_MS = 86_400_000;

const FIELD_COLUMN = {
  description: 'description',
  usefulness: 'usefulness',
  tool_integrations_url: 'toolIntegrationsUrl',
  api_docs_url: 'apiDocsUrl',
} as const satisfies Record<
  RemovalElectionField,
  'description' | 'usefulness' | 'toolIntegrationsUrl' | 'apiDocsUrl'
>;

function utcDay(iso: string): number {
  const at = new Date(iso);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

/** The window's end, or null when none is open. */
async function electionClosesAt(
  db: Db,
  vendorId: string,
  productId: string,
  now: string,
): Promise<string | null> {
  const rows = await db
    .select({
      endedAt: licenses.endedAt,
      endReason: licenses.endReason,
      vendorId: billingAccounts.vendorId,
    })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .where(eq(licenses.assignedProductId, productId));
  // A live license from any vendor means Managed has not ended on this product.
  if (rows.some((row) => row.endedAt === null)) return null;
  const latest = rows
    .filter((row) => row.vendorId === vendorId)
    .reduce<
      (typeof rows)[number] | null
    >((best, row) => (!best || Date.parse(row.endedAt!) > Date.parse(best.endedAt!) ? row : best), null);
  // `banned` is a termination: the seats are banned, and ruling 5 keeps the text as is.
  if (!latest?.endedAt || latest.endReason === 'banned') return null;
  const lastDay = utcDay(latest.endedAt) + REMOVAL_ELECTION_DAYS * DAY_MS;
  if (utcDay(now) > lastDay) return null;
  return new Date(lastDay + DAY_MS - 1).toISOString();
}

/** A vendor seat wrote it, and what is stored now is what that seat wrote. Read newest
 *  first, so a later edit by AECi or promote stops the field qualifying. */
async function vendorAuthoredColumns(db: Db, productId: string): Promise<Set<string>> {
  const rows = await db
    .select({ action: auditLog.action, after: auditLog.afterState, source: auditLog.metadata })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'product'),
        eq(auditLog.entityId, productId),
        eq(auditLog.actorType, 'user'),
        inArray(auditLog.action, ['product.updated', 'product.created']),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id));
  const current = await db.query.products.findFirst({
    columns: { description: true, toolIntegrationsUrl: true, apiDocsUrl: true },
    where: eq(products.id, productId),
  });
  const authored = new Set<string>();
  if (!current) return authored;
  for (const column of ['description', 'toolIntegrationsUrl', 'apiDocsUrl'] as const) {
    for (const row of rows) {
      if ((row.source as { source?: unknown } | null)?.source !== AUDIT_SOURCE) continue;
      const after = (row.after ?? {}) as Record<string, unknown>;
      if (row.action === 'product.updated' && column in after) {
        if (after[column] === current[column]) authored.add(column);
        break;
      }
      // A vendor-created product (AECI-1424): the create row lists wire fields, no values.
      const created = Array.isArray(after.fields) ? (after.fields as unknown[]) : [];
      if (row.action === 'product.created' && column === 'description') {
        if (created.includes('description')) authored.add(column);
        break;
      }
    }
  }
  return authored;
}

async function eligibleFields(db: Db, owned: OwnedProduct): Promise<RemovalElectionField[]> {
  const { product } = owned;
  const [authored, locks] = await Promise.all([
    vendorAuthoredColumns(db, product.id),
    activeLocksOn(db, 'product', product.id),
  ]);
  const locked = new Set(locks.map((lock) => lock.field as string));
  return REMOVAL_ELECTION_FIELDS.filter((field) => {
    if (locked.has(field)) return false;
    if (field === 'usefulness') {
      return product.usefulnessSource === 'vendor' && product.usefulness != null;
    }
    const column = FIELD_COLUMN[field];
    return product[column] != null && authored.has(column);
  });
}

async function latestElection(db: Db, productId: string): Promise<string | null> {
  const [row] = await db
    .select({ at: auditLog.createdAt })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, 'product'),
        eq(auditLog.entityId, productId),
        eq(auditLog.action, AUTHORED_CONTENT_REMOVED_ACTION),
      ),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(1);
  return row?.at ?? null;
}

function closedError(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.REMOVAL_ELECTION_CLOSED,
    'The 30 days to remove your text from this product are not open.',
  );
}

export function createGetRemovalElectionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    const owned = await requireOwnedProduct(db, vendorId, c.req.param('id') ?? '');
    const now = new Date().toISOString();
    const [closesAt, electedAt] = await Promise.all([
      electionClosesAt(db, vendorId, owned.product.id, now),
      latestElection(db, owned.product.id),
    ]);
    const body: RemovalElectionResponse = {
      eligible_fields: closesAt ? await eligibleFields(db, owned) : [],
      closes_at: closesAt,
      elected_at: electedAt,
    };
    validateResponseInDev(c.env, () => RemovalElectionResponseSchema.parse(body));
    return json(body);
  };
}

export function createRemovalElectionHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    const owned = await requireOwnedProduct(db, vendorId, c.req.param('id') ?? '');
    const { product, vendor } = owned;
    await requireSeatOwner(
      db,
      session.userId,
      vendorId,
      'Only a vendor account owner can remove this text',
    );
    await parseJsonBody(c, CreateRemovalElectionSchema);

    const now = new Date().toISOString();
    if (!(await electionClosesAt(db, vendorId, product.id, now))) throw closedError();
    const fields = await eligibleFields(db, owned);
    if (fields.length === 0) {
      throw new ApiError(
        409,
        ApiErrorCode.REMOVAL_ELECTION_EMPTY,
        'None of the text on this product is yours to remove.',
      );
    }

    const beforeState: Record<string, unknown> = {};
    const afterState: Record<string, null> = {};
    const blank: Partial<Record<(typeof FIELD_COLUMN)[RemovalElectionField], null>> = {};
    for (const field of fields) {
      const column = FIELD_COLUMN[field];
      beforeState[column] = product[column];
      afterState[column] = null;
      blank[column] = null;
    }
    const entry: AuditLogEntry = {
      actorId: session.userId,
      actorType: auditActorType(session),
      action: AUTHORED_CONTENT_REMOVED_ACTION,
      entityType: 'product',
      entityId: product.id,
      productId: product.id,
      beforeState,
      afterState,
      metadata: { source: AUDIT_SOURCE, vendorId, fields },
    };

    // AECI-1238 (§11d.7): blanking a hidden value changes it, so its hide ends here.
    // Every eligible field holds a value, so every one of them changes.
    const hideClear = await vendorEditHideClears(db, {
      entityType: 'product',
      entityId: product.id,
      changedFields: fields.filter((field) => field !== 'usefulness'),
      actor: { actorId: session.userId, actorType: auditActorType(session) },
      stampEntry: (audit) => vendorAuditEntry(c, audit),
      at: now,
      source: AUDIT_SOURCE,
    });

    // A license granted, or a lock set, after the reads above aborts the batch.
    const liveLicense = sql`EXISTS (SELECT 1 FROM ${licenses} WHERE ${licenses.assignedProductId} = ${product.id} AND ${isNull(licenses.endedAt)})`;
    const lockSentinel = fieldsUnlockedSentinel(db, 'product', product.id, fields);
    const stmts: BatchStmt[] = [
      db
        .select({ guard: sql`CASE WHEN ${liveLicense} THEN json('removal-election-closed') END` })
        .from(ONE_ROW),
      ...(lockSentinel ? [lockSentinel] : []),
      db
        .update(products)
        .set({ ...blank, updatedAt: now })
        .where(eq(products.id, product.id)),
      auditInsert(db, vendorAuditEntry(c, entry)),
      ...hideClear.stmts,
    ];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (!isSentinelJsonAbort(error)) throw error;
      throw (await lockRaceRefusal(db, 'product', product.id, fields)) ?? closedError();
    }

    // `updated_at` moved the portal's freshness cursor and the nightly Algolia window.
    const landedClears = hideClear.audits.length
      ? await landedAuditEntries(db, hideClear.audits)
      : [];
    afterVendorWrite(
      c,
      [`product:${product.slug}`, `vendor:${vendor.slug}`, 'index:products'],
      [entry, ...landedClears],
      undefined,
      db,
    );
    const body: CreateRemovalElectionResponse = { removed_fields: fields, elected_at: now };
    validateResponseInDev(c.env, () => CreateRemovalElectionResponseSchema.parse(body));
    return json(body);
  };
}
