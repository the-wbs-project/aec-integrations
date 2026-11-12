/**
 * The portal's acceptance screen (AECI-1677; `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.24,
 * `VENDOR_SIGNUP_PROCESS.md` §4, ADR 0055). Contract:
 * `packages/shared/src/api/legal-acceptance.ts`, `API_CONTRACTS.md` §6.14
 * "Legal acceptance". The decision itself is `lib/legal-acceptance.ts`.
 *
 *   GET  /api/vendor/legal-acceptance   what this session must or may accept.
 *   POST /api/vendor/legal-acceptance   an owner seat accepts one pending version.
 *
 * ── GATES, IN ORDER ─────────────────────────────────────────────────────────────
 * GET: `requireVendor()` only. A read, so never rate-limited. Any seat may read: a member
 * seat learns that an owner needs to accept, and who the owners are.
 * POST: `requireVendor({ allowTermsPending: true })`, so a blocked company can reach it,
 * then `rateLimit('write')`, then `requireSeatOwner()` here (a member seat gets `403`),
 * then the body, then the pending check. The vendor id is the session's, never the
 * request's.
 *
 * ── THE PENDING CHECK ───────────────────────────────────────────────────────────
 * The body names a document and a version. It must be one this company may accept right
 * now, computed afresh (`pendingAcceptances`): the required Vendor Terms version, or an
 * optional one. Anything else is `422 LEGAL_ACCEPTANCE_NOT_PENDING`, nothing written:
 * a version not in force and not a published version that needs acceptance, a version
 * already accepted, a stale page, a forged body.
 *
 * ── ONE BATCH ───────────────────────────────────────────────────────────────────
 * The `agreement_acceptances` row (`source: 'portal'`) and its `agreement.accepted` audit
 * row, from `agreementAcceptanceStatements`, in one `db.batch`. The row stores what a
 * claim stores: the seat's email and profile, the signer's name, the title and legal name
 * typed on the screen, the time, the version, the box's exact label and its hash, and the
 * unticked flag. A Vendor Terms row also stores the two policy versions the terms
 * incorporate. A Managed plan row stores the Plans page version. No IP address or browser
 * (`PORTAL_RECORDS_EVIDENCE`, until the Privacy Policy names this acceptance). No cache
 * purge: no public page shows an acceptance. Nothing about a subscription changes.
 */

import {
  AcceptLegalVersionRequestSchema,
  AcceptLegalVersionResponseSchema,
  ApiErrorCode,
  PLANS_PAGE_CURRENT_VERSION,
  portalAcceptanceLabel,
  VendorLegalAcceptanceResponseSchema,
  type AcceptLegalVersionResponse,
  type VendorLegalAcceptanceResponse,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { and, eq, isNull } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { billingAccounts, profiles, vendors } from '../db/schema';
import type { BatchTuple } from '../lib/audit';
import {
  agreementAcceptanceStatements,
  currentPolicyVersions,
  loadCheckoutSigner,
} from '../lib/agreement-acceptances';
import { auditActorType } from '../lib/authz';
import { sha256Hex } from '../lib/hash';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { loadLegalAcceptanceInputs, pendingAcceptances } from '../lib/legal-acceptance';
import { ApiError } from '../errors';
import { json } from '../http';
import {
  afterVendorWrite,
  ownerSeatsOf,
  parseJsonBody,
  requireSeatOwner,
  sessionVendorId,
  sessionVendorPlan,
  type VendorContext,
} from './vendor-shared';

const OWNER_ONLY = 'Only an owner seat can accept an agreement for the company';

/** The clock, injectable for specs. */
export type Clock = () => Date;
const systemClock: Clock = () => new Date();

/** The state one session sees: what is pending, and what the screen pre-fills. */
export async function legalAcceptanceState(
  db: Db,
  userId: string,
  vendorId: string,
  nowMs: number,
): Promise<VendorLegalAcceptanceResponse> {
  const [inputs, seat] = await Promise.all([
    loadLegalAcceptanceInputs(db, vendorId),
    db.query.profiles.findFirst({
      columns: { seatOwner: true },
      where: and(eq(profiles.id, userId), eq(profiles.vendorId, vendorId)),
    }),
  ]);
  const owner = seat?.seatOwner === true;
  const all = pendingAcceptances(inputs, nowMs);
  const blocked = all.some((p) => p.mode === 'required');

  if (!owner) {
    const ownerNames = blocked
      ? (
          await db
            .select({ displayName: profiles.displayName })
            .from(profiles)
            .where(and(ownerSeatsOf(vendorId), isNull(profiles.bannedAt)))
        )
          .map((r) => r.displayName?.trim() ?? '')
          .filter((name) => name.length > 0)
          .sort(compareText)
      : [];
    return {
      blocked,
      can_accept: false,
      pending: all.filter((p) => p.mode === 'required'),
      owner_names: ownerNames,
      signer: null,
    };
  }

  const signer = all.length > 0 ? await loadCheckoutSigner(db, userId, vendorId) : null;
  return {
    blocked,
    can_accept: true,
    pending: all,
    owner_names: [],
    signer: signer ? { title: signer.title, legal_name: signer.companyLegalName } : null,
  };
}

/** `GET /api/vendor/legal-acceptance`. */
export function createVendorLegalAcceptanceHandler(
  dbFor: DbFactory = getDb,
  clock: Clock = systemClock,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = dbFor(c.env);
    const body = await legalAcceptanceState(db, session.userId, vendorId, clock().getTime());
    validateResponseInDev(c.env, () => VendorLegalAcceptanceResponseSchema.parse(body));
    return json(body);
  };
}

function notPending(document: string, version: string): ApiError {
  return new ApiError(
    422,
    ApiErrorCode.LEGAL_ACCEPTANCE_NOT_PENDING,
    `Version ${version} of this agreement is not waiting for your company's acceptance. Reload the page.`,
    { field: 'version', details: { document, version } },
  );
}

/** `POST /api/vendor/legal-acceptance`. */
export function createAcceptLegalVersionHandler(
  dbFor: DbFactory = getDb,
  clock: Clock = systemClock,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const vendorId = sessionVendorId(c);
    const { db } = writeDb(c, dbFor);

    // 1. Owner seats only. Any owner seat accepts for the company (ruling 24).
    await requireSeatOwner(db, session.userId, vendorId, OWNER_ONLY);

    // 2. Shape: the box ticked, a title and a legal name.
    const payload = await parseJsonBody(c, AcceptLegalVersionRequestSchema);

    // 3. The version must be pending for this company right now.
    const now = clock();
    const [inputs, vendor, account] = await Promise.all([
      loadLegalAcceptanceInputs(db, vendorId),
      db.query.vendors.findFirst({
        columns: { companyName: true },
        where: eq(vendors.id, vendorId),
      }),
      db.query.billingAccounts.findFirst({
        columns: { id: true },
        where: eq(billingAccounts.vendorId, vendorId),
      }),
    ]);
    const pending = pendingAcceptances(inputs, now.getTime()).find(
      (p) => p.document === payload.document && p.version === payload.version,
    );
    if (!pending || !vendor) throw notPending(payload.document, payload.version);

    // 4. The acceptance and its audit row, one batch.
    const labelText = portalAcceptanceLabel(pending.document, pending.version, vendor.companyName);
    const signer = await loadCheckoutSigner(db, session.userId, vendorId, payload.signer_title);
    const acceptedAt = now.toISOString();
    const batch = agreementAcceptanceStatements(db, {
      document: pending.document,
      version: pending.version,
      portalVersion: pending.version,
      source: 'portal',
      email: session.email ?? '',
      profileId: session.userId,
      vendorId,
      billingAccountId: account?.id ?? null,
      acceptedAt,
      requestHeaders: c.req.raw.headers,
      signer: {
        name: signer.name,
        title: payload.signer_title,
        companyLegalName: payload.company_legal_name,
      },
      checkbox: {
        labelText,
        labelSha256: await sha256Hex(labelText),
        defaultUnticked: true,
      },
      policyVersions: pending.document === 'vendor_terms' ? currentPolicyVersions() : null,
      plansVersion: pending.document === 'managed_plan' ? PLANS_PAGE_CURRENT_VERSION : null,
      actorId: session.userId,
      actorType: auditActorType(session),
      vendorPlan: sessionVendorPlan(c),
    });
    await db.batch(batch.stmts as BatchTuple);
    // No tags: no public page shows an acceptance. The tail forwards the audit row.
    afterVendorWrite(c, [], batch.auditEntry);

    const body: AcceptLegalVersionResponse = {
      document: pending.document,
      version: pending.version,
      accepted_at: acceptedAt,
      state: await legalAcceptanceState(db, session.userId, vendorId, now.getTime()),
    };
    validateResponseInDev(c.env, () => AcceptLegalVersionResponseSchema.parse(body));
    return json(body, { status: 201 });
  };
}
