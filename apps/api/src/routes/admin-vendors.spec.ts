/**
 * The admin vendor surface (AECI-652 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §5.6),
 * against the in-memory D1 harness.
 *
 * Four groups of assertions earn their keep here, and three of them are
 * regression tests for defects the design review found rather than happy-path
 * coverage:
 *
 *  1. **`?verified=false` returns UNVERIFIED vendors.** The public
 *     `VendorsListQuerySchema` uses `z.coerce.boolean()`, and
 *     `Boolean("false") === true`, so copying it would have shipped a filter that
 *     returns the exact opposite of what it says (AECI-691). This is the single
 *     most valuable assertion in the file.
 *  2. **A literal `%` in `search` matches literally.** That is the entire reason
 *     `likeContains` escapes and emits `ESCAPE '\'`.
 *  3. **The audit viewer reaches rows that `entity_id = <vendor>` cannot.** A
 *     rejected claim (whose audit metadata carries no `vendor_id` at all) and a
 *     revoked seat (whose `profiles.vendor_id` is null by the time anyone reads
 *     it) are both invisible to the obvious query. Each has its own test; if one
 *     starts failing, that scope's disjunct has been dropped.
 *  4. **The revoke never touches `vendors`.** Asserted by reading the row back:
 *     clearing an entitlement and revoking a seat are orthogonal (§5.2), and an
 *     admin who conflates them creates an incident.
 */

import { RATING_VISIBILITY_MIN_REVIEWS } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  auditLog,
  integrations,
  productVendors,
  products,
  profiles,
  vendorEntitlements,
  vendorRequests,
  vendorSeatInvites,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthenticatedSession, AuthzVariables } from '../lib/authz';
import { runDataQualityChecks } from '../lib/data-quality';
import type { resolveClaimantIdentity } from '../lib/claimant-identity';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminRevokeSeatHandler,
  createProvisionSeatHandler,
  createAdminVendorAuditHandler,
  createAdminVendorDetailHandler,
  createAdminVendorProductsHandler,
  createAdminVendorsListHandler,
  type FetchAuthEmails,
} from './admin-vendors';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ADMIN = u(1);
const VENDOR = u(10);
const OTHER_VENDOR = u(11);
const SEAT_A = u(20);
const SEAT_B = u(21);
const PRODUCT = u(30);

const ADMIN_SESSION = {
  userId: ADMIN,
  email: 'admin@aecintegrations.com',
  role: 'admin',
  vendorId: null,
  entitlementTier: 'unclaimed',
  entitlement: null,
} as unknown as AuthenticatedSession;

/** The GoTrue seam, stubbed. `available` is a parameter because the whole point
 *  of the tri-state is that a caller can tell a dead seam from a missing address. */
function emailSeam(emails: Record<string, string> = {}, available = true): FetchAuthEmails {
  return async () => ({
    available,
    emails: new Map(Object.entries(emails)),
    reason: available ? ('ok' as const) : ('no_credentials' as const),
  });
}

let t: TestDb;

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

/**
 * Mount one handler on a real Hono app with the shared `errorHandler` and a stub
 * middleware that sets the `auth` Variable `requireAdmin()` would.
 *
 * A real app rather than a hand-rolled context object because `ApiError` only
 * becomes a 404 by passing through `onError` — a bare call would just throw, and
 * every "404s on an unknown id" test would pass for the wrong reason. The gate
 * itself is covered end-to-end by `admin-panel.authz-matrix.spec.ts`.
 */
function mount(
  method: 'get' | 'delete' | 'post',
  path: string,
  handler: (c: never) => Promise<Response>,
): Hono<{ Bindings: Env; Variables: AuthzVariables }> {
  const app = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  app.onError(errorHandler());
  app.use(path, async (c, next) => {
    c.set('auth', ADMIN_SESSION);
    await next();
  });
  app[method](path, handler as never);
  return app;
}

async function send(
  app: Hono<{ Bindings: Env; Variables: AuthzVariables }>,
  url: string,
  method = 'GET',
  payload?: unknown,
): Promise<Response> {
  const init: RequestInit =
    payload === undefined
      ? { method }
      : {
          method,
          body: JSON.stringify(payload),
          headers: { 'content-type': 'application/json' },
        };
  return app.request(url, init, TEST_ENV, fakeExecutionContext());
}

/** The response body, loosely typed. These specs assert on shapes the wire schema
 *  already pins down (`admin-vendors.spec.ts` in `packages/shared`), so
 *  re-declaring them here would be duplication that drifts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function body(res: Response): Promise<any> {
  return res.json();
}

async function seedVendor(
  id: string,
  overrides: Partial<typeof vendors.$inferInsert> = {},
): Promise<void> {
  await t.db.insert(vendors).values({
    id,
    slug: `vendor-${id.slice(-4)}`,
    companyName: `Vendor ${id.slice(-4)}`,
    ...overrides,
  });
}

// ─── GET /api/admin/vendors ──────────────────────────────────────────────────

describe('GET /api/admin/vendors', () => {
  beforeEach(async () => {
    await seedVendor(VENDOR, { slug: 'acme-corp', companyName: 'Acme Corp', verified: true });
    await seedVendor(OTHER_VENDOR, {
      slug: 'beta-100%-tools',
      companyName: 'Beta Tools',
      verified: false,
    });
    await t.db.insert(vendorEntitlements).values({
      id: u(40),
      vendorId: VENDOR,
      tier: 'verified',
      status: 'active',
      periodEnd: '2027-01-01',
    });
  });

  it('returns the paginated envelope with the entitlement joined on', async () => {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors',
    );
    expect(res.status).toBe(200);
    const b = await body(res);

    expect(b.total).toBe(2);
    expect(b.page).toBe(1);
    const acme = b.data.find((r: { slug: string }) => r.slug === 'acme-corp');
    expect(acme).toMatchObject({
      company_name: 'Acme Corp',
      verified: true,
      tier: 'verified',
      status: 'active',
      period_end: '2027-01-01',
    });
  });

  it('reports tier and status as null for a vendor with no entitlement row', async () => {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors',
    );
    const b = await body(res);
    const beta = b.data.find((r: { slug: string }) => r.slug === 'beta-100%-tools');
    // `null`, not a fabricated 'unclaimed' — the absence of a row is a distinct
    // state from a cleared one, and the operator has to be able to see which.
    expect(beta.tier).toBeNull();
    expect(beta.status).toBeNull();
  });

  it('does not multiply a vendor that has an entitlement (the join is 1:1)', async () => {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors',
    );
    const b = await body(res);
    expect(b.data.filter((r: { id: string }) => r.id === VENDOR)).toHaveLength(1);
  });

  it('searches company name and slug', async () => {
    const byName = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?search=Acme',
    );
    expect((await body(byName)).data.map((r: { slug: string }) => r.slug)).toEqual(['acme-corp']);

    const bySlug = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?search=beta-100',
    );
    expect((await body(bySlug)).data.map((r: { slug: string }) => r.slug)).toEqual([
      'beta-100%-tools',
    ]);
  });

  it('treats a literal % in the search as a literal, not a wildcard', async () => {
    // Without `escapeLike` + `ESCAPE '\'` this matches BOTH vendors, because a
    // bare `%` in a LIKE pattern matches anything. That silent behaviour is why
    // the escaping exists.
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      `/api/admin/vendors?search=${encodeURIComponent('%')}`,
    );
    const b = await body(res);
    expect(b.data.map((r: { slug: string }) => r.slug)).toEqual(['beta-100%-tools']);
  });

  it('?verified=false returns the UNVERIFIED vendors (AECI-691 regression)', async () => {
    // `z.coerce.boolean()` — which the public list schema still uses — coerces
    // the string "false" to `true`, so this exact query would return Acme.
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?verified=false',
    );
    const b = await body(res);
    expect(b.data.map((r: { slug: string }) => r.slug)).toEqual(['beta-100%-tools']);
  });

  it('?verified=true returns only the verified vendors', async () => {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?verified=true',
    );
    const b = await body(res);
    expect(b.data.map((r: { slug: string }) => r.slug)).toEqual(['acme-corp']);
  });

  it('reports `total` for the FILTER, not for the page', async () => {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?perPage=1',
    );
    const b = await body(res);
    expect(b.data).toHaveLength(1);
    expect(b.total).toBe(2);
  });

  it('counts owned products per row, and ships no integration count at all', async () => {
    await t.db.insert(products).values([
      { id: PRODUCT, slug: 'acme-thing', name: 'Acme Thing' },
      { id: u(31), slug: 'beta-thing', name: 'Beta Thing' },
    ]);
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });
    await t.db.insert(integrations).values({
      id: u(50),
      name: 'Acme ↔ Beta',
      sourceProductId: PRODUCT,
      targetProductId: u(31),
      builtByVendorId: VENDOR,
    });

    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors',
    );
    const b = await body(res);
    const acme = b.data.find((r: { id: string }) => r.id === VENDOR);
    expect(acme.product_count).toBe(1);
    // The list stopped rendering an integration column, so the correlated
    // subquery came off the SELECT with it. The count still exists on
    // `/api/admin/vendors/:id`, where §13.5's union rule is asserted.
    expect(acme).not.toHaveProperty('integration_count');
  });

  // ── Sorting ────────────────────────────────────────────────────────────────
  //
  // Every column the operator's table renders is sortable, which is only true
  // because the API can order by all of them. These pin the three cases that are
  // not a bare column: the SELECT alias, the status rank, and NULLs-last on the
  // term. In this fixture `acme-corp` is verified with an ACTIVE entitlement
  // ending 2027-01-01, and `beta-100%-tools` is unverified with NO entitlement
  // row at all — so each key below has a defensible expected order.
  async function slugsSortedBy(sort: string, order?: 'asc' | 'desc'): Promise<string[]> {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      `/api/admin/vendors?sort=${sort}${order ? `&order=${order}` : ''}`,
    );
    expect(res.status).toBe(200);
    return (await body(res)).data.map((r: { slug: string }) => r.slug);
  }

  it('defaults to company name ascending', async () => {
    expect(await slugsSortedBy('name')).toEqual(['acme-corp', 'beta-100%-tools']);
  });

  it('sorts by slug', async () => {
    expect(await slugsSortedBy('slug')).toEqual(['acme-corp', 'beta-100%-tools']);
  });

  // Each of the next three seeds a vendor that sorts FIRST alphabetically and
  // LAST by the key under test, so the assertion cannot pass on the tiebreaker.
  async function seedAardvark(): Promise<void> {
    await seedVendor(u(12), {
      slug: 'aardvark',
      companyName: 'Aardvark',
      verified: false,
    });
  }

  it('sorts the verified vendors first', async () => {
    await seedAardvark();
    expect(await slugsSortedBy('verified')).toEqual(['acme-corp', 'aardvark', 'beta-100%-tools']);
  });

  it('ranks the entitlement by urgency, putting "no row at all" last', async () => {
    await seedAardvark();
    // Alphabetically `active` would sort before `revoked`, which is an accident;
    // the CASE makes the order operational, and a vendor with NO entitlement row
    // — the majority case — sorts behind every vendor that has one.
    await t.db.insert(vendorEntitlements).values({
      id: u(41),
      vendorId: OTHER_VENDOR,
      tier: 'verified',
      status: 'revoked',
    });
    expect(await slugsSortedBy('entitlement')).toEqual([
      'acme-corp',
      'beta-100%-tools',
      'aardvark',
    ]);
  });

  it('sorts by the product-count SELECT alias, most first', async () => {
    await t.db.insert(products).values({ id: PRODUCT, slug: 'beta-thing', name: 'Beta Thing' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: OTHER_VENDOR });
    // Beta owns one product, Acme none — so this INVERTS the alphabetical order,
    // which is what proves the ORDER BY resolved the alias instead of being
    // silently dropped.
    expect(await slugsSortedBy('products')).toEqual(['beta-100%-tools', 'acme-corp']);
  });

  it('sorts by term end soonest-first, with no-term-on-record LAST', async () => {
    await seedAardvark();
    // SQLite orders NULLs FIRST under ASC, which would bury every real renewal
    // date under the vendors that have no entitlement row — so `aardvark` (no
    // row) and `beta-100%-tools` (no row) must both trail the dated term, even
    // though the first of them sorts ahead of everything alphabetically.
    expect(await slugsSortedBy('term')).toEqual(['acme-corp', 'aardvark', 'beta-100%-tools']);
  });

  // ── Direction ──────────────────────────────────────────────────────────────
  //
  // The surface originally had no `order` parameter: direction was fixed per key
  // and clicking an active header was a no-op. These pin the replacement.

  it('reverses when order is supplied', async () => {
    expect(await slugsSortedBy('name', 'desc')).toEqual(['beta-100%-tools', 'acme-corp']);
  });

  it('orders identically with and without an explicit natural direction', async () => {
    // The compatibility guarantee: every link and bookmark written before
    // `order` existed must keep ordering exactly as it did.
    expect(await slugsSortedBy('name')).toEqual(await slugsSortedBy('name', 'asc'));
    expect(await slugsSortedBy('updated')).toEqual(await slugsSortedBy('updated', 'desc'));
  });

  it('reverses a naturally-DESCENDING key too', async () => {
    await seedAardvark();
    // `verified` naturally puts verified first; ascending must genuinely invert
    // it rather than no-op, which is what a direction-blind resolver would do.
    expect(await slugsSortedBy('verified', 'asc')).toEqual([
      'aardvark',
      'beta-100%-tools',
      'acme-corp',
    ]);
  });

  it('keeps no-term-on-record LAST even when the term sort is reversed', async () => {
    await seedAardvark();
    // The one term that deliberately does NOT flip. Reversing the NULL guard too
    // would float every perpetual/no-row vendor to the top on the second click —
    // the exact burial that guard exists to prevent.
    expect(await slugsSortedBy('term', 'desc')).toEqual([
      'acme-corp',
      'aardvark',
      'beta-100%-tools',
    ]);
  });

  it('rejects a direction the schema does not know', async () => {
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?sort=name&order=sideways',
    );
    expect(res.status).toBe(400);
  });

  it('rejects a sort key the schema does not know rather than falling back', async () => {
    // `created` is a PUBLIC key. Accepting it here would order by a column the
    // row does not carry, so no header could state its direction honestly.
    const res = await send(
      mount('get', '/api/admin/vendors', createAdminVendorsListHandler(t.factory)),
      '/api/admin/vendors?sort=created',
    );
    expect(res.status).toBe(400);
  });
});

// ─── GET /api/admin/vendors/:id ──────────────────────────────────────────────

describe('GET /api/admin/vendors/:id', () => {
  beforeEach(async () => {
    await seedVendor(VENDOR, { slug: 'acme-corp', companyName: 'Acme Corp', verified: true });
    await t.db.insert(profiles).values([
      { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, displayName: 'Ada', seatOwner: true },
      {
        id: SEAT_B,
        role: 'vendor_admin',
        vendorId: VENDOR,
        displayName: 'Ben',
        bannedAt: '2026-08-01T00:00:00.000Z',
        banReason: 'spam',
      },
    ]);
  });

  it('404s on an unknown vendor id', async () => {
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${u(999)}`,
    );
    expect(res.status).toBe(404);
  });

  it('returns basics, a null entitlement, and the seat roster', async () => {
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam({ [SEAT_A]: 'ada@acme.test' })),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    expect(res.status).toBe(200);
    const b = await body(res);

    expect(b).toMatchObject({ slug: 'acme-corp', company_name: 'Acme Corp', verified: true });
    expect(b.entitlement).toBeNull();
    expect(b.seats.map((s: { display_name: string }) => s.display_name)).toEqual(['Ada', 'Ben']);
    expect(b.seats[0].email).toBe('ada@acme.test');
  });

  it('includes a BANNED seat on the roster', async () => {
    // A ban is a per-seat lock, not a removal — hiding it would leave an operator
    // unable to see why a colleague cannot sign in.
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.seats.find((s: { display_name: string }) => s.display_name === 'Ben').banned).toBe(
      true,
    );
  });

  it('excludes a reviewer profile that merely carries a vendor_id', async () => {
    await t.db
      .insert(profiles)
      .values({ id: u(22), role: 'reviewer', vendorId: VENDOR, displayName: 'Not a seat' });
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.seats.map((s: { display_name: string }) => s.display_name)).not.toContain(
      'Not a seat',
    );
  });

  it('reports seat_emails_available: false when the GoTrue seam is down — and STILL lists the seats', async () => {
    // The 2026-08-24 incident in one assertion: absent creds must degrade to
    // "unavailable", never to an empty or wrong roster.
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam({}, false)),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.seat_emails_available).toBe(false);
    expect(b.seats).toHaveLength(2);
    expect(b.seats[0].email).toBeNull();
  });

  it('counts claims across all four statuses, including in_review', async () => {
    await t.db.insert(vendorRequests).values([
      {
        id: u(60),
        kind: 'claim',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'a@acme.test',
        body: 'x',
        status: 'open',
      },
      {
        id: u(61),
        kind: 'claim',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'b@acme.test',
        body: 'x',
        status: 'in_review',
      },
      {
        id: u(62),
        kind: 'claim',
        targetType: 'vendor',
        targetId: VENDOR,
        submitterEmail: 'c@acme.test',
        body: 'x',
        status: 'rejected',
      },
    ]);

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.claim_counts).toEqual({ open: 1, in_review: 1, resolved: 0, rejected: 1 });
  });

  // ── The §5.2 payer test (AECI-738) ────────────────────────────────────────

  it('splits owned products by role, and keeps product_count as the sum', async () => {
    await t.db.insert(products).values([
      { id: PRODUCT, slug: 'acme-thing', name: 'Acme Thing', productRole: 'application' },
      { id: u(32), slug: 'acme-bridge', name: 'Acme Bridge', productRole: 'connector' },
      { id: u(33), slug: 'acme-both', name: 'Acme Both', productRole: 'hybrid' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: PRODUCT, vendorId: VENDOR },
      { productId: u(32), vendorId: VENDOR },
      { productId: u(33), vendorId: VENDOR },
    ]);

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.product_roles).toEqual({ application: 1, connector: 1, hybrid: 1, total: 3 });
    // Both come out of ONE grouped read, so the count cannot disagree with the split.
    expect(b.product_count).toBe(3);
    expect(b.is_pure_connector_vendor).toBe(false);
  });

  it('flags a vendor whose every product is a connector', async () => {
    await t.db
      .insert(products)
      .values({ id: PRODUCT, slug: 'bridge', name: 'Bridge', productRole: 'connector' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.is_pure_connector_vendor).toBe(true);
  });

  it('reports a vendor with no products as zeroed and NOT pure-connector', async () => {
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    expect(b.product_count).toBe(0);
    expect(b.product_roles).toEqual({ application: 0, connector: 0, hybrid: 0, total: 0 });
    // Owning nothing is UNKNOWN, not exempt — it must never read as a carve-out.
    expect(b.is_pure_connector_vendor).toBe(false);
  });

  it('counts a claim that targets a PRODUCT this vendor owns', async () => {
    await t.db.insert(products).values({ id: PRODUCT, slug: 'acme-thing', name: 'Acme Thing' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });
    await t.db.insert(vendorRequests).values({
      id: u(63),
      kind: 'claim',
      targetType: 'product',
      targetId: PRODUCT,
      submitterEmail: 'd@acme.test',
      body: 'x',
      status: 'open',
    });

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    // A product claim's `target_id` is a PRODUCT id — a naive
    // `target_type='vendor'` test would report zero here.
    expect(b.claim_counts.open).toBe(1);
  });

  it('omits an expired invite from pending_invites', async () => {
    await t.db.insert(vendorSeatInvites).values([
      {
        id: u(70),
        vendorId: VENDOR,
        email: 'live@acme.test',
        token: 'tok-live',
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
      {
        id: u(71),
        vendorId: VENDOR,
        email: 'dead@acme.test',
        token: 'tok-dead',
        expiresAt: '2020-01-01T00:00:00.000Z',
      },
    ]);

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id',
        createAdminVendorDetailHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}`,
    );
    const b = await body(res);
    // An aged-out invite is still `accepted_at IS NULL AND revoked_at IS NULL`,
    // so the expiry filter has to be in the query, not implied.
    expect(b.pending_invites.map((i: { email: string }) => i.email)).toEqual(['live@acme.test']);
  });
});

// ─── GET /api/admin/vendors/:id/products ─────────────────────────────────────

describe('GET /api/admin/vendors/:id/products', () => {
  beforeEach(async () => {
    await seedVendor(VENDOR, { slug: 'acme-corp', companyName: 'Acme Corp' });
    await seedVendor(OTHER_VENDOR, { slug: 'other-co', companyName: 'Other Co' });
  });

  it('404s on an unknown vendor id', async () => {
    // Not an empty successful page: that reads as "this vendor has no products".
    const res = await send(
      mount('get', '/api/admin/vendors/:id/products', createAdminVendorProductsHandler(t.factory)),
      `/api/admin/vendors/${u(999)}/products`,
    );
    expect(res.status).toBe(404);
  });

  it('returns owned products by name, including co-owned ones, and flags the primary', async () => {
    // Ownership is EVERY `product_vendors` row (§8.8(1)) — a co-owned product is
    // owned, and dropping it would under-report the payer test.
    await t.db.insert(products).values([
      { id: u(32), slug: 'acme-bridge', name: 'Bridge', productRole: 'connector' },
      { id: PRODUCT, slug: 'acme-thing', name: 'Acme Thing', productRole: 'application' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: PRODUCT, vendorId: VENDOR, isPrimary: true },
      { productId: u(32), vendorId: VENDOR, isPrimary: false },
      { productId: u(32), vendorId: OTHER_VENDOR, isPrimary: true },
    ]);

    const res = await send(
      mount('get', '/api/admin/vendors/:id/products', createAdminVendorProductsHandler(t.factory)),
      `/api/admin/vendors/${VENDOR}/products`,
    );
    expect(res.status).toBe(200);
    const b = await body(res);

    expect(b.total).toBe(2);
    expect(b.data.map((row: { name: string }) => row.name)).toEqual(['Acme Thing', 'Bridge']);
    expect(b.data[0]).toMatchObject({
      slug: 'acme-thing',
      product_role: 'application',
      is_primary: true,
    });
    expect(b.data[1]).toMatchObject({ product_role: 'connector', is_primary: false });
  });

  it("excludes another vendor's products", async () => {
    await t.db.insert(products).values({ id: PRODUCT, slug: 'other-thing', name: 'Other Thing' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: OTHER_VENDOR });

    const res = await send(
      mount('get', '/api/admin/vendors/:id/products', createAdminVendorProductsHandler(t.factory)),
      `/api/admin/vendors/${VENDOR}/products`,
    );
    const b = await body(res);
    expect(b.total).toBe(0);
    expect(b.data).toEqual([]);
  });

  it('withholds the average rating below the review floor and shows it above', async () => {
    // The §5.5 floor applies in the console too — the operator screen must not be
    // the one place a statistically misleading sub-5 average is readable.
    await t.db.insert(products).values([
      {
        id: PRODUCT,
        slug: 'shy',
        name: 'Shy',
        reviewCount: RATING_VISIBILITY_MIN_REVIEWS - 1,
        ratingOverallAvg: 4.9,
      },
      {
        id: u(32),
        slug: 'zeta',
        name: 'Zeta',
        reviewCount: RATING_VISIBILITY_MIN_REVIEWS,
        ratingOverallAvg: 4.2,
      },
    ]);
    await t.db.insert(productVendors).values([
      { productId: PRODUCT, vendorId: VENDOR },
      { productId: u(32), vendorId: VENDOR },
    ]);

    const res = await send(
      mount('get', '/api/admin/vendors/:id/products', createAdminVendorProductsHandler(t.factory)),
      `/api/admin/vendors/${VENDOR}/products`,
    );
    const b = await body(res);
    expect(b.data[0]).toMatchObject({ name: 'Shy', rating_overall_avg: null, review_count: 4 });
    expect(b.data[1]).toMatchObject({ name: 'Zeta', rating_overall_avg: 4.2 });
  });

  it('paginates, and total counts every owned product', async () => {
    await t.db.insert(products).values([
      { id: PRODUCT, slug: 'a', name: 'A' },
      { id: u(32), slug: 'b', name: 'B' },
      { id: u(33), slug: 'c', name: 'C' },
    ]);
    await t.db.insert(productVendors).values([
      { productId: PRODUCT, vendorId: VENDOR },
      { productId: u(32), vendorId: VENDOR },
      { productId: u(33), vendorId: VENDOR },
    ]);

    const res = await send(
      mount('get', '/api/admin/vendors/:id/products', createAdminVendorProductsHandler(t.factory)),
      `/api/admin/vendors/${VENDOR}/products?page=2&perPage=2`,
    );
    const b = await body(res);
    expect(b).toMatchObject({ page: 2, perPage: 2, total: 3 });
    expect(b.data.map((row: { name: string }) => row.name)).toEqual(['C']);
  });

  it('writes no audit_log row — reads write nothing', async () => {
    await t.db.insert(products).values({ id: PRODUCT, slug: 'a', name: 'A' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });

    await send(
      mount('get', '/api/admin/vendors/:id/products', createAdminVendorProductsHandler(t.factory)),
      `/api/admin/vendors/${VENDOR}/products`,
    );
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });
});

// ─── GET /api/admin/vendors/:id/audit ────────────────────────────────────────

describe('GET /api/admin/vendors/:id/audit', () => {
  beforeEach(async () => {
    await seedVendor(VENDOR);
    await seedVendor(OTHER_VENDOR);
  });

  const audit = (over: Partial<typeof auditLog.$inferInsert>) => ({
    id: u(Math.floor(Math.random() * 1e6) + 100000),
    actorType: 'admin',
    action: 'vendor.updated',
    createdAt: '2026-08-20T00:00:00.000Z',
    ...over,
  });

  it('404s on an unknown vendor id rather than returning an empty page', async () => {
    // An empty 200 would read as "this vendor has no history", not "no such
    // vendor" — a materially different answer for an operator.
    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${u(999)}/audit`,
    );
    expect(res.status).toBe(404);
  });

  it('returns rows filed directly against the vendor', async () => {
    await t.db.insert(auditLog).values([
      audit({ action: 'vendor.updated', entityType: 'vendor', entityId: VENDOR }),
      audit({
        action: 'vendor_entitlement.set',
        entityType: 'vendor_entitlement',
        entityId: VENDOR,
      }),
    ]);

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit?scope=entity`,
    );
    const b = await body(res);
    expect(b.data.map((r: { action: string }) => r.action).sort()).toEqual([
      'vendor.updated',
      'vendor_entitlement.set',
    ]);
  });

  it('reaches a REJECTED claim, whose audit metadata carries no vendor_id', async () => {
    // `rejectClaimStatements` builds metadata with `claimMetadata(p, {})`, which
    // emits target_type/target_id and no vendor_id — and `RejectClaimParams` does
    // not even carry one. Without the `vendor_request` subquery leg this row is
    // unreachable, and it stays unreachable for every row already written.
    await t.db.insert(vendorRequests).values({
      id: u(64),
      kind: 'claim',
      targetType: 'vendor',
      targetId: VENDOR,
      submitterEmail: 'e@acme.test',
      body: 'x',
      status: 'rejected',
    });
    await t.db.insert(auditLog).values(
      audit({
        action: 'vendor_claim.rejected',
        entityType: 'vendor_request',
        entityId: u(64),
        metadata: { source: 'admin-moderation', kind: 'claim', target_type: 'vendor' },
      }),
    );

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit?scope=entity`,
    );
    const b = await body(res);
    expect(b.data.map((r: { action: string }) => r.action)).toContain('vendor_claim.rejected');
  });

  it('reaches a rejected claim that targeted a PRODUCT the vendor owns', async () => {
    await t.db.insert(products).values({ id: PRODUCT, slug: 'acme-thing', name: 'Acme Thing' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });
    await t.db.insert(vendorRequests).values({
      id: u(65),
      kind: 'claim',
      targetType: 'product',
      targetId: PRODUCT,
      submitterEmail: 'f@acme.test',
      body: 'x',
      status: 'rejected',
    });
    await t.db
      .insert(auditLog)
      .values(
        audit({ action: 'vendor_claim.rejected', entityType: 'vendor_request', entityId: u(65) }),
      );

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit?scope=entity`,
    );
    const b = await body(res);
    expect(b.data.map((r: { action: string }) => r.action)).toContain('vendor_claim.rejected');
  });

  it('reaches a seat revoke AFTER the seat stopped pointing at the vendor', async () => {
    // The row files under `entity_type='profile'` with the SEAT's id, and the
    // revoke nulled `profiles.vendor_id` — so neither the entity-id leg nor the
    // actor scope can find it. Only `metadata.vendor_id` can.
    await t.db.insert(profiles).values({ id: SEAT_A, role: 'reviewer', vendorId: null });
    await t.db.insert(auditLog).values(
      audit({
        action: 'vendor_claim.seat_revoked',
        entityType: 'profile',
        entityId: SEAT_A,
        metadata: { source: 'admin-moderation', vendor_id: VENDOR, seat_user_id: SEAT_A },
      }),
    );

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit?scope=entity`,
    );
    const b = await body(res);
    expect(b.data.map((r: { action: string }) => r.action)).toContain('vendor_claim.seat_revoked');
  });

  it('reaches a seat ban/unban, which files under the profile with no vendor_id', async () => {
    // `admin-reviewers.ts` writes `vendor_admin.banned` under `entity_type='profile'`
    // with the seat's id and metadata `{ source, reason? }` — no `vendor_id`, and the
    // actor is the ADMIN, not the seat. So neither the entity-id leg, the metadata
    // leg, nor the actor scope reaches it. The roster shows the ban is in effect; the
    // audit tab has to be able to explain when and why. A ban does not null
    // `vendor_id`, so the seat is still in `seatsOf`.
    await t.db.insert(profiles).values({
      id: SEAT_A,
      role: 'vendor_admin',
      vendorId: VENDOR,
      bannedAt: '2026-08-19T00:00:00.000Z',
    });
    await t.db.insert(auditLog).values([
      audit({
        action: 'vendor_admin.banned',
        entityType: 'profile',
        entityId: SEAT_A,
        metadata: { source: 'admin-moderation', reason: 'spam' },
      }),
      audit({ action: 'vendor_admin.unbanned', entityType: 'profile', entityId: SEAT_A }),
    ]);

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit?scope=entity`,
    );
    const b = await body(res);
    expect(b.data.map((r: { action: string }) => r.action).sort()).toEqual([
      'vendor_admin.banned',
      'vendor_admin.unbanned',
    ]);
  });

  it("actor scope returns what the vendor's seats did, including product edits", async () => {
    await t.db
      .insert(profiles)
      .values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, displayName: 'Ada' });
    await t.db.insert(auditLog).values(
      audit({
        action: 'product.updated',
        actorId: SEAT_A,
        actorType: 'user',
        entityType: 'product',
        entityId: PRODUCT,
      }),
    );

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit?scope=actor`,
    );
    const b = await body(res);
    expect(b.data).toHaveLength(1);
    expect(b.data[0]).toMatchObject({ action: 'product.updated', actor_type: 'user' });
    expect(b.data[0].actor.display_name).toBe('Ada');
  });

  it("does not leak another vendor's rows", async () => {
    await t.db
      .insert(auditLog)
      .values([
        audit({ action: 'vendor.updated', entityType: 'vendor', entityId: VENDOR }),
        audit({ action: 'vendor.updated', entityType: 'vendor', entityId: OTHER_VENDOR }),
      ]);

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit`,
    );
    const b = await body(res);
    expect(b.total).toBe(1);
    expect(b.data[0].entity_id).toBe(VENDOR);
  });

  it('reports a system row as having no actor', async () => {
    await t.db.insert(auditLog).values(
      audit({
        action: 'promote.blocked',
        actorId: null,
        actorType: 'system',
        entityType: 'vendor',
        entityId: VENDOR,
      }),
    );

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit`,
    );
    const b = await body(res);
    // `null` here means "not a person", not "person unknown" — the UI says
    // "System", and it would be wrong to say "unavailable".
    expect(b.data[0].actor).toBeNull();
    expect(b.data[0].actor_type).toBe('system');
  });

  it('orders newest first and paginates stably when timestamps tie', async () => {
    // Two rows written by one `db.batch` routinely share a millisecond. Without
    // the `id DESC` tiebreak the page boundary is non-deterministic and a row can
    // appear twice or vanish.
    const sameMs = '2026-08-20T12:00:00.000Z';
    await t.db.insert(auditLog).values([
      audit({ id: u(200), entityType: 'vendor', entityId: VENDOR, createdAt: sameMs }),
      audit({ id: u(201), entityType: 'vendor', entityId: VENDOR, createdAt: sameMs }),
      audit({
        id: u(202),
        entityType: 'vendor',
        entityId: VENDOR,
        createdAt: '2026-08-21T00:00:00.000Z',
      }),
    ]);

    const auditApp = mount(
      'get',
      '/api/admin/vendors/:id/audit',
      createAdminVendorAuditHandler(t.factory, emailSeam()),
    );
    const first = await body(await send(auditApp, `/api/admin/vendors/${VENDOR}/audit?perPage=2`));
    const second = await body(
      await send(auditApp, `/api/admin/vendors/${VENDOR}/audit?perPage=2&page=2`),
    );

    expect(first.data[0].id).toBe(u(202));
    expect(first.total).toBe(3);
    const seen = [...first.data, ...second.data].map((r: { id: string }) => r.id);
    expect(new Set(seen).size).toBe(3);
  });

  it('survives a non-object before_state without throwing', async () => {
    // These rows outlive the code that wrote them and nothing prunes the table,
    // so a scalar snapshot is a shape today's reader must tolerate rather than
    // reject. `validateResponseInDev` runs here (TEST_ENV is `preview`).
    await t.db.insert(auditLog).values(
      audit({
        entityType: 'vendor',
        entityId: VENDOR,
        beforeState: 'a bare string',
        afterState: 42,
      }),
    );

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit`,
    );
    expect(res.status).toBe(200);
    const b = await body(res);
    expect(b.data[0].before_state).toBe('a bare string');
    expect(b.data[0].after_state).toBe(42);
  });
});

// ─── DELETE /api/admin/vendors/:id/seats/:userId ─────────────────────────────

describe('DELETE /api/admin/vendors/:id/seats/:userId', () => {
  beforeEach(async () => {
    await seedVendor(VENDOR, { verified: true });
    await t.db.insert(vendorEntitlements).values({
      id: u(41),
      vendorId: VENDOR,
      tier: 'verified',
      status: 'active',
    });
    await t.db
      .insert(profiles)
      .values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true });
  });

  const revoke = (vendorId: string, userId: string) =>
    send(
      mount(
        'delete',
        '/api/admin/vendors/:id/seats/:userId',
        createAdminRevokeSeatHandler(t.factory),
      ),
      `/api/admin/vendors/${vendorId}/seats/${userId}`,
      'DELETE',
    );

  it('un-grants the seat and returns 204', async () => {
    expect((await revoke(VENDOR, SEAT_A)).status).toBe(204);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.role).toBe('reviewer');
    expect(seat.vendorId).toBeNull();
    expect(seat.seatOwner).toBe(false);
  });

  it('writes its audit row in the same batch, with vendor_id in the metadata', async () => {
    await revoke(VENDOR, SEAT_A);
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vendor_claim.seat_revoked'));
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('profile');
    expect(rows[0].entityId).toBe(SEAT_A);
    // The audit viewer's third disjunct depends on this key being present — it is
    // the ONLY way the row is reachable once `profiles.vendor_id` is null.
    expect((rows[0].metadata as { vendor_id?: string }).vendor_id).toBe(VENDOR);
    expect(rows[0].actorType).toBe('admin');
  });

  it('leaves the entitlement, the mirror and vendors.updated_at alone', async () => {
    // §5.2 — clearing an entitlement and revoking a seat are orthogonal. A revoke
    // that moved the mirror would silently un-verify a vendor whose arrangement
    // is still live and still paid for.
    const [before] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    await revoke(VENDOR, SEAT_A);
    const [after] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    expect(after.verified).toBe(true);
    expect(after.updatedAt).toBe(before.updatedAt);

    const [ent] = await t.db
      .select()
      .from(vendorEntitlements)
      .where(eq(vendorEntitlements.vendorId, VENDOR));
    expect(ent.status).toBe('active');
  });

  it('404s for a seat on a DIFFERENT vendor', async () => {
    await seedVendor(OTHER_VENDOR);
    expect((await revoke(OTHER_VENDOR, SEAT_A)).status).toBe(404);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.role).toBe('vendor_admin');
  });

  it('404s for a profile that is not a seat', async () => {
    await t.db.insert(profiles).values({ id: SEAT_B, role: 'reviewer', vendorId: VENDOR });
    expect((await revoke(VENDOR, SEAT_B)).status).toBe(404);
  });

  it('404s for an unknown vendor', async () => {
    expect((await revoke(u(999), SEAT_A)).status).toBe(404);
  });

  it('removes the LAST owner — the admin is the escape hatch, not a caller to guard', async () => {
    // The portal refuses this because a vendor cannot self-rescue from an
    // unadministrable account and "only an AECi grant can rescue it". The admin
    // IS that rescue, so carrying the guard over would only block the operator
    // who exists to undo it.
    expect((await revoke(VENDOR, SEAT_A)).status).toBe(204);
  });
});

// ─── POST /api/admin/vendors/:id/seats (AECI-740) ────────────────────────────

/**
 * The provisioning action, and the one property every test here exists to pin:
 * **it creates a `vendor_admin` seat and opens NO `vendor_entitlements` row.**
 *
 * `STAGE_2_SPEC.md` §8.9(1) settled that a pure connector vendor is never sold
 * verification and gets a catalogue-maintenance seat instead; §8.9(2) showed the
 * seat cannot be an entitlement row, because `vendors.verified` mirrors off
 * `status = 'active'` rather than `tier` — so any active row lights the badge.
 * Before this endpoint, every path to a seat opened one on the way, which is why
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 had to tell operators not to press Grant.
 *
 * The identity seam is injected, so these run with no Supabase. Its ABSENCE is
 * covered too — 503 is the default outcome on local dev and PR previews, exactly
 * as on the claim grant.
 */
describe('POST /api/admin/vendors/:id/seats', () => {
  const CLAIMANT_EMAIL = 'ops@mindcloud.example';

  /** `resolveClaimantIdentity`, stubbed. Returns whatever outcome a test needs. */
  const identity = (
    outcome: Awaited<ReturnType<typeof resolveClaimantIdentity>>,
  ): typeof resolveClaimantIdentity =>
    (async () => outcome) as unknown as typeof resolveClaimantIdentity;

  const linked = (profile: Parameters<typeof identity>[0] extends never ? never : unknown = null) =>
    identity({
      outcome: 'linked',
      userId: SEAT_A,
      email: CLAIMANT_EMAIL,
      profile: profile as never,
    });

  const provision = (
    vendorId: string,
    resolve: typeof resolveClaimantIdentity,
    payload: unknown = { email: CLAIMANT_EMAIL },
  ) =>
    send(
      mount('post', '/api/admin/vendors/:id/seats', createProvisionSeatHandler(t.factory, resolve)),
      `/api/admin/vendors/${vendorId}/seats`,
      'POST',
      payload,
    );

  beforeEach(async () => {
    // A pure connector vendor — the case the carve-out is about — deliberately
    // left `verified: false` with no entitlement row.
    await seedVendor(VENDOR, { companyName: 'MindCloud' });
    await t.db
      .insert(products)
      .values({ id: PRODUCT, slug: 'mindcloud', name: 'MindCloud', productRole: 'connector' });
    await t.db.insert(productVendors).values({ productId: PRODUCT, vendorId: VENDOR });
  });

  it('creates the seat as an owner and reports it, with 201', async () => {
    const res = await provision(VENDOR, linked());
    expect(res.status).toBe(201);

    const b = await body(res);
    expect(b.user_id).toBe(SEAT_A);
    expect(b.identity_outcome).toBe('linked');
    expect(b.seat_created).toBe(true);
    expect(b.seat_owner).toBe(true);
    expect(b.noop).toBe(false);
    expect(b.is_pure_connector_vendor).toBe(true);
    expect(b.product_roles).toEqual({ application: 0, connector: 1, hybrid: 0, total: 1 });

    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.role).toBe('vendor_admin');
    expect(seat.vendorId).toBe(VENDOR);
    // Owner, so the vendor can add its own colleagues through the shipped invite
    // flow without a second admin action every time (AECI-664 / §11a).
    expect(seat.seatOwner).toBe(true);
  });

  it('opens NO entitlement row and never lights the badge — the whole point', async () => {
    // §8.9(2). This is the assertion the endpoint exists for; if it ever fails,
    // a connector vendor has been handed the Verified badge the carve-out says
    // they will never be sold, through a one-way door.
    const [before] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    const res = await provision(VENDOR, linked());

    expect((await body(res)).entitlement_granted).toBe(false);
    expect((await body(await provision(VENDOR, linked()))).verified).toBe(false);

    expect(await t.db.select().from(vendorEntitlements)).toEqual([]);
    const [after] = await t.db.select().from(vendors).where(eq(vendors.id, VENDOR));
    // Byte-identical, including `updated_at` — nothing must reach the nightly
    // Algolia push as a changed vendor record (§5.2 step 2's approve-then-clear
    // objection applies just as much to a spurious touch).
    expect(after).toEqual(before);
  });

  it('leaves entitlement_mirror_drift clean (§8.9(4))', async () => {
    // The drift check counts vendors where `verified = 1` XOR an active row
    // exists. A seat with no entitlement touches NEITHER side, so it is invisible
    // to the sweep — intended, but the issue asked that it be confirmed rather
    // than assumed.
    await provision(VENDOR, linked());

    const drifted = await runDataQualityChecks({
      db: t.db as never,
      fetchImpl: (async () => new Response('{}')) as never,
    } as never);
    const mirror = drifted.find((check) => check.id === 'entitlement_mirror_drift');
    expect(mirror?.count).toBe(0);
  });

  it('writes its audit row in the same batch, carrying metadata.vendor_id', async () => {
    await provision(VENDOR, linked());

    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vendor_seat.provisioned'));
    expect(rows).toHaveLength(1);
    expect(rows[0].entityType).toBe('profile');
    expect(rows[0].entityId).toBe(SEAT_A);
    const metadata = rows[0].metadata as Record<string, unknown>;
    // Leg 3 of `auditScopeWhere` is the only route to this row on the vendor's
    // own audit tab — the seat DOES carry `vendor_id`, but leg 4 filters on the
    // ban actions only.
    expect(metadata.vendor_id).toBe(VENDOR);
    expect(metadata.entitlement_granted).toBe(false);
    expect(metadata.is_pure_connector_vendor).toBe(true);
  });

  it('surfaces the new row through GET /api/admin/vendors/:id/audit', async () => {
    // The lockstep assertion for `VENDOR_METADATA_ACTIONS`. Without that entry the
    // row is written correctly and is invisible on the only screen that reads it.
    await provision(VENDOR, linked());

    const res = await send(
      mount(
        'get',
        '/api/admin/vendors/:id/audit',
        createAdminVendorAuditHandler(t.factory, emailSeam()),
      ),
      `/api/admin/vendors/${VENDOR}/audit`,
    );
    const b = await body(res);
    expect(b.data.map((r: { action: string }) => r.action)).toContain('vendor_seat.provisioned');
  });

  it('is a 200 no-op when the seat already reads exactly this way', async () => {
    await t.db
      .insert(profiles)
      .values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true });

    const res = await provision(
      VENDOR,
      identity({
        outcome: 'linked',
        userId: SEAT_A,
        email: CLAIMANT_EMAIL,
        profile: { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, bannedAt: null },
      }),
    );

    expect(res.status).toBe(200);
    expect((await body(res)).noop).toBe(true);
    // A trail of identical states is not a history (the §5.2 note-write rule).
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('DOES write when an existing non-owner seat is promoted', async () => {
    // A colleague who joined by redeeming an invite holds `seat_owner: false`.
    // Promoting them is a real change, so it must not be swallowed by the no-op.
    await t.db
      .insert(profiles)
      .values({ id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, seatOwner: false });

    const res = await provision(
      VENDOR,
      identity({
        outcome: 'linked',
        userId: SEAT_A,
        email: CLAIMANT_EMAIL,
        profile: { id: SEAT_A, role: 'vendor_admin', vendorId: VENDOR, bannedAt: null },
      }),
    );

    expect(res.status).toBe(201);
    expect((await body(res)).noop).toBe(false);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.seatOwner).toBe(true);
    expect(await t.db.select().from(auditLog)).toHaveLength(1);
  });

  it('409s on an account that is a site admin, or belongs to another vendor', async () => {
    const conflict = (reason: 'already_admin' | 'other_vendor') =>
      identity({
        outcome: 'conflict',
        reason,
        userId: SEAT_B,
        email: CLAIMANT_EMAIL,
        profile: { id: SEAT_B, role: 'admin', vendorId: null, bannedAt: null },
      });

    expect((await provision(VENDOR, conflict('already_admin'))).status).toBe(409);
    expect((await provision(VENDOR, conflict('other_vendor'))).status).toBe(409);
    // Nothing written on either refusal.
    expect(await t.db.select().from(auditLog)).toEqual([]);
  });

  it('503s when the identity seam is unavailable — the local-dev default', async () => {
    // `SUPABASE_SERVICE_ROLE_KEY` is legitimately absent on local dev and every
    // PR preview, so this is the DEFAULT path there, exactly as on the grant. It
    // must refuse rather than half-provision.
    const res = await provision(VENDOR, identity({ outcome: 'unavailable' }));
    expect(res.status).toBe(503);
    expect(await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A))).toEqual([]);
  });

  it('404s for an unknown vendor, before resolving any identity', async () => {
    // Ordering matters: resolving first would provision an `auth.users` row for a
    // request that is about to 404, orphaning it.
    const resolve = vi.fn(linked());
    const res = await send(
      mount(
        'post',
        '/api/admin/vendors/:id/seats',
        createProvisionSeatHandler(t.factory, resolve as unknown as typeof resolveClaimantIdentity),
      ),
      `/api/admin/vendors/${u(999)}/seats`,
      'POST',
      { email: CLAIMANT_EMAIL },
    );

    expect(res.status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('400s on a malformed email', async () => {
    // 400, not 422: the shared `errorHandler` maps every `ZodError` to
    // VALIDATION_FAILED / 400 (`apps/api/src/errors.ts`), and 422 on this surface
    // is reserved for invalid STATE transitions.
    expect((await provision(VENDOR, linked(), { email: 'not-an-address' })).status).toBe(400);
  });

  it('warns but does not gate on a vendor that owns endpoint products', async () => {
    // §5.2 step 1 / AECI-738: `product_role` is curated upstream, so a mis-roled
    // record must not hard-block a legitimate operator. The console warns; the
    // API provisions and RECORDS the payer test as it stood.
    await t.db
      .insert(products)
      .values({ id: u(32), slug: 'mindcloud-app', name: 'App', productRole: 'application' });
    await t.db.insert(productVendors).values({ productId: u(32), vendorId: VENDOR });

    const res = await provision(VENDOR, linked());
    expect(res.status).toBe(201);
    expect((await body(res)).is_pure_connector_vendor).toBe(false);

    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'vendor_seat.provisioned'));
    expect((row.metadata as Record<string, unknown>).is_pure_connector_vendor).toBe(false);
  });

  it('provisions a banned account without becoming a second banned_at writer', async () => {
    // Ban policy is `PATCH /api/admin/reviewers/:id`'s (AECI-524), and the claim
    // grant does not refuse a banned account either — two admin paths must not
    // tell different stories about one account. The ban is SURFACED, not enforced,
    // and `banned_at` is untouched (`routes/banned-at-writers.spec.ts`).
    await t.db
      .insert(profiles)
      .values({ id: SEAT_A, role: 'reviewer', bannedAt: '2026-01-01T00:00:00.000Z' });

    const res = await provision(
      VENDOR,
      identity({
        outcome: 'linked',
        userId: SEAT_A,
        email: CLAIMANT_EMAIL,
        profile: {
          id: SEAT_A,
          role: 'reviewer',
          vendorId: null,
          bannedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    );

    expect(res.status).toBe(201);
    expect((await body(res)).banned).toBe(true);
    const [seat] = await t.db.select().from(profiles).where(eq(profiles.id, SEAT_A));
    expect(seat.bannedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(seat.role).toBe('vendor_admin');
  });
});
