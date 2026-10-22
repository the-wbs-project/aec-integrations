/**
 * An owner adds a product to its company (AECI-1424; `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.8),
 * against the real-SQLite harness. A stub middleware sets the `auth` Variable;
 * `vendor-product-create.registration.spec.ts` runs the real guard and the limiter.
 */

import {
  ApiErrorCode,
  CreateVendorProductResponseSchema,
  PromotePayloadSchema,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/algolia-sync', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/algolia-sync')>();
  return { ...real, syncIndexTargets: vi.fn(async () => []) };
});
vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitMetricsBatch: vi.fn(),
}));

import {
  auditLog,
  productCategories,
  productProposals,
  productVendors,
  products,
  profiles,
  taxonomyCategories,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { syncIndexTargets } from '../lib/algolia-sync';
import { resetAlgoliaWriteGuardWarning } from '../lib/algolia-write-guard';
import type { AuthzVariables } from '../lib/authz';
import type { DbFactory } from '../lib/handler-utils';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { racingFactory } from '../test/racing-factory';
import { BLOCKED_PRODUCT_REASON, runPromoteIngest, type PromoteRunCtx } from './promote';
import {
  createCreateVendorProductHandler,
  VENDOR_PRODUCT_CREATE_REASON,
} from './vendor-product-create';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNED = u(1); // Bentley, owns its record
const UNOWNED = u(2); // Topcon, has a seat but never owned
const OWNER = u(100);
const MEMBER = u(101);
const UNOWNED_OWNER = u(102);
const EXISTING = u(20); // a product Bentley already has
const OWNED_AT = '2026-10-01T00:00:00.000Z';

const seat = (userId: string, vendorId: string): AuthzVariables['auth'] => ({
  userId,
  email: `${userId.slice(-3)}@example.test`,
  role: 'vendor_admin',
  vendorId,
  entitlementTier: 'unclaimed',
  entitlement: null,
});

let t: TestDb;
let queueSend: ReturnType<typeof vi.fn>;
let ownershipSend: ReturnType<typeof vi.fn>;
let ownershipSendBatch: ReturnType<typeof vi.fn>;

const ENV = {
  ENV: 'staging',
  ALGOLIA_APP_ID: 'TESTAPP',
  ALGOLIA_ADMIN_KEY: 'test-admin-key',
} as Env;

beforeEach(async () => {
  t = await makeTestDb();
  queueSend = vi.fn(async () => undefined);
  ownershipSend = vi.fn(async () => undefined);
  ownershipSendBatch = vi.fn(async () => undefined);
  vi.mocked(syncIndexTargets).mockClear();
  resetAlgoliaWriteGuardWarning();
  await t.db.insert(vendors).values([
    { id: OWNED, slug: 'bentley', companyName: 'Bentley', ownedAt: OWNED_AT },
    { id: UNOWNED, slug: 'topcon', companyName: 'Topcon' },
  ]);
  await t.db.insert(products).values({
    id: EXISTING,
    slug: 'openroads',
    name: 'OpenRoads',
    promotionStatus: 'promoted',
  });
  await t.db
    .insert(productVendors)
    .values({ productId: EXISTING, vendorId: OWNED, isPrimary: true });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: OWNED, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: OWNED },
    { id: UNOWNED_OWNER, role: 'vendor_admin', vendorId: UNOWNED, seatOwner: true },
  ]);
  await t.db.insert(taxonomyCategories).values([
    { id: u(30), slug: 'civil-design', name: 'Civil Design' },
    { id: u(31), slug: 'bim', name: 'BIM' },
  ]);
});
afterEach(() => {
  t.dispose();
});

function app(auth: AuthzVariables['auth'], factory: DbFactory = t.factory) {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', auth);
    await next();
  });
  a.post('/api/vendor/products', createCreateVendorProductHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function create(
  body: unknown,
  opts: { auth?: AuthzVariables['auth']; factory?: DbFactory } = {},
) {
  const execCtx = fakeExecutionContext();
  const res = await app(opts.auth ?? seat(OWNER, OWNED), opts.factory).request(
    '/api/vendor/products',
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    {
      ...ENV,
      CACHE_PURGE_QUEUE: { send: queueSend },
      OWNERSHIP_SYNC_QUEUE: { send: ownershipSend, sendBatch: ownershipSendBatch },
    } as unknown as Env,
    execCtx,
  );
  const json = (await res.json()) as JsonBody;
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body: json };
}

const productCount = async () => (await t.db.select().from(products)).length;
const audits = () => t.db.select().from(auditLog);

describe('POST /api/vendor/products', () => {
  it('creates a promoted, vendor-maintained product owned by the company, in one batch with its audit row', async () => {
    const { status, body } = await create({
      name: 'SYNCHRO 4D',
      description: 'Construction scheduling in 4D.',
      website: 'https://bentley.example/synchro',
      category_slugs: ['civil-design', 'bim'],
    });
    expect(status).toBe(201);
    const parsed = CreateVendorProductResponseSchema.parse(body);
    expect(parsed.product).toMatchObject({ slug: 'synchro-4d', name: 'SYNCHRO 4D' });
    expect(parsed.possible_duplicates).toEqual([]);

    const id = parsed.product.id;
    const [row] = await t.db.select().from(products).where(eq(products.id, id));
    expect(row).toMatchObject({
      name: 'SYNCHRO 4D',
      description: 'Construction scheduling in 4D.',
      website: 'https://bentley.example/synchro',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
      productRole: 'application',
    });
    expect(row!.lastReviewedAt).toBe(row!.promotedAt);
    expect(
      await t.db.select().from(productVendors).where(eq(productVendors.productId, id)),
    ).toEqual([expect.objectContaining({ vendorId: OWNED, isPrimary: true })]);
    const cats = await t.db
      .select()
      .from(productCategories)
      .where(eq(productCategories.productId, id));
    expect(cats.map((c) => c.categoryId).sort()).toEqual([u(30), u(31)]);

    const created = (await audits()).filter((a) => a.action === 'product.created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ entityId: id, actorId: OWNER });
    expect(created[0]!.metadata).toMatchObject({
      source: 'vendor-portal',
      reason: VENDOR_PRODUCT_CREATE_REASON,
      vendorId: OWNED,
      possibleDuplicateIds: [],
    });
  });

  it('purges the promote create set, syncs search, and sends no ownership message', async () => {
    const { body } = await create({ name: 'SYNCHRO', category_slugs: ['bim'] });
    const tags = queueSend.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags).toEqual(
      expect.arrayContaining(['product:synchro', 'vendor:bentley', 'index:products', 'sitemap']),
    );
    expect(syncIndexTargets).toHaveBeenCalled();
    const targets = vi.mocked(syncIndexTargets).mock.calls[0]!.slice(1) as unknown[];
    expect(JSON.stringify(targets)).toContain(body.product.id);
    expect(ownershipSend).not.toHaveBeenCalled();
    expect(ownershipSendBatch).not.toHaveBeenCalled();
  });

  it('refuses a member seat and writes nothing', async () => {
    const { status, body } = await create({ name: 'SYNCHRO' }, { auth: seat(MEMBER, OWNED) });
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
    expect(await productCount()).toBe(1);
  });

  it('refuses a company that does not own its record', async () => {
    const { status, body } = await create(
      { name: 'Topcon Field' },
      { auth: seat(UNOWNED_OWNER, UNOWNED) },
    );
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.VENDOR_NOT_OWNED);
    expect(await productCount()).toBe(1);
  });

  it.each([
    ['a paid field', { name: 'X', trade_slugs: ['paving'] }],
    ['a doc URL', { name: 'X', api_docs_url: 'https://x.example/api' }],
    ['"How teams use it"', { name: 'X', usefulness: { audiences: [], phases: [] } }],
    ['a curation field', { name: 'X', research_status: 'complete' }],
    ['a product role', { name: 'X', product_role: 'connector' }],
    ['no name', { description: 'Nameless.' }],
    ['a javascript: website', { name: 'X', website: 'javascript:alert(1)' }],
  ])('refuses %s with a 400', async (_label, body) => {
    const { status, body: res } = await create(body);
    expect(status).toBe(400);
    expect(res.error.code).toBe(ApiErrorCode.VALIDATION_FAILED);
    expect(await productCount()).toBe(1);
  });

  it('never mints a term: an unknown category slug is a 400', async () => {
    const before = (await t.db.select().from(taxonomyCategories)).length;
    const { status, body } = await create({ name: 'X', category_slugs: ['bim', 'no-such-term'] });
    expect(status).toBe(400);
    expect(body.error.message).toContain('no-such-term');
    expect((await t.db.select().from(taxonomyCategories)).length).toBe(before);
    expect(await productCount()).toBe(1);
  });

  it('warns about a same-name product and an open proposal, and still creates', async () => {
    const rc: PromoteRunCtx = {
      env: { ENV: 'staging' } as Env,
      request: new Request('http://localhost/api/promote'),
      waitUntil: () => {},
      bookmark: () => null,
    };
    const { response } = await runPromoteIngest(
      rc,
      PromotePayloadSchema.parse({
        vendors: [{ ref: 'v1', supabaseId: OWNED, companyName: 'Bentley' }],
        product: { ref: 'p:recOpenRoads', name: '  openroads ' },
      }),
      {
        dbFor: t.factory,
        syncAlgolia: async () => {},
        notifyIndexNow: async () => {},
        refreshHomeStats: async () => {},
        notifyProposalOwners: async () => {},
      },
    );
    const proposalId = response.skipped.find((s) => s.proposalId)!.proposalId!;
    expect(await t.db.select().from(productProposals)).toHaveLength(1);

    const { status, body } = await create({ name: 'OpenRoads' });
    expect(status).toBe(201);
    expect(body.product.slug).not.toBe('openroads');
    expect(body.possible_duplicates).toEqual([
      { kind: 'product', id: EXISTING, name: 'OpenRoads', slug: 'openroads' },
      { kind: 'proposal', id: proposalId, name: '  openroads ' },
    ]);
    const created = (await audits()).find(
      (a) => a.action === 'product.created' && a.entityId === body.product.id,
    );
    expect(created!.metadata).toMatchObject({ possibleDuplicateIds: [EXISTING, proposalId] });
  });

  it('aborts on a "Return records to AECi" between the read and the batch', async () => {
    const racing = racingFactory(t.factory, async () => {
      await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, OWNED));
    });
    const { status, body } = await create({ name: 'SYNCHRO' }, { factory: racing });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.VENDOR_NOT_OWNED);
    expect(await productCount()).toBe(1);
    expect((await audits()).filter((a) => a.action === 'product.created')).toEqual([]);
    expect(queueSend).not.toHaveBeenCalled();
  });

  it('answers SLUG_CONFLICT when another product takes the slug at the same moment', async () => {
    const racing = racingFactory(t.factory, async () => {
      await t.db.insert(products).values({ id: u(21), slug: 'synchro', name: 'Synchro' });
    });
    const { status, body } = await create({ name: 'SYNCHRO' }, { factory: racing });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.SLUG_CONFLICT);
    expect(await productCount()).toBe(2);
  });

  it('is owned from creation: a promote naming it writes nothing', async () => {
    const { body } = await create({ name: 'SYNCHRO', description: 'Vendor text.' });
    const id = body.product.id as string;
    const { response } = await runPromoteIngest(
      {
        env: { ENV: 'staging' } as Env,
        request: new Request('http://localhost/api/promote'),
        waitUntil: () => {},
        bookmark: () => null,
      },
      PromotePayloadSchema.parse({
        vendors: [{ ref: 'v1', supabaseId: OWNED, companyName: 'Bentley' }],
        product: { ref: 'p:recSynchro', supabaseId: id, name: 'Renamed', description: 'Curated.' },
      }),
      {
        dbFor: t.factory,
        syncAlgolia: async () => {},
        notifyIndexNow: async () => {},
        refreshHomeStats: async () => {},
        notifyProposalOwners: async () => {},
      },
    );
    expect(response.product).toBeNull();
    expect(response.skipped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'product', reason: BLOCKED_PRODUCT_REASON }),
      ]),
    );
    const [row] = await t.db.select().from(products).where(eq(products.id, id));
    expect(row).toMatchObject({
      name: 'SYNCHRO',
      description: 'Vendor text.',
      maintainedBy: 'vendor',
    });
  });
});
