/**
 * An owner seat puts a pool license on a product, and flags a license to free its slot
 * at renewal (AECI-1388, E5.2 of AECI-1335; `VENDOR_SIGNUP_PROCESS.md` §2 decisions 10
 * and 11, §3 step 6) — Drizzle/D1.
 *
 *   POST  /api/vendor/licenses/:id/assign   `{ product_id }`          → 200 `{ license }`
 *   PATCH /api/vendor/licenses/:id          `{ release_at_renewal }`  → 200 `{ license }`
 *
 * Both answer with the license as it stands after the write, in the Billing read's
 * shape (`VendorLicenseResponseSchema`; the row mapper is `vendor-billing.ts`'s).
 *
 * ── GATES, IN ORDER ──────────────────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration. Then
 * `requireSeatOwner()` here: licenses are an owner's act (decision 10), so a member
 * seat gets `403`. No capability gate: the fourth named exception of
 * `API_CONTRACTS.md` §6.14 invariant 3. The vendor id comes from the session; the
 * licenses and the product are re-read from D1, never trusted from the session.
 *
 * Assign:
 *   - license not on the caller's billing account, or unknown: `404` (one answer);
 *   - product not owned by the caller (`product_vendors`), or unknown: `404`;
 *   - license ended: `409 LICENSE_NOT_LIVE`;
 *   - license already on a product: `409 LICENSE_ALREADY_ASSIGNED`. Moving it is an
 *     early-unassign request (decision 11), never a reassign;
 *   - product already holds a live license from ANY vendor, a co-owner included:
 *     `409 PRODUCT_ALREADY_LICENSED`. Pre-checked, and a lost race on the partial
 *     unique index `licenses_live_product_idx` maps to the same `409`, never a 500.
 *
 * Release at renewal:
 *   - license not the caller's: `404`; ended or on no product: `409
 *     LICENSE_NOT_ASSIGNED`; the flag already holds the asked value: `200`, no write.
 *
 * ── ONE BATCH ────────────────────────────────────────────────────────────────
 * The `lib/license.ts` builder's statements (the guarded UPDATE, its audit row, the
 * mirror reconcile) with `source: 'vendor-portal'`. Two changes to its batch:
 *   - a {@link changedOneRowSentinel} straight after the UPDATE, so a race lost
 *     between the read and the commit writes nothing at all, audit row included;
 *   - the audit row is rebuilt through `vendorAuditEntry` (AECI-1192), so the row and
 *     its forward carry the same vendor and plan stamps.
 *
 * After commit, `afterVendorWrite`. An assign purges `product:{slug}`, `index:products`
 * and `vendor:{slug}`: the product's plan badge changes on public pages. The flag is
 * read by no public page, so the PATCH purges nothing.
 */

import {
  ApiErrorCode,
  AssignLicenseRequestSchema,
  UpdateLicenseRequestSchema,
  VendorLicenseResponseSchema,
  type VendorLicenseResponse,
} from '@aeci/shared';
import { and, eq, isNull } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { billingAccounts, licenses, productVendors, products, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  assignLicenseStatements,
  loadVendorLicenses,
  setReleaseAtRenewalStatements,
  toIsoTimestamp,
  type LicenseBatch,
} from '../lib/license';
import { changedOneRowSentinel, isReleaseRaceError } from '../lib/license-release-requests';
import { toVendorBillingLicense, vendorLicenseSelect } from './vendor-billing';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  type VendorContext,
  vendorAuditEntry,
} from './vendor-shared';

const OWNER_ONLY = 'Only a vendor account owner can manage licenses';

function licenseIdParam(c: VendorContext): string {
  const id = c.req.param('id');
  if (!id) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing license id', {
      field: 'id',
    });
  }
  return id;
}

const notLive = () => new ApiError(409, ApiErrorCode.LICENSE_NOT_LIVE, 'This license has ended.');
const alreadyAssigned = () =>
  new ApiError(
    409,
    ApiErrorCode.LICENSE_ALREADY_ASSIGNED,
    'This license is already on a product. Ask us to free it early to move it.',
  );
const productLicensed = () =>
  new ApiError(
    409,
    ApiErrorCode.PRODUCT_ALREADY_LICENSED,
    'This product already has a live license.',
  );
const notAssigned = () =>
  new ApiError(
    409,
    ApiErrorCode.LICENSE_NOT_ASSIGNED,
    'This license is not on a product, so it has no slot to free at renewal.',
  );

/** True for the partial unique index on `licenses.assigned_product_id`, in D1 or SQLite. */
function isLiveProductConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (
      /UNIQUE constraint failed: licenses\.assigned_product_id|licenses_live_product_idx/i.test(
        text,
      )
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The builder's pre-read: the vendor's slug and mirror bit, and every license. */
async function loadContext(db: Db, vendorId: string) {
  const [vendor, vendorLicenses] = await Promise.all([
    db.query.vendors.findFirst({
      columns: { slug: true, verified: true },
      where: eq(vendors.id, vendorId),
    }),
    loadVendorLicenses(db, vendorId),
  ]);
  return { vendor, vendorLicenses };
}

/**
 * The builder's single-license batch, `[UPDATE, audit, reconcile]`, with the race
 * sentinel after the UPDATE and the audit row stamped by `vendorAuditEntry`. Every
 * caller has proved the builder is not a no-op.
 */
function vendorLicenseStatements(c: VendorContext, db: Db, batch: LicenseBatch): BatchStmt[] {
  const [update, ...rest] = batch.stmts;
  const reconcile = rest.at(-1);
  if (!update || !reconcile || rest.length !== batch.auditEntries.length + 1) {
    throw new Error('license builder returned an unexpected batch shape');
  }
  return [
    update,
    changedOneRowSentinel(db),
    ...batch.auditEntries.map((entry) => auditInsert(db, vendorAuditEntry(c, entry))),
    reconcile,
  ];
}

/** The license after the write, for the response. */
async function respond(c: VendorContext, db: Db, vendorId: string, licenseId: string) {
  const [row] = await vendorLicenseSelect(db)
    .where(and(eq(licenses.id, licenseId), eq(billingAccounts.vendorId, vendorId)))
    .limit(1);
  if (!row) throw notFoundError('license', { id: licenseId });
  const body: VendorLicenseResponse = { license: toVendorBillingLicense(row) };
  validateResponseInDev(c.env, () => VendorLicenseResponseSchema.parse(body));
  return json(body);
}

/** `POST /api/vendor/licenses/:id/assign`. */
export function createAssignVendorLicenseHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const licenseId = licenseIdParam(c);
    const { db } = writeDb(c, dbFor);

    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);
    const { product_id: productId } = await parseJsonBody(c, AssignLicenseRequestSchema);

    const [{ vendor, vendorLicenses }, [product], [liveOnProduct]] = await Promise.all([
      loadContext(db, vendorId),
      db
        .select({ id: products.id, slug: products.slug })
        .from(productVendors)
        .innerJoin(products, eq(products.id, productVendors.productId))
        .where(and(eq(productVendors.productId, productId), eq(productVendors.vendorId, vendorId)))
        .limit(1),
      // Any vendor's live license: a co-owner's blocks the index too.
      db
        .select({ id: licenses.id })
        .from(licenses)
        .where(and(eq(licenses.assignedProductId, productId), isNull(licenses.endedAt)))
        .limit(1),
    ]);

    const license = vendorLicenses.find((l) => l.id === licenseId);
    if (!license || !vendor) throw notFoundError('license', { id: licenseId });
    if (!product) throw notFoundError('product', { id: productId });
    if (license.endedAt !== null) throw notLive();
    if (license.assignedProductId !== null) throw alreadyAssigned();
    if (liveOnProduct) throw productLicensed();

    const batch = assignLicenseStatements(db, {
      vendorId,
      now: toIsoTimestamp(new Date()),
      actorId: session.userId,
      actorType: auditActorType(session),
      vendorLicenses,
      vendorWasVerified: vendor.verified,
      source: AUDIT_SOURCE,
      licenseId,
      productId,
    });
    // The pre-read proved the license live and in the pool, so this is a guard only.
    if (batch.auditEntries.length === 0) throw alreadyAssigned();

    try {
      await db.batch(vendorLicenseStatements(c, db, batch) as BatchTuple);
    } catch (error) {
      if (isLiveProductConflict(error)) throw productLicensed();
      // The guarded UPDATE matched nothing: the license was assigned or ended since
      // the read.
      if (isReleaseRaceError(error)) throw alreadyAssigned();
      throw error;
    }

    afterVendorWrite(
      c,
      [`product:${product.slug}`, 'index:products', `vendor:${vendor.slug}`],
      batch.auditEntries,
    );
    return respond(c, db, vendorId, licenseId);
  };
}

/** `PATCH /api/vendor/licenses/:id`. */
export function createUpdateVendorLicenseHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const licenseId = licenseIdParam(c);
    const { db } = writeDb(c, dbFor);

    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);
    const { release_at_renewal: release } = await parseJsonBody(c, UpdateLicenseRequestSchema);

    const { vendor, vendorLicenses } = await loadContext(db, vendorId);
    const license = vendorLicenses.find((l) => l.id === licenseId);
    if (!license || !vendor) throw notFoundError('license', { id: licenseId });
    if (license.endedAt !== null || license.assignedProductId === null) throw notAssigned();

    // Already as asked: a 200 that writes nothing.
    if (license.releaseAtRenewal === release) return respond(c, db, vendorId, licenseId);

    const batch = setReleaseAtRenewalStatements(db, {
      vendorId,
      now: toIsoTimestamp(new Date()),
      actorId: session.userId,
      actorType: auditActorType(session),
      vendorLicenses,
      vendorWasVerified: vendor.verified,
      source: AUDIT_SOURCE,
      licenseId,
      release,
    });
    if (batch.auditEntries.length === 0) return respond(c, db, vendorId, licenseId);

    try {
      await db.batch(vendorLicenseStatements(c, db, batch) as BatchTuple);
    } catch (error) {
      // The guarded UPDATE matched nothing: the license ended, or (when setting) was
      // unassigned or moved by an approved early release, since the read.
      if (isReleaseRaceError(error)) throw notAssigned();
      throw error;
    }

    // No public page reads the flag: no purge. The tail still forwards the audit row.
    afterVendorWrite(c, [], batch.auditEntries);
    return respond(c, db, vendorId, licenseId);
  };
}
