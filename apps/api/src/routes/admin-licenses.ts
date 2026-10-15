/**
 * Admin license grant (AECI-1370, E4.1; `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 5,
 * decisions 6, 16 and 17).
 *
 *   POST /api/admin/vendors/:id/licenses, behind `requireAdmin()` and the `write`
 *   rate limit.
 *
 * Writes N UNASSIGNED complimentary or invoice licenses on the vendor's billing
 * account, through `grantLicensesStatements` in `lib/license.ts` (the one license
 * writer). One `db.batch`: N INSERTs, one `license.granted` audit row per license
 * (`entity_type = 'billing_account'`, `metadata.license_id`), then the
 * `vendors.verified` mirror reconcile. A grant assigns nothing. Assignment is the
 * vendor's (E5), so no product changes plan.
 *
 * ── IDEMPOTENT ON `grant_id` ────────────────────────────────────────────────────
 * The builder's INSERTs carry no guard (`lib/license.ts`, "GUARDED WRITES"), so a
 * double submit would write 2N licenses. The control mints `grant_id` when its form
 * opens, and the license ids are UUIDv5s of it ({@link grantLicenseIds}). The handler
 * pre-reads those ids plus the next one:
 *
 *   - none exists: write, 201.
 *   - exactly this grant exists (same account, count, source, end date, reference,
 *     and start when one was sent): 200 replay with the stored rows. Nothing is
 *     written and no email is sent.
 *   - anything else: 409 `LICENSE_GRANT_CONFLICT`. A race between the pre-read and
 *     the batch loses on the `licenses` primary key and answers the same 409. The
 *     batch rolled back whole, so nothing was written.
 *
 * ── PURGE ONLY ON A MIRROR FLIP ─────────────────────────────────────────────────
 * Unassigned licenses change no product's plan. But the first live license moves
 * `vendors.verified` (the reconcile), and the pair-page version-diff gate reads that
 * mirror (`lib/pair-version-diff.ts`). So the handler purges the vendor tag set
 * (`vendorPurgeTags`) when the builder predicts a flip, and not otherwise.
 *
 * ── CONNECTOR VENDORS WARN, NEVER GATE ──────────────────────────────────────────
 * A vendor whose every product is a connector gets a `warnings[]` entry and the
 * grant still writes (the AECI-738 rule, the predicate `isPureConnectorVendor`).
 * Connector vendors and licenses are parked (AECI-1343).
 *
 * ── THE EMAIL ───────────────────────────────────────────────────────────────────
 * Post-commit in `waitUntil`, `licenses-granted` to every unbanned seat and to the
 * billing email when one is set (decision 16; ruling 3 of 2026-10-15). One send per
 * address, keyed `licenses-granted:{grant_id}:{recipient hash}`. Without the GoTrue
 * service-role key no seat resolves: the billing email still gets it, and the
 * handler warns. A failed send never fails the response.
 */

import {
  ApiErrorCode,
  GrantLicensesResponseSchema,
  GrantLicensesSchema,
  type AdminGrantedLicense,
  type GrantLicensesInput,
  type GrantLicensesResponse,
  type GrantLicensesWarning,
} from '@aeci/shared';
import { LICENSE_SOURCES, type LicenseSource } from '@aeci/shared/entitlements';
import { eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { billingAccounts, licenses, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logToPosthog } from '../posthog';
import type { BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { uuidv5 } from '../lib/backfill-licenses';
import { loadBillingAccount } from '../lib/billing-account';
import { sendLicensesGrantedEmail, type EmailContext } from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import { grantLicensesStatements, loadVendorLicenses, toIsoTimestamp } from '../lib/license';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import { vendorPurgeTags } from '../lib/vendor-cache-tags';
import {
  EMPTY_PRODUCT_ROLES,
  foldProductRoleGroups,
  isPureConnectorVendor,
  productRolesForVendor,
  selectProductRoleGroups,
} from '../lib/vendor-product-roles';
import { loadVendorSeatRecipients, type FetchSeatEmails } from '../lib/vendor-seat-recipients';
import { purgeTags } from './vendor-shared';

type LicensesContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The sender, injected so specs never touch Resend. */
export type SendLicensesGranted = typeof sendLicensesGrantedEmail;

/**
 * The namespace every grant license id is minted under:
 * `uuidv5('https://aecintegrations.com/admin/license-grants', URL_NAMESPACE)`.
 * Pinned as a literal so a refactor cannot re-mint the ids, which would turn a retry
 * of an old grant into a second grant. The spec re-derives it.
 */
export const LICENSE_GRANT_NAMESPACE = '430cf19f-d3b1-5318-9e2e-7753dc1577ab';

/**
 * The license ids of one grant: `uuidv5('license:{grantId}:{i}')` for i in
 * `0..count-1`. UUID-shaped, so every later route that takes a license id in its
 * path validates them like any other.
 */
export function grantLicenseIds(grantId: string, count: number): Promise<string[]> {
  return Promise.all(
    Array.from({ length: count }, (_, i) =>
      uuidv5(`license:${grantId.toLowerCase()}:${i}`, LICENSE_GRANT_NAMESPACE),
    ),
  );
}

/** The ledger key of one grant email to one address. Holds the address's hash, never
 *  the address (AECI-1203). */
export async function licensesGrantedDedupeKey(grantId: string, address: string): Promise<string> {
  return `licenses-granted:${grantId.toLowerCase()}:${await recipientHash(address)}`;
}

async function parseJsonBody(c: LicensesContext): Promise<GrantLicensesInput> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return GrantLicensesSchema.parse(raw);
}

function grantConflict(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LICENSE_GRANT_CONFLICT,
    'This grant id was already used for a different grant. Reload and grant again.',
  );
}

/** True for the primary-key violation a racing grant with the same ids raises. */
function isLicenseIdConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/UNIQUE constraint failed: licenses\.id/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

interface StoredGrantRow {
  id: string;
  billingAccountId: string;
  source: string;
  startsAt: string;
  endsAt: string | null;
  reference: string | null;
  assignedProductId: string | null;
}

function toGrantedLicense(row: StoredGrantRow): AdminGrantedLicense {
  return {
    id: row.id,
    // The column is unconstrained; a grant id only ever names rows this route wrote.
    source: (LICENSE_SOURCES as readonly string[]).includes(row.source)
      ? (row.source as LicenseSource)
      : 'complimentary',
    starts_at: row.startsAt,
    ends_at: row.endsAt,
    reference: row.reference,
    assigned_product_id: row.assignedProductId,
  };
}

// ─── POST /api/admin/vendors/:id/licenses ───────────────────────────────────

export function createGrantLicensesHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendGranted: SendLicensesGranted = sendLicensesGrantedEmail,
): (c: LicensesContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = c.req.param('id');
    if (!vendorId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing vendor id', {
        field: 'id',
      });
    }

    const payload = await parseJsonBody(c);
    const now = new Date().toISOString();
    const startsAt = toIsoTimestamp(payload.starts_at ?? now);
    const endsAt = toIsoTimestamp(payload.ends_at);
    // Instants, not strings: a date-only `ends_at` and a full-timestamp start do not
    // sort against each other (STAGE_2_PAID_TIERS_SPEC.md §5.5).
    if (Date.parse(endsAt) <= Date.parse(startsAt)) {
      throw new ApiError(
        400,
        ApiErrorCode.VALIDATION_FAILED,
        payload.starts_at
          ? 'ends_at must be after starts_at.'
          : 'ends_at must be after now, the default start.',
        { field: 'ends_at' },
      );
    }
    const reference = payload.reference || null;
    const notes = payload.notes || null;

    const { db } = writeDb(c, dbFor);
    const vendor = await db.query.vendors.findFirst({
      columns: { id: true, slug: true, companyName: true, verified: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });
    const account = await loadBillingAccount(db, vendor.id);
    if (!account) throw notFoundError('billing_account', { id: vendor.id });

    // The grant's ids plus the next one: a stored id past `quantity` means the first
    // call granted more, which is not this grant.
    const ids = await grantLicenseIds(payload.grant_id, payload.quantity + 1);
    const licenseIds = ids.slice(0, payload.quantity);
    const [vendorLicenses, stored, roleGroups] = await Promise.all([
      loadVendorLicenses(db, vendor.id),
      db
        .select({
          id: licenses.id,
          billingAccountId: licenses.billingAccountId,
          source: licenses.source,
          startsAt: licenses.startsAt,
          endsAt: licenses.endsAt,
          reference: licenses.reference,
          assignedProductId: licenses.assignedProductId,
        })
        .from(licenses)
        .where(inArray(licenses.id, ids)),
      selectProductRoleGroups(db, productRolesForVendor(vendor.id)),
    ]);

    const roles = foldProductRoleGroups(roleGroups).get(vendor.id) ?? { ...EMPTY_PRODUCT_ROLES };
    const warnings: GrantLicensesWarning[] = isPureConnectorVendor(roles)
      ? [
          {
            code: 'pure_connector_vendor',
            message:
              'Every product this vendor owns is a connector. Connector vendors and licenses are not settled yet (AECI-1343). The licenses were granted anyway.',
          },
        ]
      : [];

    const respond = (
      rows: readonly StoredGrantRow[],
      replayed: boolean,
      status: 200 | 201,
    ): Response => {
      const body: GrantLicensesResponse = {
        vendor_id: vendor.id,
        billing_account_id: account.id,
        grant_id: payload.grant_id,
        replayed,
        licenses: rows.map(toGrantedLicense),
        warnings,
      };
      validateResponseInDev(c.env, () => GrantLicensesResponseSchema.parse(body));
      return json(body, { status });
    };

    if (stored.length > 0) {
      const byId = new Map(stored.map((r) => [r.id, r]));
      const exact =
        stored.length === licenseIds.length &&
        licenseIds.every((id) => {
          const row = byId.get(id);
          return (
            row !== undefined &&
            row.billingAccountId === account.id &&
            row.source === payload.source &&
            row.endsAt === endsAt &&
            row.reference === reference &&
            (payload.starts_at === undefined || row.startsAt === startsAt)
          );
        });
      if (!exact) throw grantConflict();
      return respond(
        licenseIds.map((id) => byId.get(id)!),
        true,
        200,
      );
    }

    const batch = grantLicensesStatements(db, {
      vendorId: vendor.id,
      now,
      actorId: auth.userId,
      actorType: auditActorType(auth),
      vendorLicenses,
      vendorWasVerified: vendor.verified,
      extraMetadata: { grant_id: payload.grant_id, ...(notes ? { notes } : {}) },
      billingAccountId: account.id,
      count: payload.quantity,
      licenseSource: payload.source,
      startsAt,
      endsAt,
      reference,
      grantedBy: auth.userId,
      licenseIds,
    });

    try {
      await db.batch(batch.stmts as BatchTuple);
    } catch (error) {
      if (isLicenseIdConflict(error)) throw grantConflict();
      throw error;
    }

    forwardAuditBatch(c, batch.auditEntries, [], 'admin-licenses');

    if (batch.verifiedFlipped) {
      const tags = await vendorPurgeTags(db, vendor);
      c.executionCtx.waitUntil(purgeTags(c, tags, 'moderation'));
    }

    c.executionCtx.waitUntil(
      emailLicensesGranted(
        c,
        db,
        {
          grantId: payload.grant_id,
          vendorId: vendor.id,
          vendorName: vendor.companyName,
          billingAccountId: account.id,
          count: payload.quantity,
          source: payload.source,
          endsAt,
          reference,
        },
        fetchSeatEmails,
        sendGranted,
      ),
    );

    return respond(
      licenseIds.map((id) => ({
        id,
        billingAccountId: account.id,
        source: payload.source,
        startsAt,
        endsAt,
        reference,
        assignedProductId: null,
      })),
      false,
      201,
    );
  };
}

function warn(c: EmailContext, message: string, outcome?: string): void {
  logToPosthog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message,
    source: 'admin-licenses',
    ...(outcome ? { outcome } : {}),
  });
}

/**
 * The `licenses-granted` fan-out: every unbanned seat, plus the billing email when one
 * is set, each address once. Never throws: the grant is committed whatever happens
 * here, and the ledger records every send.
 */
export async function emailLicensesGranted(
  c: EmailContext,
  db: Db,
  input: {
    grantId: string;
    vendorId: string;
    vendorName: string;
    billingAccountId: string;
    count: number;
    source: 'complimentary' | 'invoice';
    endsAt: string;
    reference: string | null;
  },
  fetchSeatEmails: FetchSeatEmails,
  send: SendLicensesGranted,
): Promise<void> {
  try {
    const [seatMap, accountRow] = await Promise.all([
      loadVendorSeatRecipients(db, c.env, [input.vendorId], fetchSeatEmails),
      db.query.billingAccounts.findFirst({
        columns: { billingEmail: true },
        where: eq(billingAccounts.id, input.billingAccountId),
      }),
    ]);
    const seats = seatMap.get(input.vendorId) ?? [];
    if (seats.length === 0) {
      // No seat resolved: none exists, or the GoTrue service-role key is absent and
      // the seam returned nothing. The billing email, when set, still gets it.
      warn(c, 'licenses-granted: no seat address resolved; sending to the billing email only');
    }

    const addresses: string[] = [];
    const seen = new Set<string>();
    for (const address of [...seats.map((s) => s.email), accountRow?.billingEmail ?? '']) {
      const key = address.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      addresses.push(address.trim());
    }
    if (addresses.length === 0) {
      warn(c, 'licenses-granted: no recipient; nobody was emailed about the grant');
      return;
    }

    // One at a time: a handful of seats, and the Worker's connection limit is six.
    for (const to of addresses) {
      await send(c, {
        to,
        vendorName: input.vendorName,
        count: input.count,
        source: input.source,
        endsAt: input.endsAt,
        reference: input.reference,
        dedupeKey: await licensesGrantedDedupeKey(input.grantId, to),
        entity: { type: 'billing_account', id: input.billingAccountId },
      });
    }
  } catch (error) {
    warn(
      c,
      'licenses-granted email failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
