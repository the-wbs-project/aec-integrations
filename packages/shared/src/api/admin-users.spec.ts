import { describe, expect, it } from 'vitest';

import {
  ADMIN_USERS_DEFAULT_PER_PAGE,
  ADMIN_USERS_MAX_PER_PAGE,
  AdminUserDetailSchema,
  AdminUserRowSchema,
  AdminUsersListQuerySchema,
  AdminUsersListResponseSchema,
} from './admin-users';
import { REPEAT_OFFENDER_THRESHOLD } from './reviews';

/**
 * The AECI-692 wire contracts. Most of these cases guard decisions that are easy
 * to "simplify" back into defects:
 *
 *  - the boolean filters are ENUM-plus-transform, never `z.coerce.boolean()`;
 *  - every auth-derived field is required-nullable (R10), so a missed
 *    construction site fails `validateResponseInDev` rather than shipping
 *    `undefined`;
 *  - `null` and `[]` mean different things on `pending_invites`, and
 *    `requests_by_email` has a `null` that is NOT `0`.
 */

const USER_ID = '00000000-0000-4000-8000-000000000700';
const VENDOR_ID = '00000000-0000-4000-8000-000000000061';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    display_name: 'Jane Doe',
    role: 'reviewer',
    seat: null,
    auth: null,
    banned_at: null,
    created_at: '2026-01-05T12:00:00.000Z',
    updated_at: '2026-01-05T12:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  return {
    ...row(),
    trust_tier: 'standard',
    work_email_verified: false,
    seat_owner: false,
    ban_reason: null,
    auth_available: false,
    pending_invites: null,
    counts: {
      reviews: { pending: 0, approved: 0, rejected: 0, archived: 0 },
      seat_invites_sent: 0,
      entitlements_granted: 0,
      requests_by_email: null,
    },
    repeat_offender: false,
    ...overrides,
  };
}

describe('AdminUsersListQuerySchema', () => {
  it('defaults perPage to 24 — four exact GoTrue waves, not the shared 100', () => {
    // Every row costs one seam round trip, run in waves of
    // WORKER_CONNECTION_LIMIT (6). 24 is 4 waves; 25 would be 5 for one extra
    // row. The shared default happens to agree, but this surface pins it
    // explicitly because the cap below deliberately does not.
    const parsed = AdminUsersListQuerySchema.parse({});
    expect(parsed.perPage).toBe(ADMIN_USERS_DEFAULT_PER_PAGE);
    expect(parsed.perPage).toBe(24);
    expect(parsed.page).toBe(1);
    expect(parsed.sort).toBe('created');
  });

  it('caps perPage at 50, below the shared 100', () => {
    expect(AdminUsersListQuerySchema.parse({ perPage: '50' }).perPage).toBe(50);
    expect(AdminUsersListQuerySchema.safeParse({ perPage: '51' }).success).toBe(false);
    expect(ADMIN_USERS_MAX_PER_PAGE).toBe(50);
  });

  it("parses banned='false' as FALSE, not true", () => {
    // `z.coerce.boolean()` yields `true` here because `Boolean("false") === true`
    // — the live AECI-691 defect. On a moderation surface that would mean
    // "show me unbanned users" returning the banned ones.
    expect(AdminUsersListQuerySchema.parse({ banned: 'false' }).banned).toBe(false);
    expect(AdminUsersListQuerySchema.parse({ banned: 'true' }).banned).toBe(true);
  });

  it("parses has_seat='false' as FALSE, not true", () => {
    expect(AdminUsersListQuerySchema.parse({ has_seat: 'false' }).has_seat).toBe(false);
  });

  it('leaves an omitted boolean filter undefined — absent is not false', () => {
    // Three states: filter for banned, filter for not-banned, do not filter.
    // Collapsing the third into `false` would silently hide every banned user.
    const parsed = AdminUsersListQuerySchema.parse({});
    expect(parsed.banned).toBeUndefined();
    expect(parsed.has_seat).toBeUndefined();
  });

  it('400s on an unknown role rather than returning a confidently empty page', () => {
    expect(AdminUsersListQuerySchema.safeParse({ role: 'reviewer' }).success).toBe(true);
    expect(AdminUsersListQuerySchema.safeParse({ role: 'vendor_admin' }).success).toBe(true);
    expect(AdminUsersListQuerySchema.safeParse({ role: 'moderator' }).success).toBe(false);
  });

  it('rejects a sort key that is not a D1 column', () => {
    // `last_sign_in_at` lives in GoTrue and is fetched AFTER the page is
    // selected, so sorting by it would reorder only the current page.
    expect(AdminUsersListQuerySchema.safeParse({ sort: 'updated' }).success).toBe(true);
    expect(AdminUsersListQuerySchema.safeParse({ sort: 'last_sign_in_at' }).success).toBe(false);
  });
});

describe('AdminUserRowSchema', () => {
  it('accepts an unrecognised role rather than 500ing the list', () => {
    // `profiles_role_check` can gain a value without this file. The request
    // filter is an enum; the response is not, on purpose.
    expect(AdminUserRowSchema.safeParse(row({ role: 'auditor' })).success).toBe(true);
  });

  it('requires every nullable field to be PRESENT (R10)', () => {
    const { display_name: _dropped, ...missing } = row();
    expect(AdminUserRowSchema.safeParse(missing).success).toBe(false);
    expect(AdminUserRowSchema.safeParse(row({ display_name: null })).success).toBe(true);
  });

  it('accepts a seat only in its single-valued form', () => {
    const seat = { vendor_id: VENDOR_ID, company_name: 'Procore', slug: 'procore', owner: true };
    expect(AdminUserRowSchema.safeParse(row({ seat })).success).toBe(true);
    // A user holds at most ONE seat by construction (AUTH_AND_RLS.md §3.2), so
    // an array here would invent a relation the schema cannot express.
    expect(AdminUserRowSchema.safeParse(row({ seat: [seat] })).success).toBe(false);
  });
});

describe('AdminUsersListResponseSchema', () => {
  it('carries auth_available so a null auth block is attributable', () => {
    const parsed = AdminUsersListResponseSchema.parse({
      data: [row()],
      page: 1,
      perPage: 24,
      total: 1,
      auth_available: false,
      email_search: null,
    });
    expect(parsed.auth_available).toBe(false);
    expect(parsed.email_search).toBeNull();
  });

  it('requires auth_available — it is the flag that disambiguates a null auth', () => {
    expect(
      AdminUsersListResponseSchema.safeParse({
        data: [],
        page: 1,
        perPage: 24,
        total: 0,
        email_search: null,
      }).success,
    ).toBe(false);
  });

  it('reports a seam-down email search as unavailable, distinct from no_match', () => {
    // The whole point: an empty page from a seam-down email search must not read
    // as "no such user" — that is the false negative this surface exists to stop.
    for (const state of ['matched', 'no_match', 'unavailable'] as const) {
      const parsed = AdminUsersListResponseSchema.parse({
        data: [],
        page: 1,
        perPage: 24,
        total: 0,
        auth_available: state !== 'unavailable',
        email_search: state,
      });
      expect(parsed.email_search).toBe(state);
    }
  });
});

describe('AdminUserDetailSchema', () => {
  it('distinguishes pending_invites null (unresolvable) from [] (none)', () => {
    expect(
      AdminUserDetailSchema.parse(detail({ pending_invites: null })).pending_invites,
    ).toBeNull();
    expect(AdminUserDetailSchema.parse(detail({ pending_invites: [] })).pending_invites).toEqual(
      [],
    );
  });

  it('allows requests_by_email to be null — uncomputable, not zero', () => {
    // `null` means the address could not be resolved, so the match was never
    // attempted. `0` would assert "this person filed none", which is a different
    // and possibly false claim.
    expect(AdminUserDetailSchema.parse(detail()).counts.requests_by_email).toBeNull();
    expect(
      AdminUserDetailSchema.parse(detail({ counts: { ...detail().counts, requests_by_email: 0 } }))
        .counts.requests_by_email,
    ).toBe(0);
  });

  it('requires all four review statuses so the numbers sum', () => {
    const counts = detail().counts;
    const { archived: _dropped, ...threeOnly } = counts.reviews;
    expect(
      AdminUserDetailSchema.safeParse(detail({ counts: { ...counts, reviews: threeOnly } }))
        .success,
    ).toBe(false);
  });

  it('carries repeat_offender server-side so two surfaces cannot disagree', () => {
    // The moderation queue raises its ban prompt at the same threshold. Both read
    // it from one shared constant.
    expect(REPEAT_OFFENDER_THRESHOLD).toBe(3);
    const flagged = detail({
      counts: {
        ...detail().counts,
        reviews: { pending: 0, approved: 1, rejected: REPEAT_OFFENDER_THRESHOLD, archived: 0 },
      },
      repeat_offender: true,
    });
    expect(AdminUserDetailSchema.parse(flagged).repeat_offender).toBe(true);
  });

  it('ships seat_owner raw, so a stale flag on a demoted profile stays visible', () => {
    const stale = detail({ role: 'reviewer', seat: null, seat_owner: true });
    expect(AdminUserDetailSchema.parse(stale).seat_owner).toBe(true);
  });
});
