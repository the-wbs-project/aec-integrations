/**
 * Admin license grant (AECI-1370, E4.1; `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 5,
 * decisions 6, 16 and 17), and the edit of one license (AECI-1371, E4.2; see
 * {@link createUpdateLicenseHandler} and the block above it).
 *
 *   POST  /api/admin/vendors/:id/licenses, behind `requireAdmin()` and the `write`
 *   rate limit.
 *   PATCH /api/admin/licenses/:id, the same guards.
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
 * ── A FULLY BANNED VENDOR IS REFUSED (AECI-1589, ruled 2026-11-03) ───────────────
 * After the replay check, a vendor that has `vendor_admin` seats and every one banned
 * answers 409 `VENDOR_STILL_BANNED`. The operator unbans a seat first. A vendor with no
 * seat at all (never claimed) is still grantable. A termination that commits between
 * the read and the batch trips `unbannedSeatExistsSentinel` (`allowNoSeats`) and
 * answers 409 `VENDOR_SEATS_CHANGED`, nothing granted.
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
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  WithdrawLicenseGrantResponseSchema,
  WithdrawLicenseGrantSchema,
  type WithdrawLicenseGrantInput,
  type WithdrawLicenseGrantResponse,
  BanTermLicensesResponseSchema,
  BanTermLicensesSchema,
  GrantLicensesResponseSchema,
  GrantLicensesSchema,
  UpdateLicenseResponseSchema,
  UpdateLicenseSchema,
  vendorVisibleReasonMetadata,
  type AdminGrantedLicense,
  type BanTermLicensesInput,
  type BanTermLicensesResponse,
  type GrantLicensesInput,
  type GrantLicensesResponse,
  type GrantLicensesWarning,
  type UpdateLicenseInput,
  type UpdateLicenseResponse,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import {
  LICENSE_SOURCES,
  licensePlanSnapshot,
  type LicenseSource,
} from '@aeci/shared/entitlements';
import { and, eq, inArray } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import {
  agreementAcceptances,
  billingAccounts,
  licenseGrants,
  licenses,
  products,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { logToPosthog } from '../posthog';
import { aeciOverrideNotificationAudit } from '../lib/aeci-override-notifications';
import { loadBillingEmails, mergeRecipientAddresses } from '../lib/billing-recipients';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { loadBillingAccount } from '../lib/billing-account';
import {
  sendLicenseGrantPendingEmail,
  sendLicensesGrantedEmail,
  sendManagedEndedEmail,
  type EmailContext,
} from '../lib/email';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { recipientHash } from '../lib/hash';
import {
  isContestRaceError,
  planLastLicenseReroute,
  type LastLicenseReroutePlan,
} from '../lib/integration-contests';
import {
  endLicensesStatements,
  loadOwnedProductLicenseState,
  loadVendorLicenses,
  setLicensesTermStatements,
  toIsoTimestamp,
  type LicenseBatch,
  type LicenseBefore,
} from '../lib/license';
import { grantSubject } from '../lib/license-grant-sweep';
import {
  activateLicenseGrantStatements,
  closeLicenseGrantStatements,
  createLicenseGrantStatements,
  grantItems,
  grantLicenseIds,
  licenseGrantPendingKey,
  pendingBanTermEndedIds,
  toAdminLicenseGrant,
  type LicenseGrantRow,
} from '../lib/license-grants';
import { changedOneRowSentinel, isReleaseRaceError } from '../lib/license-release-requests';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import { vendorPurgeTags } from '../lib/vendor-cache-tags';
import {
  isSeatsChangedError,
  ownerSeatLapsed,
  seatsChangedError,
  unbannedSeatExistsSentinel,
  vendorFullyBanned,
} from '../lib/vendor-handback';
import {
  EMPTY_PRODUCT_ROLES,
  foldProductRoleGroups,
  isPureConnectorVendor,
  productRolesForVendor,
  selectProductRoleGroups,
} from '../lib/vendor-product-roles';
import {
  loadVendorOwnerRecipients,
  loadVendorSeatRecipients,
  type FetchSeatEmails,
} from '../lib/vendor-seat-recipients';
import { purgeTags } from './vendor-shared';

type LicensesContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The sender, injected so specs never touch Resend. */
export type SendLicensesGranted = typeof sendLicensesGrantedEmail;

export { grantLicenseIds, LICENSE_GRANT_NAMESPACE } from '../lib/license-grants';

/** `metadata.source` on the grant's own audit rows and, at a signed-deal activation, its
 *  license rows: the license builder's default. */
const GRANT_AUDIT_SOURCE = 'admin-license';

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

/** The `license-grant-pending` sender, injected so specs never touch Resend. */
export type SendLicenseGrantPending = typeof sendLicenseGrantPendingEmail;

/** True for the primary-key violation a racing create with the same grant id raises. */
function isGrantIdConflict(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/UNIQUE constraint failed: license_grants\.id/i.test(text)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** The stored grant with this id, and whether any license already carries one of its
 *  ids (a grant made before AECI-1615 with the same grant id). */
async function loadStoredGrant(db: Db, grantId: string, licenseIds: readonly string[]) {
  const [grantRows, legacy] = await Promise.all([
    db.select().from(licenseGrants).where(eq(licenseGrants.id, grantId)).limit(1),
    db
      .select({ id: licenses.id })
      .from(licenses)
      .where(inArray(licenses.id, [...licenseIds]))
      .limit(1),
  ]);
  return { stored: grantRows[0] ?? null, legacy: legacy.length > 0 };
}

/** The licenses an accepted grant wrote, in the grant's id order. */
async function loadGrantLicenses(db: Db, grant: LicenseGrantRow): Promise<StoredGrantRow[]> {
  if (grant.status !== 'accepted') return [];
  const rows = await db
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
    .where(eq(licenses.licenseGrantId, grant.id));
  const order = await grantLicenseIds(grant.id, grant.quantity);
  const rank = new Map(order.map((id, i) => [id, i]));
  return rows.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

/** The method of the acceptance an accepted grant points at, for the response. */
async function loadAcceptanceMethod(db: Db, grant: LicenseGrantRow): Promise<string | null> {
  if (!grant.acceptanceId) return null;
  const row = await db.query.agreementAcceptances.findFirst({
    columns: { method: true },
    where: eq(agreementAcceptances.id, grant.acceptanceId),
  });
  return row?.method ?? null;
}

function signedDealRefusal(field: string, message: string): ApiError {
  return new ApiError(400, ApiErrorCode.VALIDATION_FAILED, message, {
    field: `signed_deal.${field}`,
  });
}

/**
 * The create handler (module header). Since AECI-1615 it writes one pending
 * `license_grants` row and its `license_grant.created` audit row, and no license. With a
 * valid `signed_deal` block (ruling R5) the same batch activates the grant through
 * `activateLicenseGrantStatements`: the grant is `accepted`, the `signed_deal` acceptance
 * row and the licenses land together, and `licenses-granted` goes out post-commit.
 * Without one, `license-grant-pending` goes to the owner seats.
 */
export function createGrantLicensesHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendGranted: SendLicensesGranted = sendLicensesGrantedEmail,
  sendPending: SendLicenseGrantPending = sendLicenseGrantPendingEmail,
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
    // The version every new grant pins (the grant-date version governs, v1.1 opening).
    const termsVersion = LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan;
    const deal = payload.signed_deal ?? null;
    let dealSignedAt: string | null = null;
    if (deal) {
      if (deal.version_named !== termsVersion) {
        throw signedDealRefusal(
          'version_named',
          `The deal must name the current Managed plan agreement, version ${termsVersion}. A substituted version needs a new acceptance.`,
        );
      }
      dealSignedAt = toIsoTimestamp(deal.signed_at);
      if (Date.parse(dealSignedAt) > Date.parse(now)) {
        throw signedDealRefusal('signed_at', 'signed_at cannot be in the future.');
      }
    }

    const { db } = writeDb(c, dbFor);
    const vendor = await db.query.vendors.findFirst({
      columns: { id: true, slug: true, companyName: true, verified: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });
    const account = await loadBillingAccount(db, vendor.id);
    if (!account) throw notFoundError('billing_account', { id: vendor.id });

    const licenseIds = await grantLicenseIds(payload.grant_id, payload.quantity);
    const [vendorLicenses, { stored, legacy }, roleGroups, fullyBanned] = await Promise.all([
      loadVendorLicenses(db, vendor.id),
      loadStoredGrant(db, payload.grant_id, licenseIds),
      selectProductRoleGroups(db, productRolesForVendor(vendor.id)),
      vendorFullyBanned(db, vendor.id),
    ]);

    const roles = foldProductRoleGroups(roleGroups).get(vendor.id) ?? { ...EMPTY_PRODUCT_ROLES };
    const warnings: GrantLicensesWarning[] = isPureConnectorVendor(roles)
      ? [
          {
            code: 'pure_connector_vendor',
            message:
              'Every product this vendor owns is a connector. Connector vendors and licenses are not settled yet (AECI-1343). The grant was made anyway.',
          },
        ]
      : [];

    const respond = (
      grant: LicenseGrantRow,
      method: string | null,
      rows: readonly StoredGrantRow[],
      replayed: boolean,
      status: 200 | 201,
    ): Response => {
      const body: GrantLicensesResponse = {
        vendor_id: vendor.id,
        billing_account_id: account.id,
        grant_id: payload.grant_id,
        replayed,
        status: grant.status as GrantLicensesResponse['status'],
        grant: toAdminLicenseGrant(grant, method),
        licenses: rows.map(toGrantedLicense),
        warnings,
      };
      validateResponseInDev(c.env, () => GrantLicensesResponseSchema.parse(body));
      return json(body, { status });
    };

    if (stored) {
      const exact =
        stored.billingAccountId === account.id &&
        stored.kind === 'grant' &&
        stored.source === payload.source &&
        stored.quantity === payload.quantity &&
        stored.endsAt === endsAt &&
        stored.reference === reference &&
        stored.startsAt === (payload.starts_at === undefined ? null : startsAt);
      if (!exact) throw grantConflict();
      const [rows, method] = await Promise.all([
        loadGrantLicenses(db, stored),
        loadAcceptanceMethod(db, stored),
      ]);
      return respond(stored, method, rows, true, 200);
    }
    // A grant made before AECI-1615 under this id already wrote its licenses.
    if (legacy) throw grantConflict();

    // After the replay, so a retry of a grant made before the ban still answers 200.
    // A vendor with no seat at all (never claimed) stays grantable.
    if (fullyBanned) {
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_STILL_BANNED,
        'Every owner seat on this vendor is banned. Unban a seat first. Nothing was granted.',
      );
    }

    const actor = { actorId: auth.userId, actorType: auditActorType(auth) };
    const created = createLicenseGrantStatements(db, {
      ...actor,
      id: payload.grant_id,
      billingAccountId: account.id,
      vendorId: vendor.id,
      kind: 'grant',
      source: payload.source,
      quantity: payload.quantity,
      startsAt: payload.starts_at === undefined ? null : startsAt,
      endsAt,
      reference,
      notes,
      items: [],
      termsVersion,
      grantedBy: auth.userId,
      now,
      vendorPlan: licensePlanSnapshot(vendorLicenses, now),
      auditSource: GRANT_AUDIT_SOURCE,
    });
    const activation = deal
      ? await activateLicenseGrantStatements(db, {
          ...actor,
          grant: created.row,
          now,
          vendorLicenses,
          vendorWasVerified: vendor.verified,
          licensedProductIds: new Set(),
          ownedProductIds: new Set(),
          auditSource: GRANT_AUDIT_SOURCE,
          acceptance: {
            method: 'signed_deal',
            email: deal.signer_email,
            profileId: null,
            signer: {
              name: deal.signer_name,
              title: deal.signer_role,
              companyLegalName: deal.company_legal_name,
            },
            seatRole: null,
            dealReference: deal.deal_reference,
            dealSignedAt,
          },
          extraMetadata: {
            deal_version_named: deal.version_named,
            deal_version_date_named: deal.version_date_named,
          },
        })
      : null;

    // A termination that commits between the seat read above and this batch would
    // leave this grant on a banned vendor. Last, so it sees the batch's own writes.
    const stmts: BatchStmt[] = [
      ...created.stmts,
      ...(activation?.stmts ?? []),
      unbannedSeatExistsSentinel(db, vendor.id, { allowNoSeats: true }),
    ];

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isGrantIdConflict(error) || isLicenseIdConflict(error)) throw grantConflict();
      if (isSeatsChangedError(error)) throw seatsChangedError();
      throw error;
    }

    forwardAuditBatch(
      c,
      [created.auditEntry, ...(activation?.auditEntries ?? [])],
      [],
      'admin-licenses',
    );

    if (!activation) {
      c.executionCtx.waitUntil(
        emailLicenseGrantPending(c, db, created.row, vendor, fetchSeatEmails, sendPending),
      );
      return respond(created.row, null, [], false, 201);
    }

    if (activation.verifiedFlipped) {
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
    const accepted: LicenseGrantRow = {
      ...created.row,
      status: 'accepted',
      acceptanceId: activation.acceptanceId,
      decidedAt: now,
      decidedBy: auth.userId,
    };
    return respond(accepted, 'signed_deal', await loadGrantLicenses(db, accepted), false, 201);
  };
}

/**
 * `license-grant-pending` to every unbanned owner seat, one send per owner, keyed
 * `license-grant-pending:{grantId}:{profileId}`. Never throws: the grant is committed
 * whatever happens here. No owner resolved (none yet, or no GoTrue key): the 11:00 sweep
 * catches up when one exists.
 */
export async function emailLicenseGrantPending(
  c: EmailContext,
  db: Db,
  grant: LicenseGrantRow,
  vendor: { id: string; slug: string; companyName: string },
  fetchSeatEmails: FetchSeatEmails,
  send: SendLicenseGrantPending,
): Promise<void> {
  try {
    const owners = await loadVendorOwnerRecipients(db, c.env, vendor.id, fetchSeatEmails);
    if (owners.length === 0) {
      warn(c, 'license-grant-pending: no owner seat resolved; the daily sweep catches up');
      return;
    }
    // One at a time: a handful of owners, and the Worker's connection limit is six.
    for (const owner of owners) {
      await send(c, {
        ...grantSubject(grant, vendor.companyName, vendor.slug, owner.email),
        dedupeKey: licenseGrantPendingKey(grant.id, owner.profileId),
      });
    }
  } catch (error) {
    warn(
      c,
      'license-grant-pending email failed',
      error instanceof Error ? error.message : String(error),
    );
  }
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
 * Who a billing email goes to (decision 16): every unbanned seat, plus the billing
 * email when one is set, each address once, case-insensitively. Without the GoTrue
 * service-role key no seat resolves: the billing email still gets it, and this warns.
 * Shared by `licenses-granted` and `managed-ended` (AECI-1371).
 */
async function billingRecipients(
  c: EmailContext,
  db: Db,
  vendorId: string,
  billingAccountId: string,
  fetchSeatEmails: FetchSeatEmails,
  template: string,
): Promise<string[]> {
  const [seatMap, billingEmails] = await Promise.all([
    loadVendorSeatRecipients(db, c.env, [vendorId], fetchSeatEmails),
    loadBillingEmails(db, [billingAccountId]),
  ]);
  const seats = seatMap.get(vendorId) ?? [];
  if (seats.length === 0) {
    // No seat resolved: none exists, or the GoTrue service-role key is absent and
    // the seam returned nothing. The billing email, when set, still gets it.
    warn(c, `${template}: no seat address resolved; sending to the billing email only`);
  }

  return mergeRecipientAddresses(
    seats.map((s) => s.email),
    billingEmails.get(billingAccountId),
  );
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
    /** `stripe` since AECI-1500: the Stripe sync reuses this fan-out. */
    source: 'complimentary' | 'invoice' | 'stripe';
    /** `null` on a monthly Stripe subscription. */
    endsAt: string | null;
    reference: string | null;
  },
  fetchSeatEmails: FetchSeatEmails,
  send: SendLicensesGranted,
): Promise<void> {
  try {
    const addresses = await billingRecipients(
      c,
      db,
      input.vendorId,
      input.billingAccountId,
      fetchSeatEmails,
      'licenses-granted',
    );
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

// ─── POST /api/admin/vendors/:id/licenses/ban-term (AECI-1589) ──────────────
//
// "Grant complimentary licenses for the ban term". The ban of a vendor's last unbanned
// seat ends every license now (`end_reason = 'banned'`), and the unban restores none
// (ruling 2 of 2026-11-03). After the unban, the operator grants one complimentary
// license per product the ban took off Managed, each ASSIGNED at grant to that product
// and each with its own end date, prefilled from the banned row's `ends_at` (the paid
// term end; NULL when Stripe could not be read, so the operator types it). Behind
// `requireAdmin()` and `rateLimit('write')`.
//
// ── THE REFUSALS, IN ORDER (nothing is written on any) ──────────────────────
//  - body invalid, or an `ends_at` not after now (as instants) → 400;
//  - unknown vendor, or no billing account → 404;
//  - a replay of this `grant_id` is answered here, before the refusals below, so a
//    retry after a committed grant is 200 even though its products are now licensed;
//  - no unbanned `vendor_admin` seat → 409 `VENDOR_STILL_BANNED`. A termination
//    that commits between that read and the batch trips `unbannedSeatExistsSentinel`
//    and answers 409 `VENDOR_SEATS_CHANGED`, nothing granted;
//  - an `ended_license_id` not on this vendor's billing account, not ended `banned`,
//    or whose `assigned_product_id` is not the item's product → 400, field
//    `items.{i}.ended_license_id`;
//  - an `ended_license_id` already restored or replaced: some license on the account
//    assigned to that product was created after the banned row's `ended_at` (a
//    ban-term grant that since lapsed or was revoked, or a purchase) → 400, same field;
//  - a product no longer joined to the vendor → 404 (`resource = 'product'`);
//  - a product that already holds a live license (any account) → 409
//    `LICENSE_PRODUCT_ALREADY_LICENSED`. A license landing between that read and the
//    batch trips `licenses_live_product_idx`, and maps to the same 409.
//
// ── IDEMPOTENT ON `grant_id`, AS THE GRANT IS ───────────────────────────────
// License `i` is `grantLicenseIds(grant_id)[i]`, item `i` in request order, whichever
// end-date group it falls in. A stored set that matches every item (account, source,
// end date, reference, product) is a 200 replay; anything else is 409
// `LICENSE_GRANT_CONFLICT`.
//
// ── ONE BATCH, ONE GRANT PER END DATE ───────────────────────────────────────
// Items are grouped by `ends_at`; each group is one `grantLicensesStatements` call
// (assign-at-grant, its audit rows, the mirror reconcile). Every group's statements go
// into the same `db.batch`. The audit rows carry `grant_id`, `ban_term_grant: true`
// and `restored_from_license_ids`.
//
// ── AFTER COMMIT ────────────────────────────────────────────────────────────
// `forwardAuditBatch`; ONE purge message (`product:{slug}` per product,
// `index:products`, the vendor tag set) through `purgeLicenseDrops`; and one
// `licenses-granted` email per end-date group, `source: 'complimentary'`, keyed
// `licenses-granted:{grant_id}:{ends_at}:{recipient hash}` so two groups never dedupe
// each other.

/** The `reference` every ban-term license carries. The vendor sees it on its Billing
 *  tab and in the `licenses-granted` email. */
export const BAN_TERM_REFERENCE = 'Complimentary for the ban term';

async function parseBanTermBody(c: LicensesContext): Promise<BanTermLicensesInput> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return BanTermLicensesSchema.parse(raw);
}

/** `product_ids`: the product the pre-check found licensed, or every product the
 *  request named when the batch lost the race on `licenses_live_product_idx`. */
function productAlreadyLicensed(productIds: readonly string[]): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LICENSE_PRODUCT_ALREADY_LICENSED,
    'A product already holds a live license. Reload the page. Nothing was granted.',
    { details: { product_ids: productIds } },
  );
}

export function createBanTermLicensesHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendPending: SendLicenseGrantPending = sendLicenseGrantPendingEmail,
): (c: LicensesContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const vendorId = c.req.param('id');
    if (!vendorId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing vendor id', {
        field: 'id',
      });
    }

    const payload = await parseBanTermBody(c);
    const now = new Date().toISOString();
    const items = payload.items.map((item, i) => {
      const endsAt = toIsoTimestamp(item.ends_at);
      if (Date.parse(endsAt) <= Date.parse(now)) {
        throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'ends_at must be after now.', {
          field: `items.${i}.ends_at`,
        });
      }
      return { ...item, endsAt };
    });

    const { db } = writeDb(c, dbFor);
    const vendor = await db.query.vendors.findFirst({
      columns: { id: true, slug: true, companyName: true, verified: true },
      where: eq(vendors.id, vendorId),
    });
    if (!vendor) throw notFoundError('vendor', { id: vendorId });
    const account = await loadBillingAccount(db, vendor.id);
    if (!account) throw notFoundError('billing_account', { id: vendor.id });

    const licenseIds = await grantLicenseIds(payload.grant_id, items.length);
    const [vendorLicenses, { stored, legacy }, owned, seatLapsed] = await Promise.all([
      loadVendorLicenses(db, vendor.id),
      loadStoredGrant(db, payload.grant_id, licenseIds),
      loadOwnedProductLicenseState(db, vendor.id),
      ownerSeatLapsed(db, vendor.id),
    ]);

    const respond = (
      grant: LicenseGrantRow,
      method: string | null,
      rows: readonly StoredGrantRow[],
      replayed: boolean,
      status: 200 | 201,
    ): Response => {
      const body: BanTermLicensesResponse = {
        vendor_id: vendor.id,
        billing_account_id: account.id,
        grant_id: payload.grant_id,
        replayed,
        status: grant.status as BanTermLicensesResponse['status'],
        grant: toAdminLicenseGrant(grant, method),
        licenses: rows.map(toGrantedLicense),
      };
      validateResponseInDev(c.env, () => BanTermLicensesResponseSchema.parse(body));
      return json(body, { status });
    };

    if (stored) {
      const storedItems = stored.kind === 'ban_term' ? grantItems(stored) : [];
      const exact =
        stored.billingAccountId === account.id &&
        stored.kind === 'ban_term' &&
        storedItems.length === items.length &&
        items.every(
          (item, i) =>
            storedItems[i]!.product_id === item.product_id &&
            storedItems[i]!.ended_license_id === item.ended_license_id &&
            storedItems[i]!.ends_at === item.endsAt,
        );
      if (!exact) throw grantConflict();
      const [rows, method] = await Promise.all([
        loadGrantLicenses(db, stored),
        loadAcceptanceMethod(db, stored),
      ]);
      return respond(stored, method, rows, true, 200);
    }
    // A ban-term grant made before AECI-1615 under this id already wrote its licenses.
    if (legacy) throw grantConflict();

    if (seatLapsed) {
      throw new ApiError(
        409,
        ApiErrorCode.VENDOR_STILL_BANNED,
        'This vendor has no unbanned owner seat. Reinstate a seat first. Nothing was granted.',
      );
    }

    items.forEach((item, i) => {
      const ended = vendorLicenses.find((l) => l.id === item.ended_license_id);
      if (
        !ended ||
        ended.billingAccountId !== account.id ||
        ended.endedAt === null ||
        ended.endReason !== 'banned' ||
        ended.assignedProductId !== item.product_id
      ) {
        throw new ApiError(
          400,
          ApiErrorCode.VALIDATION_FAILED,
          "ended_license_id must name a license this vendor's ban ended on that product.",
          { field: `items.${i}.ended_license_id` },
        );
      }
    });

    // A `banned` row is permanent, so it stays a candidate only until some license on
    // that product (any source) is created after it ended: a ban-term grant already
    // restored it, or a purchase or grant replaced it. Without this, a restored license
    // that lapsed or was revoked would let the same ended row be granted again. Since
    // AECI-1615 a PENDING ban-term grant that names the row spends it too.
    const [later, pendingEnded] = await Promise.all([
      db
        .select({
          id: licenses.id,
          productId: licenses.assignedProductId,
          createdAt: licenses.createdAt,
        })
        .from(licenses)
        .where(
          and(
            eq(licenses.billingAccountId, account.id),
            inArray(
              licenses.assignedProductId,
              items.map((item) => item.product_id),
            ),
          ),
        ),
      pendingBanTermEndedIds(db, account.id),
    ]);
    items.forEach((item, i) => {
      const endedAt = Date.parse(
        vendorLicenses.find((l) => l.id === item.ended_license_id)!.endedAt!,
      );
      if (
        pendingEnded.has(item.ended_license_id) ||
        later.some(
          (row) =>
            row.id !== item.ended_license_id &&
            row.productId === item.product_id &&
            Date.parse(row.createdAt) > endedAt,
        )
      ) {
        throw new ApiError(
          400,
          ApiErrorCode.VALIDATION_FAILED,
          'That license was already restored or replaced, or a waiting grant names it. Nothing was granted.',
          { field: `items.${i}.ended_license_id` },
        );
      }
    });

    const ownedById = new Map(owned.map((o) => [o.productId, o]));
    for (const item of items) {
      const state = ownedById.get(item.product_id);
      if (!state) throw notFoundError('product', { id: item.product_id });
      if (state.licensed) throw productAlreadyLicensed([item.product_id]);
    }

    const created = createLicenseGrantStatements(db, {
      actorId: auth.userId,
      actorType: auditActorType(auth),
      id: payload.grant_id,
      billingAccountId: account.id,
      vendorId: vendor.id,
      kind: 'ban_term',
      source: 'complimentary',
      quantity: items.length,
      startsAt: null,
      // The grant's own end is its latest item's: it expires unaccepted only when every
      // item's term has passed.
      endsAt: items.reduce(
        (max, item) => (Date.parse(item.endsAt) > Date.parse(max) ? item.endsAt : max),
        items[0]!.endsAt,
      ),
      reference: BAN_TERM_REFERENCE,
      notes: null,
      items: items.map((item) => ({
        ended_license_id: item.ended_license_id,
        product_id: item.product_id,
        ends_at: item.endsAt,
      })),
      termsVersion: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      grantedBy: auth.userId,
      now,
      vendorPlan: licensePlanSnapshot(vendorLicenses, now),
      auditSource: GRANT_AUDIT_SOURCE,
    });

    // A termination that commits between the seat read above and this batch would
    // leave this grant on a banned vendor. Last, so it sees the batch's own writes.
    const stmts: BatchStmt[] = [...created.stmts, unbannedSeatExistsSentinel(db, vendor.id)];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isGrantIdConflict(error)) throw grantConflict();
      if (isSeatsChangedError(error)) throw seatsChangedError();
      throw error;
    }

    forwardAuditBatch(c, [created.auditEntry], [], 'admin-licenses');
    // No purge: a pending grant changes no product's plan and no public page.
    c.executionCtx.waitUntil(
      emailLicenseGrantPending(c, db, created.row, vendor, fetchSeatEmails, sendPending),
    );
    return respond(created.row, null, [], false, 201);
  };
}

// ─── PATCH /api/admin/license-grants/:id (AECI-1615) ────────────────────────
//
// AECi withdraws a pending grant: `{ action: 'withdraw', reason }`. Behind
// `requireAdmin()` and `rateLimit('write')`. A guarded UPDATE (`WHERE status =
// 'pending_acceptance'`), `changedOneRowSentinel` and the `license_grant.withdrawn` audit
// row, in one batch. Unknown grant → 404. A grant that is not pending, or that an owner
// accepted (or the sweep expired) between the read and the batch → 422
// `INVALID_STATE_TRANSITION`, nothing written. No email and no purge: a pending grant
// shows on no public page, and the vendor's open Billing tab refreshes on the
// `entitlement` cursor (`max(license_grants.updated_at)`).

async function parseWithdrawBody(c: LicensesContext): Promise<WithdrawLicenseGrantInput> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return WithdrawLicenseGrantSchema.parse(raw);
}

function grantNotPending(state: string): ApiError {
  return new ApiError(
    422,
    ApiErrorCode.INVALID_STATE_TRANSITION,
    'This grant is no longer waiting for acceptance, so it cannot be withdrawn. Reload it.',
    { details: { state } },
  );
}

export function createWithdrawLicenseGrantHandler(
  dbFor: DbFactory = getDb,
): (c: LicensesContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const grantId = c.req.param('id');
    if (!grantId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing grant id', {
        field: 'id',
      });
    }
    const payload = await parseWithdrawBody(c);

    const { db } = writeDb(c, dbFor);
    const [grant] = await db
      .select()
      .from(licenseGrants)
      .where(eq(licenseGrants.id, grantId))
      .limit(1);
    if (!grant) throw notFoundError('license_grant', { id: grantId });
    if (grant.status !== 'pending_acceptance') throw grantNotPending(grant.status);

    const now = new Date().toISOString();
    const vendorLicenses = await loadVendorLicenses(db, grant.vendorId);
    const batch = closeLicenseGrantStatements(db, {
      actorId: auth.userId,
      actorType: auditActorType(auth),
      grant,
      status: 'withdrawn',
      now,
      reason: payload.reason,
      vendorPlan: licensePlanSnapshot(vendorLicenses, now),
      auditSource: GRANT_AUDIT_SOURCE,
    });
    try {
      await db.batch(batch.stmts as BatchTuple);
    } catch (error) {
      if (!isReleaseRaceError(error)) throw error;
      const [fresh] = await db
        .select({ status: licenseGrants.status })
        .from(licenseGrants)
        .where(eq(licenseGrants.id, grantId))
        .limit(1);
      throw grantNotPending(fresh?.status ?? 'unknown');
    }

    forwardAuditBatch(c, [batch.auditEntry], [], 'admin-licenses');
    const body: WithdrawLicenseGrantResponse = {
      vendor_id: grant.vendorId,
      grant: toAdminLicenseGrant(batch.row),
    };
    validateResponseInDev(c.env, () => WithdrawLicenseGrantResponseSchema.parse(body));
    return json(body);
  };
}

// ─── PATCH /api/admin/licenses/:id (AECI-1371, E4.2) ────────────────────────
//
// Edit one license: `extend` its end date, change its invoice `reference`, or
// `revoke` it. `VENDOR_SIGNUP_PROCESS.md` §3 steps 5 and 11, decisions 11 and 14;
// `STAGE_2_PAID_TIERS_SPEC.md` §5.2. Behind `requireAdmin()` and `rateLimit('write')`.
//
// ── THE REFUSALS, IN ORDER ──────────────────────────────────────────────────
//  - body invalid → 400 (`VALIDATION_FAILED` / `MALFORMED_REQUEST`), before any read;
//  - unknown license → 404 (`details.resource = 'license'`);
//  - ended license → 422 `INVALID_STATE_TRANSITION`, every action: no un-end;
//  - `extend` or `reference` on a Stripe license → 409 `LICENSE_SOURCE_STRIPE`;
//  - `reference` on a complimentary license → 422 `INVALID_STATE_TRANSITION`: only an
//    invoice license carries one;
//  - `extend` not strictly after the current end, as instants → 400, field `ends_at`.
//    A license with no end date (an open-ended complimentary back-fill) takes any end
//    after now and after its start: that is how AECi sets the date it deferred.
// Nothing is written on any refusal.
//
// ── EXTEND AND REFERENCE ────────────────────────────────────────────────────
// `setLicensesTermStatements`: one guarded UPDATE, one `license.term_changed` audit
// row (`metadata.change` names the action), the mirror reconcile. A live license stays
// live, so no plan changes: no purge and no email. A reference equal to the stored one
// is a no-op answered 200 with `changed: false`.
//
// ── REVOKE ──────────────────────────────────────────────────────────────────
// `endLicensesStatements({ endReason: 'revoked' })` (ruling P1, 2026-10-15): it stamps
// `ended_at` and `end_reason` and never names `assigned_product_id`, so an assigned
// license keeps its product as history (decision 14, the hand-back). The product
// drops to Free because no live license holds it. In the same batch: the
// `license.revoked` row (reason marked vendor-visible, internal note beside it), the
// mirror reconcile, and the `portal-license-revoked-by-aeci` Messages row to the vendor.
// No `products` statement: the Managed-field content stays as it is.
//
// Post-commit, only when the license was on a product: purge `product:{slug}`,
// `index:products` and the vendor set (`vendorPurgeTags`), and send `managed-ended` to
// every seat and the billing email. An unassigned revoke purges nothing and sends no
// email, unless it ends the vendor's last live license: then the `vendors.verified`
// mirror flips, and the vendor set is purged as the grant does.
//
// A revoke is NOT a seat revoke and NOT a ban (`STAGE_2_PAID_TIERS_SPEC.md` §5.2):
// seats, logins and the dashboard all stay. No statement here names `profiles`.
//
// ── THE LAST LIVE LICENSE RE-ROUTES CONTESTS (AECI-1092, moved by AECI-1375) ──
// A revoke that leaves the vendor no live license also moves its open owner-routed
// contests on connector-powered rows to AECi, in THIS batch
// (`planLastLicenseReroute`, ruling B, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.13):
// deciding them now needs a live license the vendor no longer holds. This was the
// retired entitlement `clear`'s job. The term-end lapse runs the same plan
// (`lib/license-lapse.ts`, AECI-1404). "Last" is read from the license rows
// (`vendorLicenses`), never from the `vendors.verified` pre-read, so a drifted mirror
// cannot skip the re-route. Two guards ride that batch: the plan's own (the contest
// set changed since it was read) and `noLiveLicenseSentinel` (a grant committed
// since the pre-read). A revoke that read another live license plans no re-route and
// carries the inverse, `liveLicenseRemainsSentinel` (a concurrent revoke ended that
// license), so two revokes racing on the last two licenses cannot both skip it. Any
// abort makes the handler re-read: an ended license is the 422 below; otherwise it
// rebuilds the whole batch from the fresh read once, with or without a re-route as
// the fresh licenses say, and a second abort is `409 CONTEST_INTEGRATION_CHANGED`.
// Nothing is written on any abort.

/** The `managed-ended` sender, injected so specs never touch Resend. */
export type SendManagedEnded = typeof sendManagedEndedEmail;

/** The ledger key of one `managed-ended` email about one license, to one address. */
export async function managedEndedDedupeKey(licenseId: string, address: string): Promise<string> {
  return `managed-ended:${licenseId.toLowerCase()}:${await recipientHash(address)}`;
}

async function parseUpdateBody(c: LicensesContext): Promise<UpdateLicenseInput> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, ApiErrorCode.MALFORMED_REQUEST, 'Request body is not valid JSON');
  }
  return UpdateLicenseSchema.parse(raw);
}

function stripeRefusal(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LICENSE_SOURCE_STRIPE,
    'Stripe manages this license. Change its term or invoice in Stripe. Nothing was changed.',
  );
}

function toUpdatedLicense(l: LicenseBefore): UpdateLicenseResponse['license'] {
  return {
    ...toGrantedLicense(l),
    ended_at: l.endedAt,
    end_reason: l.endReason,
  };
}

export function createUpdateLicenseHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendEnded: SendManagedEnded = sendManagedEndedEmail,
): (c: LicensesContext) => Promise<Response> {
  return async (c) => {
    const auth = c.get('auth');
    const licenseId = c.req.param('id');
    if (!licenseId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing license id', {
        field: 'id',
      });
    }
    const payload = await parseUpdateBody(c);

    const { db } = writeDb(c, dbFor);
    const [owner] = await db
      .select({ vendorId: billingAccounts.vendorId })
      .from(licenses)
      .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
      .where(eq(licenses.id, licenseId))
      .limit(1);
    if (!owner) throw notFoundError('license', { id: licenseId });
    const [vendor, vendorLicenses] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, companyName: true, verified: true },
        where: eq(vendors.id, owner.vendorId),
      }),
      loadVendorLicenses(db, owner.vendorId),
    ]);
    const before = vendorLicenses.find((l) => l.id === licenseId);
    if (!vendor || !before) throw notFoundError('license', { id: licenseId });

    if (before.endedAt !== null) {
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        'This license has ended. An ended license cannot be changed; grant a new one instead.',
        { details: { state: 'ended', ended_at: before.endedAt } },
      );
    }

    const now = new Date().toISOString();
    const actor = { actorId: auth.userId, actorType: auditActorType(auth) };
    const base = {
      vendorId: vendor.id,
      now,
      ...actor,
      vendorLicenses,
      vendorWasVerified: vendor.verified,
    };

    let batch: LicenseBatch;
    let after: LicenseBefore;
    // The revoke's re-route (AECI-1092 ruling B), and the guard it needs. Null unless
    // the revoke ends the vendor's last live license. When it does not, `remainsGuard`
    // holds the inverse guard instead: some other license must still be live at commit.
    let reroute: LastLicenseReroutePlan['reroute'] = null;
    let remainsGuard: BatchStmt | null = null;
    // Ruling B's decision and guards, shared with the term-end lapse.
    const planReroute = (licensesNow: readonly LicenseBefore[]) =>
      planLastLicenseReroute(db, {
        vendorId: vendor.id,
        actor,
        now,
        vendorLicenses: licensesNow,
        endingLicenseIds: new Set([before.id]),
        extra: { license_id: before.id },
      });
    // The revoke's license batch, built from a license set and the mirror as read. A
    // retry rebuilds it from a fresh read, so its audit rows and flip prediction stay true.
    let revokeMetadata: Record<string, unknown> = {};
    const revokeBatch = (licensesNow: LicenseBefore[], wasVerified: boolean): LicenseBatch =>
      endLicensesStatements(db, {
        ...base,
        vendorLicenses: licensesNow,
        vendorWasVerified: wasVerified,
        target: { licenseIds: [before.id] },
        endReason: 'revoked',
        extraMetadata: revokeMetadata,
      });
    let notice: AuditLogEntry | null = null;
    let product: { id: string; slug: string; name: string } | null = null;

    switch (payload.action) {
      case 'extend': {
        if (before.source === 'stripe') throw stripeRefusal();
        const endsAt = toIsoTimestamp(payload.ends_at);
        // Instants, not strings (Paid Tiers §5.5). No end date yet: after now and the start.
        const floor = before.endsAt
          ? Date.parse(before.endsAt)
          : Math.max(Date.parse(now), Date.parse(before.startsAt));
        if (Date.parse(endsAt) <= floor) {
          throw new ApiError(
            400,
            ApiErrorCode.VALIDATION_FAILED,
            before.endsAt
              ? 'ends_at must be after the current end date.'
              : 'ends_at must be after today and after the start date.',
            { field: 'ends_at' },
          );
        }
        batch = setLicensesTermStatements(db, {
          ...base,
          licenseIds: [before.id],
          endsAt,
          expectUnchanged: true,
          extraMetadata: { change: 'extend' },
        });
        after = { ...before, endsAt };
        break;
      }
      case 'reference': {
        if (before.source === 'stripe') throw stripeRefusal();
        if (before.source !== 'invoice') {
          throw new ApiError(
            422,
            ApiErrorCode.INVALID_STATE_TRANSITION,
            'Only an invoice license carries a reference. Nothing was changed.',
            { details: { source: before.source } },
          );
        }
        batch = setLicensesTermStatements(db, {
          ...base,
          licenseIds: [before.id],
          endsAt: before.endsAt,
          reference: payload.reference,
          expectUnchanged: true,
          extraMetadata: { change: 'reference' },
        });
        after = { ...before, reference: payload.reference };
        break;
      }
      case 'revoke': {
        if (before.assignedProductId) {
          const row = await db.query.products.findFirst({
            columns: { id: true, slug: true, name: true },
            where: eq(products.id, before.assignedProductId),
          });
          product = row ?? null;
        }
        revokeMetadata = vendorVisibleReasonMetadata(payload);
        batch = revokeBatch(vendorLicenses, vendor.verified);
        after = { ...before, endedAt: now, endReason: 'revoked' };
        ({ reroute, remainsGuard } = await planReroute(vendorLicenses));
        notice = aeciOverrideNotificationAudit('portal-license-revoked-by-aeci', actor, {
          event: 'license_revoked',
          vendorId: vendor.id,
          reason: payload.reason,
          billingAccountId: before.billingAccountId,
          licenseId: before.id,
          product,
        });
        break;
      }
    }

    const respond = (changed: boolean, license: LicenseBefore): Response => {
      const body: UpdateLicenseResponse = {
        vendor_id: vendor.id,
        billing_account_id: before.billingAccountId,
        action: payload.action,
        changed,
        license: toUpdatedLicense(license),
      };
      validateResponseInDev(c.env, () => UpdateLicenseResponseSchema.parse(body));
      return json(body);
    };

    if (batch.stmts.length === 0) return respond(false, before);

    // The license UPDATE is guarded on `ended_at IS NULL`, and an extend or reference
    // also on the `ends_at`, `source` and `reference` read above (`expectUnchanged`).
    // The sentinel straight after it aborts the whole batch when that guard matched
    // nothing: a concurrent revoke or lapse ended the license, or a concurrent edit moved
    // its term or reference, since the read. A lost race writes no audit row, no Messages
    // row, and skips the purge and the email below.
    //
    // A revoke's re-route statements and `remainsGuard` go after the license UPDATE, so
    // the plan's guard, `noLiveLicenseSentinel` and `liveLicenseRemainsSentinel` read the
    // license as ended. Every abort in this batch is the same malformed-JSON error, so
    // the catch re-reads to tell them apart.
    const licenseChanged = (): ApiError =>
      new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        'This license changed or ended while you were editing it. Reload it and try again. Nothing was changed.',
        { details: { state: 'changed' } },
      );
    for (let attempt = 1; ; attempt++) {
      const [licenseUpdate, ...rest] = batch.stmts;
      try {
        await db.batch([
          licenseUpdate!,
          changedOneRowSentinel(db),
          ...(remainsGuard ? [remainsGuard] : []),
          ...rest,
          ...(notice ? [auditInsert(db, notice)] : []),
          ...(reroute?.stmts ?? []),
          ...(reroute?.audits ?? []).map((entry) => auditInsert(db, entry)),
        ] as BatchTuple);
        break;
      } catch (error) {
        // `isReleaseRaceError` and `isContestRaceError` match the same malformed-JSON
        // abort. Outside a revoke only the license sentinel can fire.
        if (!isReleaseRaceError(error) && !isContestRaceError(error)) throw error;
        if (payload.action !== 'revoke') throw licenseChanged();
        const [fresh, freshVendor] = await Promise.all([
          loadVendorLicenses(db, vendor.id),
          db.query.vendors.findFirst({
            columns: { verified: true },
            where: eq(vendors.id, vendor.id),
          }),
        ]);
        if (fresh.find((l) => l.id === before.id)?.endedAt !== null) throw licenseChanged();
        if (attempt >= 2) {
          throw new ApiError(
            409,
            ApiErrorCode.CONTEST_INTEGRATION_CHANGED,
            'Field contests on this vendor’s integrations changed while the license was being revoked. Nothing was saved. Try again.',
          );
        }
        // A grant or another revoke landed since the read, or the contest set moved.
        // Rebuild from the fresh read: the audit rows, the `vendor_plan` snapshot and
        // the flip prediction all follow it, and so does the re-route decision.
        batch = revokeBatch(fresh, freshVendor?.verified ?? vendor.verified);
        ({ reroute, remainsGuard } = await planReroute(fresh));
      }
    }
    // AECI-1092 / AECI-1112: the license rows and every re-route row go in ONE request,
    // never one per contest (AECI-666).
    forwardAuditBatch(
      c,
      [...batch.auditEntries, notice, ...(reroute?.audits ?? [])],
      [],
      'admin-licenses',
    );

    if (payload.action === 'revoke') {
      // The product's plan changed (assigned), or the vendor's mirror did (last live
      // license). Either way the vendor set; the product's own tags when assigned,
      // which the vendor set may miss for a product it no longer owns.
      if (product || batch.verifiedFlipped) {
        const tags = new Set(await vendorPurgeTags(db, vendor));
        if (product) {
          tags.add(`product:${product.slug}`);
          tags.add('index:products');
        }
        c.executionCtx.waitUntil(purgeTags(c, [...tags], 'moderation'));
      }
      if (product) {
        c.executionCtx.waitUntil(
          emailManagedEnded(
            c,
            db,
            {
              licenseId: before.id,
              vendorId: vendor.id,
              vendorSlug: vendor.slug,
              vendorName: vendor.companyName,
              billingAccountId: before.billingAccountId,
              product: { slug: product.slug, name: product.name },
              reason: payload.reason,
            },
            fetchSeatEmails,
            sendEnded,
          ),
        );
      }
    }

    return respond(true, after);
  };
}

/**
 * The `managed-ended` fan-out for one revoked license: every unbanned seat, plus the
 * billing email when set, each address once. Never throws: the revoke is committed
 * whatever happens here, and the ledger records every send.
 */
export async function emailManagedEnded(
  c: EmailContext,
  db: Db,
  input: {
    licenseId: string;
    vendorId: string;
    vendorSlug: string;
    vendorName: string;
    billingAccountId: string;
    product: { slug: string; name: string };
    reason: string;
  },
  fetchSeatEmails: FetchSeatEmails,
  send: SendManagedEnded,
): Promise<void> {
  try {
    const addresses = await billingRecipients(
      c,
      db,
      input.vendorId,
      input.billingAccountId,
      fetchSeatEmails,
      'managed-ended',
    );
    if (addresses.length === 0) {
      warn(c, 'managed-ended: no recipient; nobody was emailed about the revoke');
      return;
    }
    // One at a time: a handful of seats, and the Worker's connection limit is six.
    for (const to of addresses) {
      await send(c, {
        to,
        vendorName: input.vendorName,
        vendorSlug: input.vendorSlug,
        products: [input.product],
        cause: 'revoked',
        reason: input.reason,
        dedupeKey: await managedEndedDedupeKey(input.licenseId, to),
        entity: { type: 'billing_account', id: input.billingAccountId },
      });
    }
  } catch (error) {
    warn(c, 'managed-ended email failed', error instanceof Error ? error.message : String(error));
  }
}
