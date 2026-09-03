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
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';
import {
  createAdminRevokeSeatHandler,
  createAdminVendorAuditHandler,
  createAdminVendorDetailHandler,
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
  method: 'get' | 'delete',
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
): Promise<Response> {
  return app.request(url, { method }, TEST_ENV, fakeExecutionContext());
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

  it('counts owned products and built integrations per row', async () => {
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
    expect(acme.integration_count).toBe(1);
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
