/**
 * Admin user surface (AECI-692 / `docs/ADMIN_PANEL_SPEC.md` §5.8) — Drizzle/D1,
 * behind `requireAdmin()`.
 *
 *   GET /api/admin/users      — paginated list, filters + name/email search
 *   GET /api/admin/users/:id  — profile, auth account, seat, invites, counts
 *
 * Until this shipped there was no user list at all. `GET /api/admin/reviewers`
 * selects `WHERE banned_at IS NOT NULL`, so the only person-shaped surface in the
 * console showed *only banned people*; everyone else appeared incidentally as a
 * review's author, a claim's submitter, or a seat row on a claim card. An
 * operator could not look up an arbitrary account at all — which is also why ban
 * had no home: it could only be *initiated* from the review queue's
 * repeat-offender prompt and *reversed* on `/admin/reviewers`.
 *
 * ── TWO READS, AND NO NEW `banned_at` WRITER ─────────────────────────────────
 * Ban and reinstate reuse `PATCH /api/admin/reviewers/:id`
 * (`routes/admin-reviewers.ts`) completely unchanged — same guardrails (cannot
 * ban an admin or yourself, 422 on a repeat), same role-aware audit actions
 * (`reviewer.banned` / `vendor_admin.banned` / `.unbanned`), same
 * `workflow_instances` toggle, all in one `db.batch`. That handler is the SOLE
 * writer of `profiles.banned_at` anywhere in the codebase and this module adds
 * no second one; `banned-at-writers.spec.ts` asserts it at the source level.
 *
 * Seat revoke is likewise not here. It stays `DELETE /api/admin/vendors/:id/
 * seats/:userId`, because a revoke decision needs the roster's blast radius (the
 * other seats, the entitlement state) that a person-scoped page cannot show, and
 * because the revoke-≠-ban-≠-entitlement-clear copy invariants
 * (`AUTH_AND_RLS.md` §3.2) must live in exactly one place. `seat.vendor_id` is
 * shipped so the UI can link straight there.
 *
 * Both GETs emit **no `audit_log` row** — reads write nothing
 * (`ADMIN_PANEL_SPEC.md` §9.3; ADR 0022 scopes the §26.1 invariant). `json()`
 * sets `private, no-store` and `/admin/*` is absent from `ROUTE_CACHE_PATTERNS`.
 *
 * ── THE SEAM IS ABSENT MORE OFTEN THAN IT IS PRESENT ─────────────────────────
 * `SUPABASE_SERVICE_ROLE_KEY` is legitimately unset on local dev and on every PR
 * preview (`pr-preview.yml` withholds it deliberately), so the degraded path is
 * the DEFAULT path here, not an edge case. Every auth-derived field is therefore
 * tri-state: `auth_available` says whether the seam ran, an absent record says
 * the account does not exist, and a `null` field says the account has no such
 * value. Collapsing any two of those is how "Account status unknown" hid a
 * misconfigured key for a day on 2026-08-24.
 */

import {
  AdminUserDetailSchema,
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
  ApiErrorCode,
  REPEAT_OFFENDER_THRESHOLD,
  type AdminUserAuthAccount,
  type AdminUserCounts,
  type AdminUserDetail,
  type AdminUserEmailSearch,
  type AdminUserPendingInvite,
  type AdminUserRow,
  type AdminUserSeat,
  type AdminUsersListResponse,
} from '@aeci/shared';
import { and, count, eq, gt, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import {
  profiles,
  reviews,
  vendorEntitlements,
  vendorRequests,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import type { AuthzVariables } from '../lib/authz';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { resolveAdminUserOrderBy } from '../lib/sort';
import { likeContains } from '../lib/sql-like';
import {
  fetchAuthUserRecords,
  findAuthUserByEmail,
  type AuthUserRecord,
  type FetchAuthRecords,
  type FindAuthUserByEmail,
} from '../lib/supabase-admin';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';

type AdminUserContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requiredParam(c: AdminUserContext, name: string): string {
  const value = c.req.param(name);
  if (!value) {
    throw new ApiError(400, ApiErrorCode.VALIDATION_FAILED, `Missing ${name}`, { field: name });
  }
  return value;
}

function parseQuery<T>(c: AdminUserContext, schema: { parse: (input: unknown) => T }): T {
  return schema.parse(Object.fromEntries(new URL(c.req.url).searchParams));
}

/**
 * A seat is `role = 'vendor_admin' AND vendor_id IS NOT NULL` — the same shape
 * `seatsOf()` (`routes/vendor-shared.ts`) uses per-vendor, expressed here
 * unbound so the list can filter on "holds any seat".
 *
 * Both halves matter. A `reviewer` row carrying a stale `vendor_id` is NOT a
 * seat and must not be counted as one, or `/admin/users?has_seat=true` would
 * disagree with `GET /api/vendor/seats` about who has access — and those two
 * disagreeing is a support ticket that starts "the portal says I'm not on the
 * account".
 */
function holdsSeat(): SQL {
  return and(eq(profiles.role, VENDOR_ADMIN_ROLE), isNotNull(profiles.vendorId)) as SQL;
}

/** The exact complement of {@link holdsSeat}. Written as an explicit `or` rather
 *  than `not(and(...))` because SQLite's three-valued logic makes `NOT` over a
 *  nullable column surprising: `NOT (role='vendor_admin' AND vendor_id IS NOT
 *  NULL)` is what we want here, but the `IS NULL` form says it without relying
 *  on the reader to work that through. */
function holdsNoSeat(): SQL {
  return or(ne(profiles.role, VENDOR_ADMIN_ROLE), isNull(profiles.vendorId)) as SQL;
}

/** Map a GoTrue record onto the wire block. `null` in, `null` out — the caller's
 *  `auth_available` is what says whether that means "seam down" or "no account". */
function toAuthAccount(record: AuthUserRecord | undefined): AdminUserAuthAccount | null {
  if (!record) return null;
  return {
    email: record.email,
    last_sign_in_at: record.last_sign_in_at,
    created_at: record.created_at,
    email_confirmed_at: record.email_confirmed_at,
  };
}

/** Build the seat block from a `profiles` row joined to its vendor. Returns
 *  `null` unless BOTH the role and the join hold — see {@link holdsSeat}. */
function toSeat(row: {
  role: string;
  vendorId: string | null;
  seatOwner: boolean;
  vendorCompanyName: string | null;
  vendorSlug: string | null;
}): AdminUserSeat | null {
  if (row.role !== VENDOR_ADMIN_ROLE) return null;
  if (!row.vendorId || !row.vendorCompanyName || !row.vendorSlug) return null;
  return {
    vendor_id: row.vendorId,
    company_name: row.vendorCompanyName,
    slug: row.vendorSlug,
    owner: row.seatOwner,
  };
}

// ─── GET /api/admin/users ────────────────────────────────────────────────────

/**
 * The user list — **profiles-first**, and that is a decision not a convenience.
 *
 * GoTrue's own `GET /admin/users` would literally answer "every account with an
 * auth row", but ONE Supabase project backs EVERY environment (ADR 0017), so an
 * auth-first list rendered on production would include staging and preview
 * signups, and its "has no profile" rows would be ambiguous across tiers.
 * `profiles` is the per-environment truth; the seam enriches the page that D1
 * already chose.
 *
 * The `count()` statement carries no join because every filter is on `profiles`.
 * If a filter on the vendor ever lands here it has to be added to BOTH — the two
 * predicates must stay identical or `total` stops describing `data`.
 */
export function createAdminUsersListHandler(
  dbFor: DbFactory = getDb,
  fetchRecords: FetchAuthRecords = fetchAuthUserRecords,
  findByEmail: FindAuthUserByEmail = findAuthUserByEmail,
): (c: AdminUserContext) => Promise<Response> {
  return async (c) => {
    const query = parseQuery(c, AdminUsersListQuerySchema);
    const { db } = dbFor(c.env);

    const search = query.search?.trim();

    // The email leg runs BEFORE D1, because its result is a `WHERE` disjunct.
    //
    // Gated on `@` so typing a name costs no round trip. It is an EXACT match:
    // GoTrue's `?filter=` is a case-sensitive substring over email OR display
    // name, and `findAuthUserByEmail` narrows it to an exact lowercased equality
    // client-side (without which `jane@acme.com` matches `jane@acme.com.evil.io`).
    // So a partial like `@acme.com` legitimately finds nothing, and the response
    // says which of the three things happened rather than leaving an empty page
    // to be read as "no such user".
    let emailSearch: AdminUserEmailSearch | null = null;
    let emailMatchId: string | null = null;
    if (search && search.includes('@')) {
      const found = await findByEmail(c.env, search);
      if (found.skipped || !found.ok) {
        emailSearch = 'unavailable';
      } else if (found.user) {
        emailSearch = 'matched';
        emailMatchId = found.user.id;
      } else {
        emailSearch = 'no_match';
      }
    }

    const where = and(
      search
        ? or(
            likeContains(profiles.displayName, search),
            emailMatchId ? eq(profiles.id, emailMatchId) : undefined,
          )
        : undefined,
      query.role === undefined ? undefined : eq(profiles.role, query.role),
      query.banned === undefined
        ? undefined
        : query.banned
          ? isNotNull(profiles.bannedAt)
          : isNull(profiles.bannedAt),
      query.has_seat === undefined ? undefined : query.has_seat ? holdsSeat() : holdsNoSeat(),
    );

    const [rows, totals] = await db.batch([
      db
        .select({
          id: profiles.id,
          displayName: profiles.displayName,
          role: profiles.role,
          vendorId: profiles.vendorId,
          seatOwner: profiles.seatOwner,
          bannedAt: profiles.bannedAt,
          createdAt: profiles.createdAt,
          updatedAt: profiles.updatedAt,
          vendorCompanyName: vendors.companyName,
          vendorSlug: vendors.slug,
        })
        .from(profiles)
        // Cannot multiply rows: `profiles.vendor_id` is single-valued, so this is
        // at most one vendor per profile (`AUTH_AND_RLS.md` §3.2 exclusivity).
        .leftJoin(vendors, eq(vendors.id, profiles.vendorId))
        .where(where)
        .orderBy(...resolveAdminUserOrderBy(query.sort))
        .limit(query.perPage)
        .offset((query.page - 1) * query.perPage),
      db.select({ value: count() }).from(profiles).where(where),
    ]);

    // One bounded fan-out AFTER the page is chosen — `perPage` GETs in waves of
    // WORKER_CONNECTION_LIMIT, which is why `perPage` caps at 50 here.
    const lookup = await fetchRecords(
      c.env,
      rows.map((row) => row.id),
    );

    const body: AdminUsersListResponse = {
      data: rows.map(
        (row): AdminUserRow => ({
          id: row.id,
          display_name: row.displayName,
          role: row.role,
          seat: toSeat(row),
          auth: toAuthAccount(lookup.records.get(row.id)),
          banned_at: row.bannedAt,
          created_at: row.createdAt,
          updated_at: row.updatedAt,
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totals[0]?.value ?? 0,
      auth_available: lookup.available,
      email_search: emailSearch,
    };

    validateResponseInDev(c.env, () => {
      AdminUsersListResponseSchema.parse(body);
    });
    return json(body);
  };
}

// ─── GET /api/admin/users/:id ────────────────────────────────────────────────

const EMPTY_REVIEW_COUNTS: AdminUserCounts['reviews'] = {
  pending: 0,
  approved: 0,
  rejected: 0,
  archived: 0,
};

/**
 * One person, everything the console knows about them.
 *
 * Three round trips by construction, and the order is forced: D1 first (the
 * profile, its seat, and the counts that need no address), then the seam (to
 * learn the address), then the two reads that are *keyed by* that address.
 * Pending invites and request matches are addressed to an email, not to a user
 * id — `vendor_seat_invites.email` deliberately has no `profiles` FK (an invitee
 * usually has no account yet) and `vendor_requests` has no submitter FK at all
 * (submission is anonymous) — so with the seam down they are genuinely
 * unknowable, and both report `null` rather than an empty answer.
 *
 * **There are no page-view stats here and there never will be.** AECI-585
 * dropped `page_views.user_id` / `session_id` / `profile_role`, and
 * `ADMIN_PANEL_SPEC.md` §9 item 7 forbids visitor↔account correlation. There is
 * no join column to reconstruct, by decision.
 */
export function createAdminUserDetailHandler(
  dbFor: DbFactory = getDb,
  fetchRecords: FetchAuthRecords = fetchAuthUserRecords,
): (c: AdminUserContext) => Promise<Response> {
  return async (c) => {
    const userId = requiredParam(c, 'id');
    const { db } = dbFor(c.env);

    const [profileRows, reviewRows, invitesSent, entitlementsGranted] = await db.batch([
      db
        .select({
          id: profiles.id,
          displayName: profiles.displayName,
          role: profiles.role,
          vendorId: profiles.vendorId,
          trustTier: profiles.trustTier,
          workEmailVerified: profiles.workEmailVerified,
          seatOwner: profiles.seatOwner,
          bannedAt: profiles.bannedAt,
          banReason: profiles.banReason,
          createdAt: profiles.createdAt,
          updatedAt: profiles.updatedAt,
          vendorCompanyName: vendors.companyName,
          vendorSlug: vendors.slug,
        })
        .from(profiles)
        .leftJoin(vendors, eq(vendors.id, profiles.vendorId))
        .where(eq(profiles.id, userId)),
      // Grouped, not four scalar counts: one statement, and a status the CHECK
      // gains later shows up as an unmapped key rather than silently vanishing.
      db
        .select({ status: reviews.status, value: count() })
        .from(reviews)
        .where(eq(reviews.reviewerId, userId))
        .groupBy(reviews.status),
      // All time, any state — a spent or revoked invite still happened.
      db
        .select({ value: count() })
        .from(vendorSeatInvites)
        .where(eq(vendorSeatInvites.invitedById, userId)),
      db
        .select({ value: count() })
        .from(vendorEntitlements)
        .where(eq(vendorEntitlements.grantedBy, userId)),
    ]);

    const profile = profileRows[0];
    // 404 before anything else is rendered: an unknown id must not come back as
    // a successful page of zeroes.
    if (!profile) throw notFoundError('profile', { id: userId });

    const reviewCounts = { ...EMPTY_REVIEW_COUNTS };
    for (const row of reviewRows) {
      if (row.status in reviewCounts) {
        reviewCounts[row.status as keyof typeof reviewCounts] = row.value;
      }
    }

    const lookup = await fetchRecords(c.env, [userId]);
    const record = lookup.records.get(userId);
    const email = record?.email ?? null;

    // Keyed by address, so they are unknowable without the seam. `null`, never
    // `[]` or `0` — an empty answer here would assert "no invites / no requests",
    // which is a different and possibly false claim.
    let pendingInvites: AdminUserPendingInvite[] | null = null;
    let requestsByEmail: number | null = null;
    if (email) {
      const nowIso = new Date().toISOString();
      const [inviteRows, requestCounts] = await db.batch([
        db
          .select({
            id: vendorSeatInvites.id,
            email: vendorSeatInvites.email,
            expiresAt: vendorSeatInvites.expiresAt,
            createdAt: vendorSeatInvites.createdAt,
            invitedByName: profiles.displayName,
            vendorId: vendorSeatInvites.vendorId,
            vendorName: vendors.companyName,
          })
          .from(vendorSeatInvites)
          .leftJoin(profiles, eq(profiles.id, vendorSeatInvites.invitedById))
          .innerJoin(vendors, eq(vendors.id, vendorSeatInvites.vendorId))
          .where(
            and(
              // Invite addresses ARE normalized on write (`normalizeInviteEmail`),
              // and GoTrue stores lowercased, so a direct `eq` is exact here.
              eq(vendorSeatInvites.email, email.toLowerCase()),
              isNull(vendorSeatInvites.acceptedAt),
              isNull(vendorSeatInvites.revokedAt),
              // "Pending" is both terminal columns null; "LIVE" additionally
              // requires an unexpired row, and the caller applies that — the
              // shared `pendingInvitesFor` predicate deliberately does not.
              gt(vendorSeatInvites.expiresAt, nowIso),
            ),
          ),
        db
          .select({ value: count() })
          .from(vendorRequests)
          // `lower()` on BOTH sides: `submitter_email` is `.trim()`-ed but NOT
          // lowercased on write (`api/requests.ts`), so a bare `eq` against a
          // GoTrue address silently misses `Jane@Acme.com`.
          .where(sql`lower(${vendorRequests.submitterEmail}) = ${email.toLowerCase()}`),
      ]);

      pendingInvites = inviteRows.map(
        (row): AdminUserPendingInvite => ({
          id: row.id,
          email: row.email,
          invited_by: row.invitedByName,
          expires_at: row.expiresAt,
          created_at: row.createdAt,
          vendor_id: row.vendorId,
          vendor_name: row.vendorName,
        }),
      );
      requestsByEmail = requestCounts[0]?.value ?? 0;
    }

    const body: AdminUserDetail = {
      id: profile.id,
      display_name: profile.displayName,
      role: profile.role,
      trust_tier: profile.trustTier,
      work_email_verified: profile.workEmailVerified,
      seat_owner: profile.seatOwner,
      banned_at: profile.bannedAt,
      ban_reason: profile.banReason,
      created_at: profile.createdAt,
      updated_at: profile.updatedAt,
      auth: toAuthAccount(record),
      auth_available: lookup.available,
      seat: toSeat(profile),
      pending_invites: pendingInvites,
      counts: {
        reviews: reviewCounts,
        seat_invites_sent: invitesSent[0]?.value ?? 0,
        entitlements_granted: entitlementsGranted[0]?.value ?? 0,
        requests_by_email: requestsByEmail,
      },
      // Server-computed from the same constant the moderation queue uses, so the
      // two surfaces cannot label the same person differently.
      repeat_offender: reviewCounts.rejected >= REPEAT_OFFENDER_THRESHOLD,
    };

    validateResponseInDev(c.env, () => {
      AdminUserDetailSchema.parse(body);
    });
    return json(body);
  };
}
