/**
 * An owner seat accepts a subscription grant (AECI-1615, counsel Q5;
 * `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 5) — Drizzle/D1.
 *
 *   POST /api/vendor/license-grants/:id/accept
 *     `{ accepted: true, version, signer_title }` → 200 `AcceptLicenseGrantResponse`
 *
 * The Managed plan agreement v1.1 says a granted subscription "does not start until an
 * owner seat accepts it in the portal, by ticking the same box". This is that accept.
 *
 * ── GATES, IN ORDER ──────────────────────────────────────────────────────────
 * `requireVendor()` then `rateLimit('write')` at registration. Then `requireSeatOwner()`
 * here: a member seat gets `403`. No capability gate, like every Billing route (the
 * fourth named exception of `API_CONTRACTS.md` §6.14 invariant 3). Then, nothing written
 * on any:
 *   - body invalid (the box not ticked, no title) → `400`;
 *   - grant unknown or another vendor's → `404` (one answer);
 *   - grant not pending (accepted, withdrawn, expired) or past its `ends_at` → `422
 *     LICENSE_GRANT_NOT_PENDING`, `details.state` naming which;
 *   - `version` is not the grant's pinned version → `409 LICENSE_GRANT_VERSION_CHANGED`:
 *     the page is stale;
 *   - the grant left pending between the read and the batch (a second accept, a
 *     withdraw) → `422 LICENSE_GRANT_NOT_PENDING`; a last-seat ban that committed in
 *     between → `409 VENDOR_SEATS_CHANGED`; a ban-term product that took a live license
 *     in between → `409 PRODUCT_ALREADY_LICENSED`; a ban-term product that left the vendor
 *     in between → `409 LICENSE_GRANT_PRODUCTS_CHANGED` (either way a retry lands it in
 *     the pool).
 *
 * ── ONE BATCH ────────────────────────────────────────────────────────────────
 * `activateLicenseGrantStatements` (`lib/license-grants.ts`): the guarded status flip
 * and its sentinel, the `portal_checkbox` acceptance row with the owner's IP, user agent,
 * title and the agreement text hash, the licenses, and the audit rows; then
 * `unbannedSeatExistsSentinel`. The signer is `loadCheckoutSigner`: the display name,
 * `vendors.legal_name` and the typed title. A ban-term item whose product already holds
 * a live license, or is no longer joined to the vendor, lands unassigned, with a warning
 * (ruling R6).
 *
 * ── AFTER COMMIT ────────────────────────────────────────────────────────────
 * Forward the audit rows. Purge the vendor tag set when `vendors.verified` flipped, and
 * each ban-term product's tags through `purgeLicenseDrops`. Send `licenses-granted`
 * with its existing key to every seat and the billing email, one send per end date.
 */

import {
  AcceptLicenseGrantResponseSchema,
  AcceptLicenseGrantSchema,
  ApiErrorCode,
  type AcceptLicenseGrantResponse,
} from '@aeci/shared';
import { and, eq, inArray } from 'drizzle-orm';

import { getDb } from '../db/client';
import { licenseGrants, productVendors, vendors } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { loadCheckoutSigner } from '../lib/agreement-acceptances';
import type { BatchStmt, BatchTuple } from '../lib/audit';
import { auditActorType } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { loadOwnedProductLicenseState, loadVendorLicenses } from '../lib/license';
import { activateLicenseGrantStatements, grantItems, PENDING } from '../lib/license-grants';
import { loadProductNames, purgeLicenseDrops } from '../lib/license-lapse';
import { isReleaseRaceError } from '../lib/license-release-requests';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { logToPosthog } from '../posthog';
import { fetchAuthUserEmails } from '../lib/supabase-admin';
import { vendorPurgeTags } from '../lib/vendor-cache-tags';
import {
  isSeatsChangedError,
  seatsChangedError,
  unbannedSeatExistsSentinel,
} from '../lib/vendor-handback';
import type { FetchSeatEmails } from '../lib/vendor-seat-recipients';
import {
  BAN_TERM_REFERENCE,
  emailLicensesGranted,
  type SendLicensesGranted,
} from './admin-licenses';
import { sendLicensesGrantedEmail } from '../lib/email';
import { isLiveProductConflict } from './vendor-licenses';
import {
  parseJsonBody,
  purgeTags,
  requireSeatOwner,
  sessionVendorId,
  type VendorContext,
} from './vendor-shared';

const OWNER_ONLY = 'Only a vendor account owner can accept a subscription grant';

/** `metadata.source` on the activation's license and grant audit rows. */
const ACCEPT_AUDIT_SOURCE = 'vendor-portal';

function notPending(state: string): ApiError {
  return new ApiError(
    422,
    ApiErrorCode.LICENSE_GRANT_NOT_PENDING,
    state === 'expired'
      ? 'This grant has passed its end date and can no longer be accepted.'
      : 'This grant is no longer waiting for acceptance. Reload the page.',
    { details: { state } },
  );
}

function productLicensed(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.PRODUCT_ALREADY_LICENSED,
    'A product in this grant took a live license while you were accepting. Nothing was saved. Try again.',
  );
}

function productLeft(): ApiError {
  return new ApiError(
    409,
    ApiErrorCode.LICENSE_GRANT_PRODUCTS_CHANGED,
    'A product in this grant left your account while you were accepting. Nothing was saved. Try again.',
  );
}

const WARNING_MESSAGES = {
  product_already_licensed:
    'This product already had a live license, so its subscription went to your pool unassigned.',
  product_not_owned:
    'This product is no longer on your account, so its subscription went to your pool unassigned.',
} as const;

/** `POST /api/vendor/license-grants/:id/accept`. */
export function createAcceptLicenseGrantHandler(
  dbFor: DbFactory = getDb,
  fetchSeatEmails: FetchSeatEmails = fetchAuthUserEmails,
  sendGranted: SendLicensesGranted = sendLicensesGrantedEmail,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const grantId = c.req.param('id');
    if (!grantId) {
      throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Missing grant id', {
        field: 'id',
      });
    }
    const { db } = writeDb(c, dbFor);

    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);
    const payload = await parseJsonBody(c, AcceptLicenseGrantSchema);

    const [grant] = await db
      .select()
      .from(licenseGrants)
      .where(and(eq(licenseGrants.id, grantId), eq(licenseGrants.vendorId, vendorId)))
      .limit(1);
    if (!grant) throw notFoundError('license_grant', { id: grantId });
    if (grant.status !== PENDING) throw notPending(grant.status);
    const now = new Date().toISOString();
    // The sweep marks it `expired`; until it runs, a passed grant is refused here.
    if (Date.parse(grant.endsAt) <= Date.parse(now)) throw notPending('expired');
    if (payload.version !== grant.termsVersion) {
      throw new ApiError(
        409,
        ApiErrorCode.LICENSE_GRANT_VERSION_CHANGED,
        `This grant is under version ${grant.termsVersion} of the Managed plan agreement. Reload the page and read that version.`,
        { details: { terms_version: grant.termsVersion } },
      );
    }

    const isBanTerm = grantItems(grant).length > 0;
    const [vendor, vendorLicenses, signer, email, owned] = await Promise.all([
      db.query.vendors.findFirst({
        columns: { id: true, slug: true, companyName: true, verified: true },
        where: eq(vendors.id, vendorId),
      }),
      loadVendorLicenses(db, vendorId),
      loadCheckoutSigner(db, session.userId, vendorId, payload.signer_title),
      ownerEmail(c, session.userId, session.email, fetchSeatEmails),
      // The vendor's product joins and which hold a live license (any account): the
      // ban-term create's check. An item off this list lands in the pool.
      isBanTerm ? loadOwnedProductLicenseState(db, vendorId) : Promise.resolve([]),
    ]);
    if (!vendor) throw notFoundError('license_grant', { id: grantId });
    if (!email) {
      throw new ApiError(
        503,
        ApiErrorCode.DEPENDENCY_FAILURE,
        'We could not read the email of your sign-in. Try again in a moment. Nothing was saved.',
      );
    }

    const actor = { actorId: session.userId, actorType: auditActorType(session) };
    const activation = await activateLicenseGrantStatements(db, {
      ...actor,
      grant,
      now,
      vendorLicenses,
      vendorWasVerified: vendor.verified,
      licensedProductIds: new Set(owned.filter((o) => o.licensed).map((o) => o.productId)),
      ownedProductIds: new Set(owned.map((o) => o.productId)),
      auditSource: ACCEPT_AUDIT_SOURCE,
      acceptance: {
        method: 'portal_checkbox',
        email,
        profileId: session.userId,
        signer,
        seatRole: 'owner',
        requestHeaders: c.req.raw.headers,
      },
    });

    // A last-seat ban that commits between the read and this batch would leave live
    // licenses on a banned vendor. Last, so it sees the batch's own writes.
    const stmts: BatchStmt[] = [...activation.stmts, unbannedSeatExistsSentinel(db, vendorId)];
    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      if (isLiveProductConflict(error)) throw productLicensed();
      // The status, product-join and seat sentinels raise the same malformed-JSON
      // abort. Re-read to tell them apart.
      if (isReleaseRaceError(error) || isSeatsChangedError(error)) {
        const [fresh] = await db
          .select({ status: licenseGrants.status })
          .from(licenseGrants)
          .where(eq(licenseGrants.id, grantId))
          .limit(1);
        if (fresh?.status !== PENDING) throw notPending(fresh?.status ?? 'unknown');
        if (activation.assignedProductIds.length > 0) {
          const joined = await db
            .select({ productId: productVendors.productId })
            .from(productVendors)
            .where(
              and(
                eq(productVendors.vendorId, vendorId),
                inArray(productVendors.productId, activation.assignedProductIds),
              ),
            );
          if (joined.length < activation.assignedProductIds.length) throw productLeft();
        }
        throw seatsChangedError();
      }
      throw error;
    }

    forwardAuditBatch(c, activation.auditEntries, [], 'vendor-license-grants');

    if (activation.assignedProductIds.length > 0) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const names = await loadProductNames(db, activation.assignedProductIds);
            await purgeLicenseDrops(c, db, activation.assignedProductIds, names, [vendor]);
          } catch (error) {
            warn(c, 'grant accept purge failed', error);
          }
        })(),
      );
    } else if (activation.verifiedFlipped) {
      const tags = await vendorPurgeTags(db, vendor);
      c.executionCtx.waitUntil(purgeTags(c, tags, 'vendor'));
    }

    c.executionCtx.waitUntil(
      (async () => {
        // One group at a time: each fan-out is already one send at a time. A ban-term
        // grant keys each end date apart, as the ban-term grant always has.
        for (const group of activation.groups) {
          await emailLicensesGranted(
            c,
            db,
            {
              grantId: grant.kind === 'ban_term' ? `${grant.id}:${group.endsAt}` : grant.id,
              vendorId,
              vendorName: vendor.companyName,
              billingAccountId: grant.billingAccountId,
              count: group.count,
              source: grant.source === 'invoice' ? 'invoice' : 'complimentary',
              endsAt: group.endsAt,
              reference: grant.kind === 'ban_term' ? BAN_TERM_REFERENCE : grant.reference,
            },
            fetchSeatEmails,
            sendGranted,
          );
        }
      })(),
    );

    const body: AcceptLicenseGrantResponse = {
      grant_id: grant.id,
      status: 'accepted',
      acceptance_id: activation.acceptanceId,
      license_ids: activation.licenseIds,
      warnings: activation.warnings.map((w) => ({
        code: w.code,
        product_id: w.productId,
        message: WARNING_MESSAGES[w.code],
      })),
    };
    validateResponseInDev(c.env, () => AcceptLicenseGrantResponseSchema.parse(body));
    return json(body);
  };
}

/** The owner's email for the acceptance row: the session's, else GoTrue's. */
async function ownerEmail(
  c: VendorContext,
  userId: string,
  sessionEmail: string | undefined,
  fetchSeatEmails: FetchSeatEmails,
): Promise<string | null> {
  const fromSession = sessionEmail?.trim();
  if (fromSession) return fromSession;
  const emails = await fetchSeatEmails(c.env, [userId]);
  return emails.get(userId)?.trim() || null;
}

function warn(c: VendorContext, message: string, error: unknown): void {
  logToPosthog(c.executionCtx, c.env, c.req.raw, {
    level: 'warn',
    message,
    source: 'vendor-license-grants',
    outcome: error instanceof Error ? error.message : String(error),
  });
}
