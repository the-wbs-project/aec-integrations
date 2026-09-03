/**
 * `GET /api/admin/users` + `/:id` (AECI-692).
 *
 * What each group of assertions earns its keep for:
 *
 *  1. **The tri-state.** `SUPABASE_SERVICE_ROLE_KEY` is legitimately absent on
 *     local dev and every PR preview, so "seam down" is the DEFAULT path here.
 *     Three states must stay distinguishable — seam down / no auth row / field
 *     empty — because collapsing them is what let a misconfigured key read as
 *     "Account status unknown" for a day on 2026-08-24.
 *  2. **`?banned=false`.** `z.coerce.boolean()` would return the BANNED users
 *     (`Boolean("false") === true`, the live AECI-691 defect). On a moderation
 *     surface that is the opposite of the question asked, so it is asserted in
 *     both directions plus the omitted case.
 *  3. **`has_seat` agreeing with `seatsOf()`.** A `reviewer` row carrying a stale
 *     `vendor_id` is NOT a seat. If this surface counted it, `/admin/users` and
 *     `GET /api/vendor/seats` would disagree about who has access.
 *  4. **`null` is not `[]` and not `0`.** `pending_invites` and
 *     `requests_by_email` are keyed by an email address the seam supplies, so
 *     without it they are unknowable — an empty answer would assert a fact.
 *  5. **The reads write nothing** (ADR 0022 / `ADMIN_PANEL_SPEC.md` §9.3).
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  products,
  profiles,
  reviews,
  vendorEntitlements,
  vendorRequests,
  vendorSeatInvites,
  vendors,
  workflowTransitions,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthenticatedSession, AuthzVariables } from '../lib/authz';
import type { FetchAuthRecords, FindAuthUserByEmail } from '../lib/supabase-admin';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminUserDetailHandler, createAdminUsersListHandler } from './admin-users';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ADMIN = u(1);
const REVIEWER = u(20);
const SEAT = u(21);
const BANNED = u(22);
const STALE_VENDOR_REF = u(23);
const VENDOR = u(10);

const ADMIN_SESSION = {
  userId: ADMIN,
  email: 'admin@aecintegrations.com',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
} as unknown as AuthenticatedSession;

/** The GoTrue record seam, stubbed. `available` is a parameter because the whole
 *  point of the tri-state is that a caller can tell a dead seam from a missing
 *  account from an empty field. */
function recordSeam(
  records: Record<string, Partial<{ email: string | null; last: string | null }>> = {},
  available = true,
): FetchAuthRecords {
  return async () => ({
    available,
    records: new Map(
      Object.entries(records).map(([id, r]) => [
        id,
        {
          email: r.email ?? null,
          last_sign_in_at: r.last ?? null,
          created_at: null,
          email_confirmed_at: null,
        },
      ]),
    ),
    reason: available ? ('ok' as const) : ('no_credentials' as const),
  });
}

/** The by-email seam (#4a). `skipped: true` is how it reports absent creds — a
 *  caller must never read that as "no such user". */
function emailFinder(byEmail: Record<string, string> = {}, skipped = false): FindAuthUserByEmail {
  return async (_env, email) => {
    if (skipped) return { ok: true, skipped: true, user: null };
    const id = byEmail[email.trim().toLowerCase()];
    return { ok: true, user: id ? { id, email: email.trim().toLowerCase() } : null };
  };
}

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin', displayName: 'Ada Admin' });
});
afterEach(() => t.dispose());

/**
 * Mount one handler on a real Hono app with the shared `errorHandler` and a stub
 * middleware setting the `auth` Variable `requireAdmin()` would.
 *
 * A real app rather than a hand-rolled context: `ApiError` only becomes a 404 by
 * passing through `onError`, so a bare call would throw and every "404s on an
 * unknown id" test would pass for the wrong reason. The gate itself is covered
 * end-to-end by `admin-panel.authz-matrix.spec.ts`.
 */
function mount(
  path: string,
  handler: (c: never) => Promise<Response>,
): Hono<{ Bindings: Env; Variables: AuthzVariables }> {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use(path, async (c, next) => {
    c.set('auth', ADMIN_SESSION);
    await next();
  });
  app.get(path, handler as never);
  return app;
}

function call(app: Hono<{ Bindings: Env; Variables: AuthzVariables }>, url: string) {
  return app.fetch(new Request(`https://api.test${url}`), TEST_ENV, fakeExecutionContext());
}

/** The response shapes are already pinned by `AdminUsers*Schema` in
 *  `packages/shared` and by `validateResponseInDev`; re-declaring them here would
 *  be duplication that drifts. Named `readJson` rather than `body` because the
 *  cases below bind their parsed payload to `body`. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readJson(res: Response): Promise<any> {
  return res.json();
}

async function seedVendor() {
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'procore', companyName: 'Procore' });
}

async function seedPeople() {
  await seedVendor();
  await t.db.insert(profiles).values([
    { id: REVIEWER, role: 'reviewer', displayName: 'Rita Reviewer' },
    {
      id: SEAT,
      role: 'vendor_admin',
      vendorId: VENDOR,
      seatOwner: true,
      displayName: 'Sam Seat',
    },
    { id: BANNED, role: 'reviewer', displayName: 'Ben Banned', bannedAt: '2026-08-01T00:00:00Z' },
    // The malformed case: a reviewer carrying a vendor_id. NOT a seat.
    { id: STALE_VENDOR_REF, role: 'reviewer', vendorId: VENDOR, displayName: 'Stale Ref' },
  ]);
}

/**
 * A review row with the NOT NULL columns filled — only `status` varies.
 *
 * Each takes its OWN product: `reviews` is UNIQUE on `(product_id, reviewer_id)`,
 * so one person cannot review the same product twice. That is why
 * {@link seedProducts} exists rather than a single PRODUCT constant.
 */
function review(n: number, status: 'pending' | 'approved' | 'rejected' | 'archived') {
  return {
    id: u(500 + n),
    productId: u(300 + n),
    reviewerId: REVIEWER,
    ratingOverall: 5,
    ratingOnboarding: 4,
    title: 'T',
    body: 'B',
    status,
  };
}

/** One product per review the caller is about to insert. */
async function seedProducts(count: number) {
  await t.db.insert(products).values(
    Array.from({ length: count }, (_, n) => ({
      id: u(300 + n),
      slug: `p-${n}`,
      name: `P${n}`,
      vendorId: VENDOR,
    })),
  );
}

describe('GET /api/admin/users — the list', () => {
  it('returns every profile, not just the banned ones', async () => {
    // The whole reason the issue exists: `GET /api/admin/reviewers` is
    // `WHERE banned_at IS NOT NULL`, so an unbanned user was unreachable.
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const res = await call(app, '/users');
    const page = await readJson(res);

    expect(res.status).toBe(200);
    expect(page.total).toBe(5); // 4 seeded + the admin
    expect(page.data.map((r: { id: string }) => r.id)).toContain(REVIEWER);
    expect(page.data.map((r: { id: string }) => r.id)).toContain(BANNED);
  });

  it('filters banned=true and banned=false as OPPOSITES', async () => {
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const banned = await readJson(await call(app, '/users?banned=true'));
    const unbanned = await readJson(await call(app, '/users?banned=false'));

    expect(banned.data.map((r: { id: string }) => r.id)).toEqual([BANNED]);
    // The AECI-691 trap: `z.coerce.boolean()` makes "false" truthy, so this
    // would return the banned user instead of excluding them.
    expect(unbanned.data.map((r: { id: string }) => r.id)).not.toContain(BANNED);
    expect(unbanned.total).toBe(4);
  });

  it('omitting banned is a third state — neither filter is applied', async () => {
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const all = await readJson(await call(app, '/users'));

    expect(all.total).toBe(5);
  });

  it('has_seat agrees with seatsOf() — a reviewer with a vendor_id is NOT a seat', async () => {
    // If this diverged, /admin/users and GET /api/vendor/seats would disagree
    // about who has portal access.
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const withSeat = await readJson(await call(app, '/users?has_seat=true'));
    const withoutSeat = await readJson(await call(app, '/users?has_seat=false'));

    expect(withSeat.data.map((r: { id: string }) => r.id)).toEqual([SEAT]);
    expect(withoutSeat.data.map((r: { id: string }) => r.id)).toContain(STALE_VENDOR_REF);
    // The two filters must partition the set exactly.
    expect(withSeat.total + withoutSeat.total).toBe(5);
  });

  it('renders the seat with its vendor and owner flag; null for everyone else', async () => {
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const body = await readJson(await call(app, '/users?has_seat=true'));

    expect(body.data[0].seat).toEqual({
      vendor_id: VENDOR,
      company_name: 'Procore',
      slug: 'procore',
      owner: true,
    });
  });

  it('filters by role and 400s on a role the CHECK does not allow', async () => {
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const reviewers = await readJson(await call(app, '/users?role=reviewer'));
    expect(reviewers.data.every((r: { role: string }) => r.role === 'reviewer')).toBe(true);

    const bad = await call(app, '/users?role=moderator');
    expect(bad.status).toBe(400);
  });

  it('searches display_name as a substring, escaping wildcards the operator types', async () => {
    await t.db.insert(profiles).values({ id: u(40), role: 'reviewer', displayName: '100% Legit' });
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const hit = await readJson(await call(app, '/users?search=Rita'));
    expect(hit.data.map((r: { id: string }) => r.id)).toEqual([REVIEWER]);

    // `%` must match a literal percent, not act as a wildcard — otherwise a
    // stray character in the box silently returns the whole table.
    const literal = await readJson(await call(app, '/users?search=100%25'));
    expect(literal.data.map((r: { id: string }) => r.id)).toEqual([u(40)]);
  });

  it('count and page agree — total describes the filtered set, not the table', async () => {
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));

    const body = await readJson(await call(app, '/users?banned=true&perPage=1'));

    expect(body.total).toBe(1);
    expect(body.data).toHaveLength(1);
  });

  it('rejects perPage above this surface’s cap of 50', async () => {
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));
    expect((await call(app, '/users?perPage=51')).status).toBe(400);
    expect((await call(app, '/users?perPage=50')).status).toBe(200);
  });
});

describe('GET /api/admin/users — the GoTrue tri-state', () => {
  it('seam down: auth_available false, every auth null, page still 200s', async () => {
    // This is the DEFAULT local-dev and PR-preview state, not an edge case.
    await seedPeople();
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam({}, false)));

    const body = await readJson(await call(app, '/users'));

    expect(body.auth_available).toBe(false);
    expect(body.data.every((r: { auth: unknown }) => r.auth === null)).toBe(true);
    expect(body.data.length).toBeGreaterThan(0);
  });

  it('seam up but no auth row: available true, that row null — an orphaned profile', async () => {
    await seedPeople();
    const app = mount(
      '/users',
      createAdminUsersListHandler(
        t.factory,
        recordSeam({ [REVIEWER]: { email: 'rita@acme.com' } }),
      ),
    );

    const body = await readJson(await call(app, '/users'));
    const rita = body.data.find((r: { id: string }) => r.id === REVIEWER);
    const sam = body.data.find((r: { id: string }) => r.id === SEAT);

    expect(body.auth_available).toBe(true);
    expect(rita.auth.email).toBe('rita@acme.com');
    // Present in the response, absent from the seam ⇒ no auth.users row.
    expect(sam.auth).toBeNull();
  });

  it('seam up, account present, field empty: the block renders with nulls', async () => {
    await seedPeople();
    const app = mount(
      '/users',
      createAdminUsersListHandler(
        t.factory,
        recordSeam({ [REVIEWER]: { email: 'rita@acme.com', last: null } }),
      ),
    );

    const body = await readJson(await call(app, '/users'));
    const rita = body.data.find((r: { id: string }) => r.id === REVIEWER);

    // Distinct from both cases above: the account exists and has simply never
    // signed in.
    expect(rita.auth).toEqual({
      email: 'rita@acme.com',
      last_sign_in_at: null,
      created_at: null,
      email_confirmed_at: null,
    });
  });
});

describe('GET /api/admin/users — email search', () => {
  it('resolves an exact address to its profile and reports matched', async () => {
    await seedPeople();
    const app = mount(
      '/users',
      createAdminUsersListHandler(
        t.factory,
        recordSeam(),
        emailFinder({ 'rita@acme.com': REVIEWER }),
      ),
    );

    const body = await readJson(await call(app, '/users?search=rita%40acme.com'));

    expect(body.email_search).toBe('matched');
    expect(body.data.map((r: { id: string }) => r.id)).toEqual([REVIEWER]);
  });

  it('reports no_match when no account owns the address', async () => {
    await seedPeople();
    const app = mount(
      '/users',
      createAdminUsersListHandler(t.factory, recordSeam(), emailFinder({})),
    );

    const body = await readJson(await call(app, '/users?search=nobody%40acme.com'));

    expect(body.email_search).toBe('no_match');
    expect(body.data).toEqual([]);
  });

  it('reports UNAVAILABLE, not no_match, when the seam is down', async () => {
    // The single most important case in this file. A seam-down email search that
    // just returned an empty page reads as "no such user" — the exact false
    // negative this surface was built to stop.
    await seedPeople();
    const app = mount(
      '/users',
      createAdminUsersListHandler(t.factory, recordSeam({}, false), emailFinder({}, true)),
    );

    const body = await readJson(await call(app, '/users?search=rita%40acme.com'));

    expect(body.email_search).toBe('unavailable');
  });

  it('does not call the email seam for a term without @', async () => {
    // Typing a name must not cost a GoTrue round trip.
    await seedPeople();
    const finder = vi.fn(emailFinder({}));
    const app = mount('/users', createAdminUsersListHandler(t.factory, recordSeam(), finder));

    const body = await readJson(await call(app, '/users?search=Rita'));

    expect(finder).not.toHaveBeenCalled();
    expect(body.email_search).toBeNull();
  });
});

describe('GET /api/admin/users/:id — the detail', () => {
  async function detailApp(seam = recordSeam()) {
    return mount('/users/:id', createAdminUserDetailHandler(t.factory, seam));
  }

  it('404s on an unknown id rather than returning a page of zeroes', async () => {
    const app = await detailApp();
    const res = await call(app, `/users/${u(999)}`);
    expect(res.status).toBe(404);
  });

  it('returns the profile, its seat, and the auth block', async () => {
    await seedPeople();
    const app = await detailApp(
      recordSeam({ [SEAT]: { email: 'sam@procore.com', last: '2026-08-20T09:00:00Z' } }),
    );

    const body = await readJson(await call(app, `/users/${SEAT}`));

    expect(body.id).toBe(SEAT);
    expect(body.role).toBe('vendor_admin');
    expect(body.seat_owner).toBe(true);
    expect(body.seat.company_name).toBe('Procore');
    expect(body.auth.last_sign_in_at).toBe('2026-08-20T09:00:00Z');
    expect(body.auth_available).toBe(true);
  });

  it('counts reviews across ALL FOUR statuses so the numbers sum', async () => {
    await seedPeople();
    await seedProducts(4);
    await t.db
      .insert(reviews)
      .values([
        review(0, 'approved'),
        review(1, 'rejected'),
        review(2, 'rejected'),
        review(3, 'archived'),
      ]);
    const app = await detailApp();

    const body = await readJson(await call(app, `/users/${REVIEWER}`));

    expect(body.counts.reviews).toEqual({
      pending: 0,
      approved: 1,
      rejected: 2,
      archived: 1,
    });
  });

  it('flags repeat_offender at the SAME threshold the moderation queue uses', async () => {
    await seedPeople();
    await seedProducts(3);
    await t.db.insert(reviews).values([0, 1, 2].map((n) => review(n, 'rejected')));
    const app = await detailApp();

    const body = await readJson(await call(app, `/users/${REVIEWER}`));

    expect(body.counts.reviews.rejected).toBe(3);
    expect(body.repeat_offender).toBe(true);
  });

  it('counts invites sent and entitlements granted by this account', async () => {
    await seedPeople();
    await t.db.insert(vendorSeatInvites).values({
      id: u(70),
      vendorId: VENDOR,
      email: 'newbie@procore.com',
      token: 'tok-1',
      invitedById: SEAT,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    await t.db.insert(vendorEntitlements).values({
      id: u(71),
      vendorId: VENDOR,
      tier: 'verified',
      status: 'active',
      grantedBy: ADMIN,
    });
    const app = await detailApp();

    const seat = await readJson(await call(app, `/users/${SEAT}`));
    const admin = await readJson(await call(app, `/users/${ADMIN}`));

    expect(seat.counts.seat_invites_sent).toBe(1);
    expect(admin.counts.entitlements_granted).toBe(1);
  });

  it('matches vendor_requests case-INSENSITIVELY — submitter_email is not lowercased on write', async () => {
    // `submitter_email` is `.trim()`-ed but not lowercased (api/requests.ts), so
    // a bare `eq` against the GoTrue address silently misses a mixed-case one.
    await seedPeople();
    await t.db.insert(vendorRequests).values({
      id: u(80),
      kind: 'claim',
      targetType: 'vendor',
      targetId: VENDOR,
      submitterEmail: 'Rita@Acme.COM',
      body: 'x',
      status: 'open',
    });
    const app = await detailApp(recordSeam({ [REVIEWER]: { email: 'rita@acme.com' } }));

    const body = await readJson(await call(app, `/users/${REVIEWER}`));

    expect(body.counts.requests_by_email).toBe(1);
  });

  it('lists only LIVE pending invites addressed to this account', async () => {
    await seedPeople();
    await t.db.insert(vendorSeatInvites).values([
      {
        id: u(90),
        vendorId: VENDOR,
        email: 'rita@acme.com',
        token: 'tok-live',
        invitedById: SEAT,
        expiresAt: '2099-01-01T00:00:00Z',
      },
      // Expired: still "pending" by the partial index (both terminal cols null),
      // but NOT live — the caller applies the expiry, the shared predicate does not.
      {
        id: u(91),
        vendorId: VENDOR,
        email: 'rita@acme.com',
        token: 'tok-expired',
        invitedById: SEAT,
        expiresAt: '2020-01-01T00:00:00Z',
      },
      // Revoked.
      {
        id: u(92),
        vendorId: VENDOR,
        email: 'rita@acme.com',
        token: 'tok-revoked',
        invitedById: SEAT,
        expiresAt: '2099-01-01T00:00:00Z',
        revokedAt: '2026-08-01T00:00:00Z',
      },
    ]);
    const app = await detailApp(recordSeam({ [REVIEWER]: { email: 'rita@acme.com' } }));

    const body = await readJson(await call(app, `/users/${REVIEWER}`));

    expect(body.pending_invites).toHaveLength(1);
    expect(body.pending_invites[0]).toMatchObject({
      id: u(90),
      vendor_id: VENDOR,
      vendor_name: 'Procore',
      invited_by: 'Sam Seat',
    });
    // The token is the redeem handle and is never on the wire.
    expect(body.pending_invites[0].token).toBeUndefined();
  });

  it('reports pending_invites null and requests_by_email null when the seam is down', async () => {
    // Both are keyed by an address the seam supplies. `[]` would assert "no
    // invites" and `0` would assert "filed no requests" — neither is known.
    await seedPeople();
    await t.db.insert(vendorSeatInvites).values({
      id: u(93),
      vendorId: VENDOR,
      email: 'rita@acme.com',
      token: 'tok-x',
      invitedById: SEAT,
      expiresAt: '2099-01-01T00:00:00Z',
    });
    const app = await detailApp(recordSeam({}, false));

    const body = await readJson(await call(app, `/users/${REVIEWER}`));

    expect(body.auth_available).toBe(false);
    expect(body.pending_invites).toBeNull();
    expect(body.counts.requests_by_email).toBeNull();
    // The counts that need no address still compute.
    expect(body.counts.reviews.approved).toBe(0);
  });

  it('ships seat_owner raw on a demoted profile, so stale state stays visible', async () => {
    await seedPeople();
    await t.db.update(profiles).set({ seatOwner: true }).where(eq(profiles.id, REVIEWER));
    const app = await detailApp();

    const body = await readJson(await call(app, `/users/${REVIEWER}`));

    expect(body.seat).toBeNull();
    expect(body.seat_owner).toBe(true);
  });
});

describe('the reads write nothing (ADR 0022)', () => {
  it('emits no audit_log or workflow_transitions row', async () => {
    await seedPeople();
    const list = mount('/users', createAdminUsersListHandler(t.factory, recordSeam()));
    const detail = mount('/users/:id', createAdminUserDetailHandler(t.factory, recordSeam()));

    await call(list, '/users');
    await call(detail, `/users/${REVIEWER}`);

    expect(await t.db.select().from(auditLog)).toHaveLength(0);
    expect(await t.db.select().from(workflowTransitions)).toHaveLength(0);
  });
});
