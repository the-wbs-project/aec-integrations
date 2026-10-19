/**
 * `GET` / `PATCH` / `DELETE /api/account` (AECI-202 / Phase 5.11) — Drizzle/D1
 * (ADR 0016 / AECI-253, AECI-254).
 *
 * Auth-gated by `requireAuth()`; `c.get('auth')` is the verified session. `userId`
 * is the token `sub` — the id of both the `profiles` row (D1) and the `auth.users`
 * row (Supabase).
 *
 * ── The queue counts on the read shapes (AECI-617, AECI-922) ───────────────────
 * `GET`/`PATCH` return the three Operations queue counts for `role === 'admin'`
 * (`null` otherwise) so the header's role probe (`apps/web/.../auth/role-status.ts`)
 * gets role + badge counts in one round trip rather than chaining
 * `GET /api/admin/summary`. That second hop repeated the JWKS verify and the
 * `profiles` read, and its latency was the visible lag before the header's Admin
 * affordance appeared. `routes/admin-summary.ts` is unchanged in shape — it stays
 * the `/admin` SSR resolver's gate and the in-shell badge feed, and since
 * AECI-922 both endpoints read the SAME implementation
 * (`lib/admin-queue-counts.ts`), so the header badge and the console's Operations
 * badge cannot report different backlogs.
 *
 * That one probe also answers the vendor portal's door (`role === 'vendor_admin'`),
 * so a signed-in page load makes a single request here however many role-gated
 * affordances the header carries.
 *
 * ── "About you" (AECI-1296) ─────────────────────────────────────────────────────
 * `GET` and `PATCH` also carry the onboarding answers from the `profile_details`
 * and `profile_audiences` side tables (`docs/ACCOUNT_ONBOARDING_SPEC.md`). `PATCH`
 * writes them in the same `db.batch` as the `profiles` update and the one
 * `profile.updated` audit row. `ensureProfileRow` never writes them.
 *
 * ── Erasure (DELETE), split across the identity seam ────────────────────────────
 * `profiles(id)` has seventeen inbound FKs (`AUTH_AND_RLS.md` §8); five are NO ACTION,
 * so they must be nulled before the profile delete. Three (`notification_preferences`,
 * `profile_details`, `profile_audiences`) cascade. The batch nulls the other fourteen.
 * Migration 0082 (AECI-1358) dropped an eighteenth, `vendor_entitlements.granted_by`.
 * Under D1 that erasure is ONE atomic `db.batch([...])` (null all 14 refs + the PII-free
 * `account.deleted` audit + delete the profile).
 * The `auth.users` row then goes via the GoTrue Admin API (seam #3,
 * `lib/supabase-admin.ts`) AFTER the batch commits — an HTTP call can't join the
 * D1 transaction. The D1 data erasure is the GDPR-load-bearing step; if the auth
 * delete fails it is logged (the orphaned auth row re-provisions a fresh empty
 * profile on next login) and does not fail the response.
 *
 * The `account.deleted` audit row MUST have `actorId: null` — the profile is
 * deleted in the same batch and `audit_log.actor_id` is NO ACTION.
 *
 * ── A vendor's last seat freezes the record (AECI-1106, AECI-1415) ────────────
 * A `vendor_admin` seat IS a `profiles` row, so erasing it is a seat loss, the same
 * as the admin revoke. When the erased seat leaves the vendor with no unbanned seat,
 * `planOwnerSeatLapse` joins the erasure batch and moves the owner contests to AECi,
 * stamped. Ownership, `maintained_by` and `claimed_at` stay: seat loss never hands
 * records back (ruled 2026-10-19, ADR 0042). The rows and audit set are the
 * revoke's (`STAGE_2_ATTESTATIONS_SPEC.md` §13.9). Their audit and transition
 * actor is `null`, for the reason above. The race guards sit straight after the
 * profile delete. A lost race re-plans and retries a bounded number of times
 * rather than failing the erasure.
 */

import {
  ApiErrorCode,
  CompanySizeSchema,
  CompanyTypeSchema,
  ProfilePrimaryRoleSchema,
  UpdateAccountSchema,
} from '@aeci/shared';
import type {
  AccountProfileDetails,
  AccountProfileResponse,
  DeleteAccountResponse,
  OnboardingState,
  UpdateAccountInput,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type DbContext } from '../db/client';
import { forwardAuditBatch } from '../lib/moderation-forward';
import {
  auditLog,
  billingAccounts,
  integrationFieldChallenges,
  licenseReleaseRequests,
  licenses,
  profileAudiences,
  profileDetails,
  profiles,
  reviewResponses,
  reviews,
  taxonomyAudiences,
  userActivityDaily,
  vendorRequests,
  vendorSeatInvites,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import { logToPosthog } from '../posthog';
import type { Env } from '../env';
import { ApiError } from '../errors';
import { json } from '../http';
import { readAdminQueueCounts, type AdminQueueCounts } from '../lib/admin-queue-counts';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { auditInsert, type BatchStmt, type BatchTuple } from '../lib/audit';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import { sendAccountDeletionEmail } from '../lib/email';
import { writeDb, type DbFactory } from '../lib/handler-utils';
import { deleteAuthUser as deleteAuthUserDefault } from '../lib/supabase-admin';
import {
  isSeatsChangedError,
  planOwnerSeatLapse,
  seatLossOutcome,
  seatRaceSentinels,
  seatsChangedError,
  type HandbackBatch,
  type SeatLossOutcome,
} from '../lib/vendor-handback';

type AuthContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

async function parseJsonBody<T>(c: AuthContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

// ─── Account state read (GET + PATCH) ──────────────────────────────────────────

/** Everything the account read shapes report from D1 for one user. */
interface AccountState {
  displayName: string | null;
  listingViewPreference: 'cards' | 'table' | null;
  details: AccountProfileDetails;
  onboarding: OnboardingState;
}

/**
 * The profile, its "About you" row and its audience ids, in ONE batch. A
 * missing `profile_details` row reads as all-null details and `pending`.
 *
 * A stored enum value the current build does not know reads as `null` rather
 * than failing the read. The columns carry no CHECK (the lists live in Zod), so
 * a value retired from a list must not break every later account read.
 */
async function readAccountState(db: DbContext['db'], userId: string): Promise<AccountState> {
  const [profileRows, audienceRows] = await db.batch([
    db
      .select({
        displayName: profiles.displayName,
        listingViewPreference: profiles.listingViewPreference,
        companyType: profileDetails.companyType,
        companySize: profileDetails.companySize,
        primaryRole: profileDetails.primaryRole,
        firmName: profileDetails.firmName,
        linkedinUrl: profileDetails.linkedinUrl,
        onboardingCompletedAt: profileDetails.onboardingCompletedAt,
        onboardingSkippedAt: profileDetails.onboardingSkippedAt,
      })
      .from(profiles)
      .leftJoin(profileDetails, eq(profileDetails.profileId, profiles.id))
      .where(eq(profiles.id, userId)),
    db
      .select({ audienceId: profileAudiences.audienceId })
      .from(profileAudiences)
      .where(eq(profileAudiences.profileId, userId))
      // Id order: a stable wire order, not a display order. The client renders
      // names from the audience list it already holds.
      .orderBy(asc(profileAudiences.audienceId)),
  ]);
  const row = profileRows[0];
  return {
    displayName: row?.displayName ?? null,
    listingViewPreference: row?.listingViewPreference ?? null,
    details: {
      company_type: CompanyTypeSchema.safeParse(row?.companyType).data ?? null,
      company_size: CompanySizeSchema.safeParse(row?.companySize).data ?? null,
      primary_role: ProfilePrimaryRoleSchema.safeParse(row?.primaryRole).data ?? null,
      firm_name: row?.firmName ?? null,
      linkedin_url: row?.linkedinUrl ?? null,
      audience_ids: audienceRows.map((a) => a.audienceId),
    },
    onboarding: row?.onboardingCompletedAt
      ? 'completed'
      : row?.onboardingSkippedAt
        ? 'skipped'
        : 'pending',
  };
}

/** The account read shape for a session and its D1 state. */
async function accountBody(
  db: DbContext['db'],
  session: AuthzVariables['auth'],
  state: AccountState,
): Promise<AccountProfileResponse> {
  return {
    user_id: session.userId,
    email: session.email ?? null,
    display_name: state.displayName,
    listing_view_preference: state.listingViewPreference,
    role: session.role,
    ...(await queueCountsForSession(db, session.role)),
    details: state.details,
    onboarding: state.onboarding,
    suggested_display_name: session.fullName ?? null,
  };
}

// ─── GET /api/account ─────────────────────────────────────────────────────────

export function createGetAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { db } = dbFor(c.env);
    return json(await accountBody(db, session, await readAccountState(db, session.userId)));
  };
}

/** The three counts as the account shapes carry them: real numbers for an admin,
 *  `null` for everyone else. Never a mix — a `0` here means an empty queue, and a
 *  `null` means "you are not an operator", which is a different fact. */
type AccountQueueCounts = {
  [K in keyof AdminQueueCounts]: number | null;
};

/** What a non-admin gets. Spread verbatim so the three keys are always present
 *  on the wire and a consumer never has to tell `undefined` from `null`. */
const NO_QUEUE_COUNTS: AccountQueueCounts = {
  pending_reviews: null,
  pending_requests: null,
  pending_claims: null,
  pending_reindex: null,
  pending_contests: null,
  pending_review_responses: null,
};

/**
 * The Operations queue counts for the header badge (AECI-617, widened to three
 * by AECI-922) — the same aggregates `routes/admin-summary.ts` serves, through
 * the same `lib/admin-queue-counts.ts` implementation, folded into the account
 * read so `AdminStatus` resolves role + counts in ONE round trip. Returns `null`s
 * for a non-admin without touching either table, so the extra columns cost a
 * reviewer nothing and leak no moderation state.
 *
 * `session.role` is the DB-refetched role from `requireAuth()` (`lib/authz.ts`
 * re-reads it every request per `AUTH_AND_RLS.md` §4.5), NOT a client claim — so
 * gating on it here is as trustworthy as the `requireAdmin()` gate itself.
 */
async function queueCountsForSession(
  db: DbContext['db'],
  role: string,
): Promise<AccountQueueCounts> {
  if (role !== 'admin') return NO_QUEUE_COUNTS;
  return readAdminQueueCounts(db);
}

// ─── PATCH /api/account ────────────────────────────────────────────────────────

/** The `profile_details` columns a PATCH may carry, wire key → Drizzle key. */
const DETAIL_FIELDS = [
  ['company_type', 'companyType'],
  ['company_size', 'companySize'],
  ['primary_role', 'primaryRole'],
  ['firm_name', 'firmName'],
  ['linkedin_url', 'linkedinUrl'],
] as const satisfies ReadonlyArray<
  readonly [
    keyof AccountProfileDetails & keyof UpdateAccountInput,
    keyof typeof profileDetails.$inferInsert,
  ]
>;

/**
 * 400 unless every id names a real `taxonomy_audiences` row. Read before the
 * batch, so an unknown id fails with a clear error instead of an FK abort
 * halfway through the write.
 */
async function assertAudiencesExist(db: DbContext['db'], ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await db
    .select({ id: taxonomyAudiences.id })
    .from(taxonomyAudiences)
    .where(inArray(taxonomyAudiences.id, [...ids]));
  const known = new Set(found.map((row) => row.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'Unknown audience id', {
      field: 'audience_ids',
      details: { unknown },
    });
  }
}

export function createUpdateAccountHandler(
  dbFor: DbFactory = getDb,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    const payload = await parseJsonBody(c, UpdateAccountSchema);
    const { db } = writeDb(c, dbFor);

    // Replace-set semantics: a repeated id is one pick, not a PK conflict.
    const audienceIds =
      payload.audience_ids === undefined ? undefined : [...new Set(payload.audience_ids)];
    if (audienceIds) await assertAudiencesExist(db, audienceIds);

    const before = await readAccountState(db, userId);
    const now = new Date().toISOString();

    // Present-key semantics (the schema guarantees at least one key): only the
    // fields the PATCH actually carries are written, so a listing-page toggle
    // click can persist `listing_view_preference` alone without re-sending the
    // display name — and an account-form save can't clobber the remembered
    // view with a stale client copy it never held.
    const updates: {
      displayName?: string | null;
      listingViewPreference?: 'cards' | 'table' | null;
    } = {};
    if (payload.display_name !== undefined) updates.displayName = payload.display_name;
    if (payload.listing_view_preference !== undefined)
      updates.listingViewPreference = payload.listing_view_preference;

    // The audit mirrors exactly the touched keys, with their before-values —
    // an untouched field never appears (so a toggle click doesn't log a no-op
    // display_name change).
    const beforeState: Record<string, unknown> = {};
    const afterState: Record<string, unknown> = {};
    if (payload.display_name !== undefined) {
      beforeState.display_name = before.displayName;
      afterState.display_name = payload.display_name;
    }
    if (payload.listing_view_preference !== undefined) {
      beforeState.listing_view_preference = before.listingViewPreference;
      afterState.listing_view_preference = payload.listing_view_preference;
    }

    // "About you" (AECI-1296): the `profile_details` upsert, same present-key rule.
    const detailUpdates: Partial<typeof profileDetails.$inferInsert> = {};
    for (const [wire, column] of DETAIL_FIELDS) {
      const value = payload[wire];
      if (value === undefined) continue;
      detailUpdates[column] = value;
      beforeState[wire] = before.details[wire];
      afterState[wire] = value;
    }
    if (payload.onboarding !== undefined) {
      if (payload.onboarding === 'completed') detailUpdates.onboardingCompletedAt = now;
      else detailUpdates.onboardingSkippedAt = now;
      beforeState.onboarding = before.onboarding;
      afterState.onboarding = payload.onboarding;
    }
    if (audienceIds !== undefined) {
      beforeState.audience_ids = before.details.audience_ids;
      afterState.audience_ids = audienceIds;
    }

    const auditEntry: AuditLogEntry = {
      actorId: userId,
      actorType: auditActorType(session),
      action: 'profile.updated',
      entityType: 'profile',
      entityId: userId,
      beforeState,
      afterState,
      metadata: { source: 'account' },
    };

    const stmts: BatchStmt[] = [];
    if (Object.keys(updates).length > 0) {
      stmts.push(db.update(profiles).set(updates).where(eq(profiles.id, userId)));
    }
    if (Object.keys(detailUpdates).length > 0) {
      stmts.push(
        db
          .insert(profileDetails)
          .values({ profileId: userId, ...detailUpdates })
          .onConflictDoUpdate({
            target: profileDetails.profileId,
            // `$onUpdate` does not fire inside an upsert's SET, so stamp it here.
            set: { ...detailUpdates, updatedAt: now },
          }),
      );
    }
    if (audienceIds !== undefined) {
      stmts.push(db.delete(profileAudiences).where(eq(profileAudiences.profileId, userId)));
      if (audienceIds.length > 0) {
        stmts.push(
          db
            .insert(profileAudiences)
            .values(audienceIds.map((audienceId) => ({ profileId: userId, audienceId }))),
        );
      }
    }
    stmts.push(auditInsert(db, auditEntry));

    await db.batch(stmts as BatchTuple);

    forwardAuditBatch(c, [auditEntry], [], 'account');

    // Read back rather than merge by hand: the response then reports what D1
    // holds, including the derived onboarding state.
    return json(await accountBody(db, session, await readAccountState(db, userId)));
  };
}

// ─── DELETE /api/account (GDPR erasure) ────────────────────────────────────────

/** Attempts at the erasure batch when the AECI-989 seat guards abort it. */
export const ERASURE_SEAT_ATTEMPTS = 3;

/** What the erasure of a `vendor_admin` seat does to its vendor (AECI-1106). */
interface ErasureSeatPlan {
  vendorId: string;
  outcome: SeatLossOutcome;
  /** The seat lapse. `null` while an unbanned seat remains. */
  follow: HandbackBatch | null;
}

/**
 * `null` unless the profile being erased is a `vendor_admin` seat on a vendor.
 * Otherwise the same decision the admin revoke makes (`routes/admin-vendors.ts`):
 * no unbanned seat left moves the owner's contests to AECi, stamped, and an
 * unbanned seat left changes nothing. Nothing is handed back (AECI-1415). The
 * erased user cannot be banned, because `requireAuth()` rejects a banned session.
 * Read fresh on every attempt, so a retry plans against the seats a lost race left
 * behind.
 */
async function planErasureSeatLoss(
  db: DbContext['db'],
  userId: string,
  session: AuthzVariables['auth'],
): Promise<ErasureSeatPlan | null> {
  const profile = await db.query.profiles.findFirst({
    columns: { role: true, vendorId: true },
    where: eq(profiles.id, userId),
  });
  if (!profile || profile.role !== VENDOR_ADMIN_ROLE || !profile.vendorId) return null;
  const vendorId = profile.vendorId;
  const outcome = await seatLossOutcome(db, vendorId, userId);
  const params = {
    vendorId,
    actorId: null,
    actorType: auditActorType(session),
    now: new Date().toISOString(),
    source: 'account',
  };
  const follow = outcome === 'none' ? null : await planOwnerSeatLapse(db, params);
  return { vendorId, outcome, follow };
}

export function createDeleteAccountHandler(
  dbFor: DbFactory = getDb,
  deleteAuthUser: typeof deleteAuthUserDefault = deleteAuthUserDefault,
): (c: AuthContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const { userId } = session;
    // Capture the recipient BEFORE erasure — the auth.users row (the email's home)
    // is deleted below, so the §11.1 confirmation must read it up front.
    const recipientEmail = session.email;
    const { db } = writeDb(c, dbFor);

    const auditEntry: AuditLogEntry = {
      // actorId MUST be null — the profile is deleted in this same batch.
      actorId: null,
      actorType: auditActorType(session),
      action: 'account.deleted',
      entityType: 'profile',
      entityId: userId,
      metadata: { source: 'account', initiated_by_self: true },
    };

    // One atomic unit: null every inbound reference (five NO ACTION + the nine SET NULL
    // refs — `reviews.reviewer_id`, `vendor_seat_invites.invited_by_id`, the five
    // contest/protest columns and the two reply columns — made explicit), plus the two no-FK actor columns
    // `billing_accounts.created_by` and `licenses.granted_by`, plus any
    // `billing_accounts.billing_email` equal to the person's address → PII-free audit
    // → delete the profile.
    //
    // `page_views` is deliberately absent (AECI-585 / §13 D7). It used to be nulled
    // here, but `page_views.user_id` was never written by any code path and has now
    // been dropped along with `session_id` and `profile_role`. That strengthens this
    // handler rather than weakening it: the table can no longer hold user linkage at
    // all, so there is nothing here to erase (`AUTH_AND_RLS.md` §8).
    const erasureStmts = (): BatchStmt[] => [
      db
        .update(reviews)
        // Stamp `anonymized_at` in the same statement that nulls the reviewer ref
        // so the pair is atomic — a null `reviewer_id` always carries its
        // anonymization timestamp (the §23.1 / AECI-241 data-quality invariant).
        // Also null the free-text `reviewer_firm` (AECI-284): the firm is more
        // identifying than the generic role enum, so erasure clears it (and it
        // drops out of the contributing-firms count).
        .set({ reviewerId: null, reviewerFirm: null, anonymizedAt: new Date().toISOString() })
        .where(eq(reviews.reviewerId, userId)),
      db.update(reviews).set({ moderatedBy: null }).where(eq(reviews.moderatedBy, userId)),
      db
        .update(vendorRequests)
        .set({ resolvedById: null })
        .where(eq(vendorRequests.resolvedById, userId)),
      db
        .update(workflowInstances)
        .set({ initiatedBy: null })
        .where(eq(workflowInstances.initiatedBy, userId)),
      db
        .update(workflowTransitions)
        .set({ actorId: null })
        .where(eq(workflowTransitions.actorId, userId)),
      db.update(auditLog).set({ actorId: null }).where(eq(auditLog.actorId, userId)),
      // AECI-1350: two actor columns with NO FK to `profiles`, so SQLite would leave
      // the erased id on them and nothing else would clear it. Nulled here for the
      // same reason `user_activity_daily` is deleted: erasure must leave no linkage.
      // The ACCOUNT and the LICENSE survive (they are the vendor's commercial
      // record), and `updated_at` is pinned to itself so `$onUpdate` does not make
      // an erasure look like a commercial change.
      db
        .update(billingAccounts)
        .set({ createdBy: null, updatedAt: sql`${billingAccounts.updatedAt}` })
        .where(eq(billingAccounts.createdBy, userId)),
      db
        .update(licenses)
        .set({ grantedBy: null, updatedAt: sql`${licenses.updatedAt}` })
        .where(eq(licenses.grantedBy, userId)),
      // AECI-1389 (ruling 2026-10-16): a billing email equal to the erased person's
      // address is personal data on a vendor's record, so it is nulled. Any vendor's
      // account, not only the person's own seat: an owner may name anyone. The
      // ACCOUNT survives; an owner sets a new address on the Billing tab. Matched
      // case-insensitively (the writer stores it lower-cased, the JWT may not).
      // `updated_at` pinned, as above. No session email, nothing to match.
      ...(recipientEmail
        ? [
            db
              .update(billingAccounts)
              .set({ billingEmail: null, updatedAt: sql`${billingAccounts.updatedAt}` })
              .where(
                sql`lower(${billingAccounts.billingEmail}) = ${recipientEmail.trim().toLowerCase()}`,
              ),
          ]
        : []),
      // AECI-1373: the two actor columns of an early-unassign request, no FK either.
      // The REQUEST survives (the vendor's commercial record); only who asked and who
      // decided are severed. `updated_at` pinned, as above.
      db
        .update(licenseReleaseRequests)
        .set({ requestedBy: null, updatedAt: sql`${licenseReleaseRequests.updatedAt}` })
        .where(eq(licenseReleaseRequests.requestedBy, userId)),
      db
        .update(licenseReleaseRequests)
        .set({ decidedBy: null, updatedAt: sql`${licenseReleaseRequests.updatedAt}` })
        .where(eq(licenseReleaseRequests.decidedBy, userId)),
      // AECI-664: another of the sixteen (`AUTH_AND_RLS.md` §8), same treatment and same
      // reason. The INVITE survives its sender's erasure — a pending invite is the
      // invitee's to redeem, and deleting it would silently break a colleague's link
      // because someone else closed their account. Only the sender's link is severed.
      db
        .update(vendorSeatInvites)
        .set({ invitedById: null })
        .where(eq(vendorSeatInvites.invitedById, userId)),
      // AECI-1008: two more of the sixteen, both `ON DELETE SET NULL` and nulled
      // explicitly for the same reason. The CONTEST survives: it is a vendor's
      // record, not the person's. Only who filed or decided it is severed.
      db
        .update(integrationFieldChallenges)
        .set({ submittedBy: null })
        .where(eq(integrationFieldChallenges.submittedBy, userId)),
      db
        .update(integrationFieldChallenges)
        .set({ decidedBy: null })
        .where(eq(integrationFieldChallenges.decidedBy, userId)),
      // AECI-1009: three more on the same row, under the same rule. The PROTEST
      // survives; only who filed, replied to or decided it is severed.
      db
        .update(integrationFieldChallenges)
        .set({ protestedBy: null })
        .where(eq(integrationFieldChallenges.protestedBy, userId)),
      db
        .update(integrationFieldChallenges)
        .set({ protestRepliedBy: null })
        .where(eq(integrationFieldChallenges.protestRepliedBy, userId)),
      db
        .update(integrationFieldChallenges)
        .set({ protestDecidedBy: null })
        .where(eq(integrationFieldChallenges.protestDecidedBy, userId)),
      // AECI-1175: two more, `ON DELETE SET NULL` and nulled explicitly under the
      // same rule. The REPLY survives: it is the vendor's record, not the person's
      // (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11c.11). `updated_at` is pinned to itself
      // so `$onUpdate` does not restamp it. On a pending reply it is the queue age
      // (`review_responses_status_updated_idx`), and an erasure must not reorder it.
      db
        .update(reviewResponses)
        .set({ authorProfileId: null, updatedAt: sql`${reviewResponses.updatedAt}` })
        .where(eq(reviewResponses.authorProfileId, userId)),
      db
        .update(reviewResponses)
        .set({ moderatedBy: null, updatedAt: sql`${reviewResponses.updatedAt}` })
        .where(eq(reviewResponses.moderatedBy, userId)),
      // AECI-1208: the per-user service log is erased with the account
      // (`AUTH_AND_RLS.md` §8). It has no FK, so it is deleted explicitly. The
      // activity middleware never writes on this request, and both of its writers
      // gate on the profile existing, so a racing request cannot bring a row back.
      db.delete(userActivityDaily).where(eq(userActivityDaily.userId, userId)),
      auditInsert(db, auditEntry),
      db.delete(profiles).where(eq(profiles.id, userId)),
    ];

    // AECI-1106: a vendor seat's erasure is a seat loss. Plan it, then run the batch
    // with the AECI-989 race guards straight after the profile delete. A lost race
    // re-plans against the seats that are really there: an erasure must not fail
    // because a colleague's seat changed at the same moment (§8). Only a race lost
    // on every attempt answers 409, and nothing is written then.
    let seat: ErasureSeatPlan | null;
    for (let attempt = 1; ; attempt += 1) {
      seat = await planErasureSeatLoss(db, userId, session);
      const stmts = [
        ...erasureStmts(),
        ...(seat
          ? [...seatRaceSentinels(db, seat.vendorId, seat.outcome), ...(seat.follow?.stmts ?? [])]
          : []),
      ];
      try {
        await db.batch(stmts as BatchTuple);
        break;
      } catch (error) {
        if (!seat || !isSeatsChangedError(error)) throw error;
        if (attempt >= ERASURE_SEAT_ATTEMPTS) throw seatsChangedError();
      }
    }

    // Seam #3: delete the auth.users row over the GoTrue Admin API. The D1 data is
    // already erased (GDPR-met); a failure here is logged, not fatal.
    const authResult = await deleteAuthUser(c.env, userId);
    if (!authResult.ok) {
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'warn',
        message: 'account.deleted: auth.users delete failed (D1 data already erased)',
        source: 'account',
        user_id: userId,
        status: authResult.status,
        reason: authResult.error,
      });
    }

    // §26.5 forward + the §11.1 deletion confirmation, fire-and-forget after the
    // erasure. The email fails open (absent key/email → silent skip) and never
    // affects the response — the data is already gone.
    // The seat lapse adds an audit row and a transition per contest, so the
    // forwards go in ONE request. One `fetch` per row ran past the Worker's
    // connection limit on a vendor with many contests (AECI-666, AECI-1112).
    const follow = seat?.follow ?? null;
    forwardAuditBatch(
      c,
      [auditEntry, ...(follow?.audits ?? [])],
      follow?.transitions ?? [],
      'account',
    );
    c.executionCtx.waitUntil(sendAccountDeletionEmail(c, { to: recipientEmail }));
    // No purge: the lapse re-routes contests, and no rendered page changes (AECI-1415).

    const body: DeleteAccountResponse = {
      message: 'Your account and personal data have been deleted.',
    };
    return json(body);
  };
}
