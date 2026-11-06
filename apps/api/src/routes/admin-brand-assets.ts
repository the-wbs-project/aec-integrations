/**
 * Pending brand asset removals and the operator's hold (AECI-1618, `ADMIN_PANEL_SPEC.md`
 * §5.7, `STAGE_2_5_SPEC.md` §11). A hold delays the daily job, never past the limit
 * (`lib/brand-asset-removal.ts`).
 */

import {
  AdminBrandAssetHoldResponseSchema,
  AdminBrandAssetHoldSchema,
  ApiErrorCode,
  ListBrandAssetRemovalsResponseSchema,
  type AdminBrandAssetHoldResponse,
  type BrandAssetRemoval,
  type ListBrandAssetRemovalsResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { auditLog, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { vendorAuditStamp } from '../lib/audit-vendor';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  brandAssetLimitAt,
  brandAssetNextRunAt,
  planBrandAssetRows,
} from '../lib/brand-asset-removal';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { ONE_ROW } from '../lib/integration-claims';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { CLAIM_ENDED_ACTION } from '../lib/vendor-handback';
import { parseJsonBody } from './vendor-shared';

type AdminContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

const AUDIT_SOURCE = 'admin-panel';
const ID_CHUNK = 80;
const HOLD_RACE_TOKEN = 'brand-asset-hold-race';

/** The cause on each company's newest `vendor.claim_ended` row. */
async function claimEndCauses(
  db: ReturnType<typeof getDb>['db'],
  vendorIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < vendorIds.length; i += ID_CHUNK) {
    const rows = await db
      .select({ id: auditLog.entityId, metadata: auditLog.metadata })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, CLAIM_ENDED_ACTION),
          eq(auditLog.entityType, 'vendor'),
          inArray(auditLog.entityId, vendorIds.slice(i, i + ID_CHUNK)),
        ),
      )
      .orderBy(desc(auditLog.createdAt));
    for (const row of rows) {
      const cause = (row.metadata as { cause?: unknown } | null)?.cause;
      if (row.id && typeof cause === 'string' && !out.has(row.id)) out.set(row.id, cause);
    }
  }
  return out;
}

export function createListBrandAssetRemovalsHandler(
  dbFor: DbFactory = getDb,
): (c: AdminContext) => Promise<Response> {
  return async (c) => {
    const { db } = dbFor(c.env);
    const pending = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        companyName: vendors.companyName,
        logoUrl: vendors.logoUrl,
        logoSource: vendors.logoSource,
        sourcedLogoUrl: vendors.sourcedLogoUrl,
        claimEndedAt: vendors.claimEndedAt,
        holdAt: vendors.brandAssetsHoldAt,
      })
      .from(vendors)
      .where(and(isNotNull(vendors.claimEndedAt), isNull(vendors.brandAssetsRemovedAt)))
      .orderBy(asc(vendors.claimEndedAt), asc(vendors.id));
    const causes = await claimEndCauses(
      db,
      pending.map((row) => row.id),
    );
    const now = new Date();
    const data: BrandAssetRemoval[] = [];
    for (const vendor of pending) {
      const claimEndedAt = vendor.claimEndedAt!;
      const plan = await planBrandAssetRows(db, vendor);
      data.push({
        vendor_id: vendor.id,
        vendor_slug: vendor.slug,
        company_name: vendor.companyName,
        claim_ended_at: claimEndedAt,
        cause: causes.get(vendor.id) ?? null,
        hold_at: vendor.holdAt,
        limit_at: brandAssetLimitAt(claimEndedAt),
        next_run_at: brandAssetNextRunAt(claimEndedAt, vendor.holdAt, now),
        affected_rows: plan.rows.map((row) => ({
          entity_type: row.entityType,
          id: row.id,
          slug: row.slug,
          name: row.name,
          logo_url: row.logoUrl,
          sourced_logo_url: row.sourcedLogoUrl,
        })),
        skipped_product_ids: plan.skippedProductIds,
      });
    }
    const body: ListBrandAssetRemovalsResponse = { data };
    validateResponseInDev(c.env, () => ListBrandAssetRemovalsResponseSchema.parse(body));
    return json(body);
  };
}

function createHoldHandler(set: boolean, dbFor: DbFactory) {
  return async (c: AdminContext): Promise<Response> => {
    const vendorId = c.req.param('id') ?? '';
    const { reason, internalNote } = await parseJsonBody(c, AdminBrandAssetHoldSchema);
    const { db } = writeDb(c, dbFor);
    const auth = c.get('auth');
    const [vendor, stamp] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, brandAssetsHoldAt: true },
        where: eq(vendors.id, vendorId),
      }),
      vendorAuditStamp(db, vendorId),
    ]);
    if (!vendor) throw notFoundError('vendor', { id: vendorId });

    const now = new Date().toISOString();
    const holdAt = set ? now : null;
    const entry: AuditLogEntry = {
      actorId: auth.userId,
      actorType: auditActorType(auth),
      action: set ? 'vendor.brand_assets_hold_set' : 'vendor.brand_assets_hold_lifted',
      entityType: 'vendor',
      entityId: vendorId,
      ...stamp,
      beforeState: { brand_assets_hold_at: vendor.brandAssetsHoldAt },
      afterState: { brand_assets_hold_at: holdAt },
      metadata: {
        source: AUDIT_SOURCE,
        vendorId,
        reason,
        ...(internalNote ? { internalNote } : {}),
      },
    };
    const pending = and(
      eq(vendors.id, vendorId),
      isNotNull(vendors.claimEndedAt),
      isNull(vendors.brandAssetsRemovedAt),
    );
    try {
      await db.batch([
        db
          .update(vendors)
          // Nothing public changes, so `updated_at` stays for the nightly sync.
          .set({ brandAssetsHoldAt: holdAt, updatedAt: sql`${vendors.updatedAt}` })
          .where(
            and(
              pending,
              set ? isNull(vendors.brandAssetsHoldAt) : isNotNull(vendors.brandAssetsHoldAt),
            ),
          ),
        db
          .select({ guard: sql`CASE WHEN changes() = 0 THEN json(${HOLD_RACE_TOKEN}) END` })
          .from(ONE_ROW),
        auditInsert(db, entry),
      ] as BatchTuple);
    } catch (error) {
      if (!/malformed JSON|brand-asset-hold-race/i.test(causeText(error))) throw error;
      throw set
        ? new ApiError(
            409,
            ApiErrorCode.BRAND_ASSETS_NOT_PENDING,
            'This company has no logo removal to hold, or it is already held.',
          )
        : new ApiError(409, ApiErrorCode.BRAND_ASSETS_NOT_HELD, 'There is no hold to lift.');
    }
    forwardAuditBatch(c, [entry], [], AUDIT_SOURCE);
    const body: AdminBrandAssetHoldResponse = { vendor_id: vendorId, hold_at: holdAt };
    validateResponseInDev(c.env, () => AdminBrandAssetHoldResponseSchema.parse(body));
    return json(body);
  };
}

function causeText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    parts.push(String((current as { message?: unknown }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join(' ');
}

export function createSetBrandAssetHoldHandler(dbFor: DbFactory = getDb) {
  return createHoldHandler(true, dbFor);
}

export function createLiftBrandAssetHoldHandler(dbFor: DbFactory = getDb) {
  return createHoldHandler(false, dbFor);
}
