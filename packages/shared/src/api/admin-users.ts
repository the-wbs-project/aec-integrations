import { z } from 'zod';

import {
  PageQuerySchema,
  SortOrderSchema,
  paginatedResponseSchema,
  type SortOrder,
} from './common';
import { VendorSeatInviteSchema } from './vendor';

/**
 * Admin user surface contracts (AECI-692 / `docs/ADMIN_PANEL_SPEC.md` §5.8). The
 * operator's way into a PERSON, behind `requireAdmin()`:
 *
 *   GET /api/admin/users      — paginated list, filters + name/email search
 *   GET /api/admin/users/:id  — profile, auth account, seat, pending invites, counts
 *
 * Before this there was no user list at all. `GET /api/admin/reviewers` selects
 * `WHERE banned_at IS NOT NULL`, so the only person-shaped surface in the console
 * showed *only banned people*; everyone else appeared incidentally as a review's
 * author, a claim's submitter, or a seat row on a claim card. `?banned=true` here
 * supersedes that screen.
 *
 * **No write endpoint lives in this module.** Ban and reinstate reuse
 * `PATCH /api/admin/reviewers/:id` (`admin-reviewers.ts`) completely unchanged —
 * same guardrails, same role-aware audit actions, same workflow row. It stays the
 * **sole writer of `profiles.banned_at`** anywhere in the codebase, and this
 * surface adds no second one. Seat revoke is likewise not here: it stays on
 * `/admin/vendors/:id`, where the roster gives the blast radius that makes the
 * decision safe and where the revoke-≠-ban-≠-entitlement-clear copy invariants
 * (`AUTH_AND_RLS.md` §3.2) already live exactly once.
 *
 * Conventions carried from `admin-vendors.ts`, restated because they are
 * load-bearing here:
 *
 *  - **Required-nullable, never optional (R10).** A field that can genuinely be
 *    absent is `.nullable()` and REQUIRED, so a missed construction site fails
 *    `validateResponseInDev` rather than shipping as `undefined`.
 *  - **`null` means UNAVAILABLE, `[]` means computed-and-empty.** This surface is
 *    the sharpest case of it: `SUPABASE_SERVICE_ROLE_KEY` is legitimately absent
 *    on local dev and PR previews, so the degraded path is the DEFAULT path.
 *  - **Bare `paginatedResponseSchema`**, not the admin-console
 *    `.extend({ generated_at, source, notes })` shape — `/admin/users` is an
 *    Operations surface, the `/admin/claims` / `/admin/vendors` lineage.
 */

// ─── shared blocks ───────────────────────────────────────────────────────────

/**
 * The GoTrue half of an account (`lib/supabase-admin.ts` seam #2).
 *
 * **Three states, not two**, and the difference is operationally load-bearing —
 * it is the distinction the 2026-08-24 "Account status unknown" day turned on:
 *
 *  - response `auth_available: false` → the seam is down (absent creds on local
 *    dev / PR previews, or a GoTrue error). Every `auth` on the page is `null`
 *    and says NOTHING about the accounts.
 *  - `auth_available: true`, `auth: null` → there is no `auth.users` row for this
 *    profile id. That is an ORPHANED PROFILE, a real data defect, not a blank.
 *  - `auth_available: true`, `auth` present, a field `null` → the account exists
 *    and genuinely has no such timestamp (never signed in, never confirmed).
 *
 * Field names are GoTrue's own. **`created_at` here is the AUTH user's creation,
 * which is NOT `profiles.created_at`** on the enclosing row — a profile row is
 * written on the first `/auth/callback`, the auth user at signup, so the two
 * differ. Both are shipped; do not collapse them.
 */
export const AdminUserAuthAccountSchema = z.object({
  email: z.string().nullable(),
  last_sign_in_at: z.string().nullable(),
  created_at: z.string().nullable(),
  email_confirmed_at: z.string().nullable(),
});
export type AdminUserAuthAccount = z.infer<typeof AdminUserAuthAccountSchema>;

/**
 * The ONE vendor seat a profile can hold.
 *
 * There is no `vendor_users` table: a seat IS `role = 'vendor_admin' AND
 * vendor_id IS NOT NULL` on the `profiles` row (`AUTH_AND_RLS.md` §3.2
 * exclusivity), so this is single-valued **by construction** — not a list
 * awaiting a many-to-many. Rendering it as an array would invent a relation the
 * schema cannot express.
 *
 * `null` means "not a seat", INCLUDING the malformed case of a `reviewer` row
 * that happens to carry a `vendor_id`. That matches `seatsOf()`
 * (`routes/vendor-shared.ts`), which is what `GET /api/vendor/seats` uses — the
 * two surfaces must not disagree about who holds a seat.
 *
 * `vendor_id` is shipped so the admin UI can link to `/admin/vendors/:id`, which
 * is where seat management lives. That link is why this surface needs no revoke
 * route of its own.
 */
export const AdminUserSeatSchema = z.object({
  vendor_id: z.string().uuid(),
  company_name: z.string().min(1),
  slug: z.string().min(1),
  /** `profiles.seat_owner` — may invite colleagues and remove seats (§11a). */
  owner: z.boolean(),
});
export type AdminUserSeat = z.infer<typeof AdminUserSeatSchema>;

// ─── GET /api/admin/users ────────────────────────────────────────────────────

/**
 * Sortable columns. **D1 columns ONLY.**
 *
 * `last_sign_in_at` is deliberately absent and will stay absent: it lives in
 * GoTrue, is fetched per-id AFTER the page has been selected, and sorting by it
 * would mean pulling every profile in the environment through the seam. A sort
 * control that silently reorders only the current page is worse than no control.
 *
 * `created` is `profiles.created_at` — when the account first got a profile row
 * in THIS environment — not the `auth.created_at` on the row's `auth` block.
 */
export const AdminUsersSortSchema = z.enum(['created', 'updated']).default('created');
/** Sort direction. Absent = the key's natural direction (both of these descend —
 *  newest first is what an operator opening a user list wants). Shares the
 *  vendor list's semantics because both screens render the same `SortHeader`. */
export type AdminUsersSort = z.infer<typeof AdminUsersSortSchema>;

/** Both keys are naturally newest-first. Same one-copy rule as the vendor map. */
export const ADMIN_USER_SORT_DEFAULT_ORDER: Record<AdminUsersSort, SortOrder> = {
  created: 'desc',
  updated: 'desc',
};

/**
 * Page size for this surface, overriding the shared `PageQuerySchema` default.
 *
 * 24 is not arbitrary and is not the issue's suggested 25: every row costs one
 * GoTrue round trip, run in waves of `WORKER_CONNECTION_LIMIT` (6) with a 5s
 * timeout each, so **24 is exactly 4 waves and 25 is 5** — one extra row for a
 * whole extra wave. The cap is 50 (≈9 waves) rather than the shared 100 (≈17,
 * which at the timeout is minutes) because there is no cache in front of the
 * seam and there deliberately isn't one for role or ban state
 * (`AUTH_AND_RLS.md` §4.5).
 */
export const ADMIN_USERS_DEFAULT_PER_PAGE = 24;
export const ADMIN_USERS_MAX_PER_PAGE = 50;

/**
 * List filter.
 *
 * Every boolean filter is `z.enum(['true','false']).transform(...)`, **never**
 * `z.coerce.boolean()` — `Boolean("false") === true`, which is the live AECI-691
 * defect on the public vendors endpoint. Here it would mean `?banned=false`
 * returning *banned* users, i.e. the exact opposite of the question asked, on a
 * moderation surface. Copy the enum form; never the coerce form.
 *
 * `role` IS an enum, unlike the `role` on a response row: a request filter should
 * 400 on a typo rather than confidently return an empty page, and a new CHECK
 * value would need a UI control here anyway.
 *
 * `search` matches `profiles.display_name` as an escaped substring
 * (`likeContains`, `apps/api/src/lib/sql-like.ts` — wildcards the operator types
 * are escaped, not honoured) and, **only when the term contains `@`**, also
 * resolves it as an EXACT email address through the GoTrue seam. See
 * {@link AdminUserEmailSearchSchema} for why that leg is exact-only and how the
 * response reports what it actually did.
 */
export const AdminUsersListQuerySchema = PageQuerySchema.extend({
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_USERS_MAX_PER_PAGE)
    .default(ADMIN_USERS_DEFAULT_PER_PAGE),
  sort: AdminUsersSortSchema,
  order: SortOrderSchema.optional(),
  search: z.string().optional(),
  role: z.enum(['reviewer', 'admin', 'vendor_admin']).optional(),
  banned: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  /**
   * `true` = holds a vendor seat (`role = 'vendor_admin' AND vendor_id IS NOT
   * NULL`), `false` = the exact complement. `?role=reviewer&has_seat=true` is
   * legally empty by construction, not a bug.
   */
  has_seat: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});
export type AdminUsersListQuery = z.infer<typeof AdminUsersListQuerySchema>;

/**
 * One row on the operator's user list.
 *
 * `role` is a plain string, never an enum: `profiles_role_check` is a DB CHECK
 * that can gain a value without this file, and a list that 500s on an
 * unrecognised role would be worse than one that shows it. (The QUERY filter is
 * an enum — see {@link AdminUsersListQuerySchema} — because the two directions
 * want opposite failure modes.)
 *
 * `banned_at` non-null ⇒ banned. The reason is detail-only: a ban reason can be
 * long and is written for the record, not for a table cell.
 */
export const AdminUserRowSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string().nullable(),
  role: z.string(),
  seat: AdminUserSeatSchema.nullable(),
  /** `null` when the seam is down (see `auth_available`) OR when no `auth.users`
   *  row exists — the enclosing flag is what tells those apart. */
  auth: AdminUserAuthAccountSchema.nullable(),
  banned_at: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type AdminUserRow = z.infer<typeof AdminUserRowSchema>;

/**
 * What the `@`-gated email leg of `search` actually did. `null` = no email search
 * was attempted (no `@` in the term, or no term at all).
 *
 *  - `matched`     — an auth account owns that address. The page may STILL be
 *                    empty: one Supabase project backs every environment
 *                    (ADR 0017), so the account can exist with no profile HERE.
 *  - `no_match`    — no auth account owns it.
 *  - `unavailable` — the seam is down, so the email half did not run and the
 *                    results are display-name matches only.
 *
 * **Email search is exact, never partial**, and the UI must say so. GoTrue's
 * `?filter=` is a case-SENSITIVE substring over email OR display name, and
 * `findAuthUserByEmail` narrows it to an exact lowercased equality client-side —
 * without which `jane@acme.com` would match `jane@acme.com.evil.io`. So
 * `?search=@acme.com` finds nothing by email.
 *
 * The `unavailable` case is why this field exists at all: a seam-down email
 * search that just returned an empty page would read as "no such user", which is
 * precisely the false-negative this whole surface was built to stop.
 */
export const AdminUserEmailSearchSchema = z.enum(['matched', 'no_match', 'unavailable']);
export type AdminUserEmailSearch = z.infer<typeof AdminUserEmailSearchSchema>;

export const AdminUsersListResponseSchema = paginatedResponseSchema(AdminUserRowSchema).extend({
  /** Whether the GoTrue enrichment ran at all. `false` ⇒ every `auth` is `null`
   *  because the seam was unreachable, NOT because the accounts don't exist. */
  auth_available: z.boolean(),
  email_search: AdminUserEmailSearchSchema.nullable(),
});
export type AdminUsersListResponse = z.infer<typeof AdminUsersListResponseSchema>;

// ─── GET /api/admin/users/:id ────────────────────────────────────────────────

/**
 * Reviews authored by this account, by `reviews.status`.
 *
 * ALL FOUR values the CHECK allows, including `archived` — shipping three would
 * give an operator numbers that silently fail to sum to the total they can see.
 */
export const AdminUserReviewCountsSchema = z.object({
  pending: z.number().int().min(0),
  approved: z.number().int().min(0),
  rejected: z.number().int().min(0),
  archived: z.number().int().min(0),
});
export type AdminUserReviewCounts = z.infer<typeof AdminUserReviewCountsSchema>;

export const AdminUserCountsSchema = z.object({
  reviews: AdminUserReviewCountsSchema,
  /** `vendor_seat_invites` this account SENT (`invited_by_id`), all time, any
   *  state — a spent or revoked invite still happened. */
  seat_invites_sent: z.number().int().min(0),
  /** `vendor_entitlements` rows this account granted (`granted_by`). That FK is
   *  `ON DELETE SET NULL`, so an erased grantor's rows are attributed to nobody:
   *  this undercounts by design rather than resurrecting a deleted person. */
  entitlements_granted: z.number().int().min(0),
  /**
   * `vendor_requests` whose `submitter_email` equals this account's GoTrue
   * address, compared case-insensitively (the column is `.trim()`-ed but NOT
   * lowercased on write, so an `=` match would silently miss `Jane@Acme.com`).
   *
   * **BEST EFFORT — there is no user FK.** `vendor_requests` records only
   * `submitter_email`; submission is anonymous and needs no account. So this is
   * an address match and nothing stronger: a shared mailbox attributes to the
   * wrong person, and a request filed from a second address is missed entirely.
   * **The UI must label it as such.**
   *
   * `null` = the address is unavailable (seam down), so the match could not be
   * attempted — never `0`, which would assert "this person filed none".
   */
  requests_by_email: z.number().int().min(0).nullable(),
});
export type AdminUserCounts = z.infer<typeof AdminUserCountsSchema>;

/**
 * A live pending invite addressed to this account, with the vendor it is for.
 *
 * `VendorSeatInviteSchema` + the vendor, via the `.extend()` reuse idiom
 * `AdminVendorSeatRowSchema` established: the vendor page's roster already knows
 * which vendor it is looking at, a person-scoped view does not. The `token` is
 * absent for the same reason it is absent there — it is the redeem handle.
 */
export const AdminUserPendingInviteSchema = VendorSeatInviteSchema.extend({
  vendor_id: z.string().uuid(),
  vendor_name: z.string().min(1),
});
export type AdminUserPendingInvite = z.infer<typeof AdminUserPendingInviteSchema>;

export const AdminUserDetailSchema = z.object({
  id: z.string().uuid(),
  display_name: z.string().nullable(),
  role: z.string(),
  /** Plain string for the same reason as `role` — `profiles_trust_tier_check` is
   *  a DB CHECK that can gain a value without this file. */
  trust_tier: z.string(),
  work_email_verified: z.boolean(),
  /** Meaningful only on a `vendor_admin` row and inert on any other. Shipped raw
   *  so a stale `true` left on a demoted profile is VISIBLE rather than papered
   *  over by the renderer. */
  seat_owner: z.boolean(),
  banned_at: z.string().nullable(),
  ban_reason: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),

  auth: AdminUserAuthAccountSchema.nullable(),
  auth_available: z.boolean(),

  seat: AdminUserSeatSchema.nullable(),

  /**
   * Live pending invites — neither accepted nor revoked, `expires_at` in the
   * future — addressed to this account's GoTrue address, ACROSS ALL VENDORS.
   *
   * `null` = the address could not be resolved (seam down), so the set is
   * unknown; `[]` = resolved, and there are none. Never conflate the two.
   */
  pending_invites: AdminUserPendingInviteSchema.array().nullable(),

  counts: AdminUserCountsSchema,
  /** `counts.reviews.rejected >= REPEAT_OFFENDER_THRESHOLD` — the same signal and
   *  threshold the moderation queue raises after a reject (AECI-218), computed
   *  server-side so the two surfaces cannot label the same person differently. */
  repeat_offender: z.boolean(),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;
