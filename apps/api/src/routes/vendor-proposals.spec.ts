/**
 * The owner's "Proposed products" (AECI-1417, E6b.5; ADR 0042): the list, accept and
 * decline, against the real-SQLite harness. A stub middleware sets the `auth` Variable;
 * the authz matrix (`vendor.authz-matrix.spec.ts`) runs the real guard and
 * `vendor-proposals.registration.spec.ts` the limiter.
 *
 * Proposals are stored by a real promote (`runPromoteIngest`), so the payload under test
 * is the one AECI-1416 writes.
 */

import {
  AcceptVendorProposalResponseSchema,
  ApiErrorCode,
  ListVendorProposalsResponseSchema,
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
  productAudiences,
  productCategories,
  productExtensions,
  productProposals,
  productTrades,
  productVendors,
  products,
  profiles,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyPhases,
  taxonomyTrades,
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
import { wrappedFactory } from '../test/racing-factory';
import { runPromoteIngest, type PromoteRunCtx } from './promote';
import {
  createAcceptVendorProposalHandler,
  createDeclineVendorProposalHandler,
  createListVendorProposalsHandler,
  PROPOSAL_ACCEPTED_ACTION,
  PROPOSAL_DECLINED_ACTION,
} from './vendor-proposals';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNED = u(1); // Bentley, owns its record
const PARTNER = u(2); // Topcon, unowned co-maker
const OTHER = u(3); // Hexagon, owns its record too
const OWNER = u(100);
const MEMBER = u(101);
const OTHER_OWNER = u(102);
const HOST = u(20); // a live product the proposal extends
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

const rc = (): PromoteRunCtx => ({
  env: { ENV: 'staging' } as Env,
  request: new Request('http://localhost/api/promote'),
  waitUntil: () => {},
  bookmark: () => null,
});

/** Store a proposal through a real promote, and return its id. */
async function propose(
  ref: string,
  product: Record<string, unknown>,
  vendorList = [
    { ref: 'v1', supabaseId: OWNED, companyName: 'Bentley' },
    { ref: 'v2', supabaseId: PARTNER, companyName: 'Topcon' },
  ],
): Promise<string> {
  const { response } = await runPromoteIngest(
    rc(),
    PromotePayloadSchema.parse({ vendors: vendorList, product: { ref, ...product } }),
    {
      dbFor: t.factory,
      syncAlgolia: async () => {},
      notifyIndexNow: async () => {},
      refreshHomeStats: async () => {},
      notifyProposalOwners: async () => {},
    },
  );
  const id = response.skipped.find((s) => s.proposalId)?.proposalId;
  if (!id) throw new Error('promote stored no proposal');
  return id;
}

const FULL = {
  name: 'OpenRoads Designer',
  description: 'Civil design for roads.',
  website: 'https://bentley.example/openroads',
  categories: ['Civil Design', 'Made Up Category'],
  audiences: ['General Contractors'],
  phases: ['Design', 'Unknown Phase'],
  trades: ['Paving', 'not-a-trade'],
  usefulness: {
    audiences: [{ slug: 'general-contractors', points: ['Plans grading.'] }],
    phases: [{ slug: 'no-such-phase', points: ['Dropped.'] }],
  },
  extensionOf: [{ supabaseId: HOST }],
  lastReviewedAt: '2026-01-01T00:00:00.000Z',
};

beforeEach(async () => {
  t = await makeTestDb();
  queueSend = vi.fn(async () => undefined);
  ownershipSend = vi.fn(async () => undefined);
  ownershipSendBatch = vi.fn(async () => undefined);
  vi.mocked(syncIndexTargets).mockClear();
  resetAlgoliaWriteGuardWarning();
  await t.db.insert(vendors).values([
    { id: OWNED, slug: 'bentley', companyName: 'Bentley', ownedAt: OWNED_AT },
    { id: PARTNER, slug: 'topcon', companyName: 'Topcon' },
    { id: OTHER, slug: 'hexagon', companyName: 'Hexagon', ownedAt: OWNED_AT },
  ]);
  await t.db.insert(products).values({
    id: HOST,
    slug: 'microstation',
    name: 'MicroStation',
    promotionStatus: 'promoted',
  });
  await t.db.insert(productVendors).values({ productId: HOST, vendorId: PARTNER, isPrimary: true });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: OWNED, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: OWNED },
    { id: OTHER_OWNER, role: 'vendor_admin', vendorId: OTHER, seatOwner: true },
  ]);
  await t.db
    .insert(taxonomyCategories)
    .values({ id: u(30), slug: 'civil-design', name: 'Civil Design' });
  await t.db
    .insert(taxonomyAudiences)
    .values({ id: u(31), slug: 'general-contractors', name: 'General Contractors' });
  await t.db.insert(taxonomyPhases).values({ id: u(32), slug: 'design', name: 'Design' });
  await t.db.insert(taxonomyTrades).values({
    id: u(33),
    slug: 'paving-asphalt',
    name: 'Paving & Asphalt',
    description: 'Paving.',
    aliases: ['Paving'],
  });
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
  a.get('/api/vendor/proposals', createListVendorProposalsHandler(factory));
  a.post('/api/vendor/proposals/:id/accept', createAcceptVendorProposalHandler(factory));
  a.post('/api/vendor/proposals/:id/decline', createDeclineVendorProposalHandler(factory));
  return a;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonBody = Record<string, any>;

async function call(
  method: 'GET' | 'POST',
  path: string,
  opts: { auth?: AuthzVariables['auth']; factory?: DbFactory } = {},
) {
  const execCtx = fakeExecutionContext();
  const res = await app(opts.auth ?? seat(OWNER, OWNED), opts.factory).request(
    path,
    { method },
    {
      ...ENV,
      CACHE_PURGE_QUEUE: { send: queueSend },
      OWNERSHIP_SYNC_QUEUE: { send: ownershipSend, sendBatch: ownershipSendBatch },
    } as unknown as Env,
    execCtx,
  );
  const body = res.status === 204 ? {} : ((await res.json()) as JsonBody);
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return { status: res.status, body };
}

const list = (opts?: Parameters<typeof call>[2]) => call('GET', '/api/vendor/proposals', opts);
const accept = (id: string, opts?: Parameters<typeof call>[2]) =>
  call('POST', `/api/vendor/proposals/${id}/accept`, opts);
const decline = (id: string, opts?: Parameters<typeof call>[2]) =>
  call('POST', `/api/vendor/proposals/${id}/decline`, opts);

/** The SQL of a batch's statements, lower-cased. */
const sqlOf = (stmts: unknown) =>
  (stmts as Array<{ toSQL(): { sql: string } }>).map((s) => s.toSQL().sql.toLowerCase());
/** The decision batch, told apart from the term-index read batch by its first statement. */
const isDecisionBatch = (stmts: unknown) =>
  /^update "product_proposals"/.test(sqlOf(stmts)[0] ?? '');
/** A factory that runs `before` once, just ahead of the decision batch. */
function raceBeforeDecision(before: () => Promise<unknown>): DbFactory {
  let fired = false;
  return wrappedFactory(t.factory, async (_attempt, run, stmts) => {
    if (!fired && isDecisionBatch(stmts)) {
      fired = true;
      await before();
    }
    return run();
  });
}

const proposalRow = async (id: string) =>
  (await t.db.select().from(productProposals).where(eq(productProposals.id, id)))[0]!;
const audits = () => t.db.select().from(auditLog);

describe('GET /api/vendor/proposals', () => {
  it('lists the open proposals with every vendor and a flag on each value that would drop', async () => {
    const id = await propose('p:recOpenRoads', FULL);
    const { status, body } = await list();
    expect(status).toBe(200);
    const parsed = ListVendorProposalsResponseSchema.parse(body);
    expect(parsed.truncated).toBe(false);
    expect(parsed.proposals).toHaveLength(1);
    const [p] = parsed.proposals;
    expect(p).toMatchObject({
      id,
      product: {
        name: 'OpenRoads Designer',
        description_excerpt: 'Civil design for roads.',
        website: 'https://bentley.example/openroads',
        product_role: 'application',
      },
      vendors: [
        { id: OWNED, name: 'Bentley', is_primary: true, owned: true, exists: true },
        { id: PARTNER, name: 'Topcon', is_primary: false, owned: false, exists: true },
      ],
    });
    expect(p!.terms).toEqual([
      { facet: 'category', value: 'Civil Design', name: 'Civil Design', exists: true },
      { facet: 'category', value: 'Made Up Category', name: null, exists: false },
      {
        facet: 'audience',
        value: 'General Contractors',
        name: 'General Contractors',
        exists: true,
      },
      { facet: 'phase', value: 'Design', name: 'Design', exists: true },
      { facet: 'phase', value: 'Unknown Phase', name: null, exists: false },
      { facet: 'trade', value: 'Paving', name: 'Paving & Asphalt', exists: true },
      { facet: 'trade', value: 'not-a-trade', name: null, exists: false },
      {
        facet: 'usefulness',
        value: 'general-contractors',
        name: 'General Contractors',
        exists: true,
      },
      { facet: 'usefulness', value: 'no-such-phase', name: null, exists: false },
      { facet: 'extension', value: HOST, name: 'MicroStation', exists: true },
    ]);
  });

  it('is empty for a vendor with none, and leaves out decided and other vendors’ proposals', async () => {
    expect((await list()).body).toEqual({ proposals: [], truncated: false });
    const decided = await propose('p:recDecided', { name: 'Decided' });
    await decline(decided);
    await propose('p:recHexagon', { name: 'Leica' }, [
      { ref: 'v1', supabaseId: OTHER, companyName: 'Hexagon' },
    ]);
    expect((await list()).body.proposals).toEqual([]);
    expect((await list({ auth: seat(OTHER_OWNER, OTHER) })).body.proposals).toHaveLength(1);
  });

  it('refuses a member seat', async () => {
    const { status, body } = await list({ auth: seat(MEMBER, OWNED) });
    expect(status).toBe(403);
    expect(body.error.code).toBe(ApiErrorCode.FORBIDDEN);
  });
});

describe('POST /api/vendor/proposals/:id/accept', () => {
  it('creates the product exactly as proposed, existing terms only, in one batch with its audit rows', async () => {
    const id = await propose('p:recOpenRoads', FULL);
    let batchSql: string[] = [];
    const spying = wrappedFactory(t.factory, (_attempt, run, stmts) => {
      if (isDecisionBatch(stmts)) batchSql = sqlOf(stmts);
      return run();
    });
    const termsBefore = {
      categories: await t.db.select().from(taxonomyCategories),
      phases: await t.db.select().from(taxonomyPhases),
    };

    const { status, body } = await accept(id, { factory: spying });

    expect(status).toBe(200);
    const parsed = AcceptVendorProposalResponseSchema.parse(body);
    expect(parsed.proposal_id).toBe(id);
    expect(parsed.product).toMatchObject({
      slug: 'openroads-designer',
      name: 'OpenRoads Designer',
    });
    expect(parsed.dropped).toEqual([
      { facet: 'category', value: 'Made Up Category' },
      { facet: 'phase', value: 'Unknown Phase' },
      { facet: 'trade', value: 'not-a-trade' },
      { facet: 'usefulness', value: 'no-such-phase' },
    ]);
    const pid = parsed.product.id;

    // The product, as sent, vendor-maintained from birth.
    const [product] = await t.db.select().from(products).where(eq(products.id, pid));
    expect(product).toMatchObject({
      name: 'OpenRoads Designer',
      description: 'Civil design for roads.',
      website: 'https://bentley.example/openroads',
      promotionStatus: 'promoted',
      maintainedBy: 'vendor',
    });
    expect(product!.lastReviewedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(product!.promotedAt).toBe(product!.lastReviewedAt);
    expect(product!.usefulness).toEqual({
      audiences: [
        { slug: 'general-contractors', name: 'General Contractors', points: ['Plans grading.'] },
      ],
      phases: [],
    });

    // Every vendor link the payload names, owned and unowned.
    const links = await t.db.select().from(productVendors).where(eq(productVendors.productId, pid));
    expect(links.map((l) => [l.vendorId, l.isPrimary]).sort()).toEqual(
      [
        [OWNED, true],
        [PARTNER, false],
      ].sort(),
    );
    // Existing terms only. Nothing minted.
    expect(
      (await t.db.select().from(productCategories).where(eq(productCategories.productId, pid))).map(
        (r) => r.categoryId,
      ),
    ).toEqual([u(30)]);
    expect(
      (await t.db.select().from(productAudiences).where(eq(productAudiences.productId, pid))).map(
        (r) => r.audienceId,
      ),
    ).toEqual([u(31)]);
    expect(
      (await t.db.select().from(productTrades).where(eq(productTrades.productId, pid))).map(
        (r) => r.tradeId,
      ),
    ).toEqual([u(33)]);
    expect(
      (await t.db.select().from(productExtensions).where(eq(productExtensions.productId, pid))).map(
        (r) => r.hostProductId,
      ),
    ).toEqual([HOST]);
    expect(await t.db.select().from(taxonomyCategories)).toEqual(termsBefore.categories);
    expect(await t.db.select().from(taxonomyPhases)).toEqual(termsBefore.phases);

    // The decision.
    expect(await proposalRow(id)).toMatchObject({
      decision: 'accepted',
      decidedBy: OWNER,
      createdProductId: pid,
    });

    // One batch: decision, its sentinel, the ownership sentinel, product, joins, audits.
    expect(batchSql[0]).toMatch(/^update "product_proposals"/);
    expect(batchSql[1]).toMatch(/changes\(\)/);
    expect(batchSql[3]).toMatch(/^insert into "products"/);
    expect(batchSql.filter((s) => /insert into "audit_log"/.test(s))).toHaveLength(2);
    const rows = await audits();
    expect(rows.find((r) => r.action === PROPOSAL_ACCEPTED_ACTION)).toMatchObject({
      entityType: 'product_proposal',
      entityId: id,
      actorId: OWNER,
      vendorId: OWNED,
    });
    expect(rows.find((r) => r.action === 'product.created' && r.entityId === pid)).toMatchObject({
      actorId: OWNER,
      vendorId: OWNED,
      productId: pid,
    });

    // Post-commit: the promote purge set for a created product, and the Algolia sync.
    const tags = queueSend.mock.calls.flatMap((c) => (c[0] as { tags: string[] }).tags);
    expect(tags).toEqual(
      expect.arrayContaining([
        'product:openroads-designer',
        'index:products',
        'sitemap',
        'vendor:bentley',
        'vendor:topcon',
        'category:civil-design',
        'audience:general-contractors',
        'phase:design',
        'trade:paving-asphalt',
        'index:trades',
        'taxonomy',
        'product:microstation',
      ]),
    );
    expect(vi.mocked(syncIndexTargets)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(syncIndexTargets).mock.calls[0]![4]).toEqual({
      products: [pid],
      vendors: [OWNED, PARTNER],
      integrations: [],
    });
  });

  it('suffixes a colliding slug with the first vendor’s slug, as promote does', async () => {
    await t.db.insert(products).values({ id: u(21), slug: 'openroads', name: 'OpenRoads' });
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    const { body } = await accept(id);
    expect(body.product.slug).toBe('openroads-bentley');
  });

  it('refuses a decided proposal and writes nothing', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    await decline(id);
    const before = await t.db.select().from(products);
    const { status, body } = await accept(id);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.PROPOSAL_ALREADY_DECIDED);
    expect(await t.db.select().from(products)).toEqual(before);
  });

  it('refuses when the addressed vendor no longer owns its record', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    await t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, OWNED));
    const { status, body } = await accept(id);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.VENDOR_NOT_OWNED);
    expect((await proposalRow(id)).decision).toBeNull();
  });

  it('refuses when a linked vendor is gone, rather than create a half-linked product', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    await t.db.delete(productVendors).where(eq(productVendors.vendorId, PARTNER));
    await t.db.delete(vendors).where(eq(vendors.id, PARTNER));
    const before = await t.db.select().from(products);
    const { status, body } = await accept(id);
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.PROPOSAL_VENDOR_MISSING);
    expect(body.error.details).toEqual({ vendor_ids: [PARTNER] });
    expect(await t.db.select().from(products)).toEqual(before);
    expect((await proposalRow(id)).decision).toBeNull();
  });

  it('refuses a member seat', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    const { status } = await accept(id, { auth: seat(MEMBER, OWNED) });
    expect(status).toBe(403);
    expect((await proposalRow(id)).decision).toBeNull();
  });

  it('answers 404 for another vendor’s proposal, as for none', async () => {
    const theirs = await propose('p:recLeica', { name: 'Leica' }, [
      { ref: 'v1', supabaseId: OTHER, companyName: 'Hexagon' },
    ]);
    const { status, body } = await accept(theirs);
    expect(status).toBe(404);
    expect(body.error.code).toBe(ApiErrorCode.NOT_FOUND);
    expect((await accept(u(999))).status).toBe(404);
    expect((await proposalRow(theirs)).decision).toBeNull();
  });

  it('a decision that lands between the read and the batch writes nothing and answers 409', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    const racing = raceBeforeDecision(() =>
      t.db
        .update(productProposals)
        .set({ decision: 'declined', decidedAt: OWNED_AT, decidedBy: OWNER })
        .where(eq(productProposals.id, id)),
    );
    const before = await t.db.select().from(products);
    const { status, body } = await accept(id, { factory: racing });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.PROPOSAL_ALREADY_DECIDED);
    expect(await t.db.select().from(products)).toEqual(before);
    expect((await audits()).some((r) => r.action === PROPOSAL_ACCEPTED_ACTION)).toBe(false);
    // AECI-1418: a failed batch tells the review app nothing.
    expect(ownershipSend).not.toHaveBeenCalled();
  });

  it('a committed accept enqueues one proposal_accepted message per owned vendor: one owner, one send (AECI-1418)', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    expect((await accept(id)).status).toBe(200);
    // PARTNER is named on the product but unowned, so it gets nothing.
    expect(ownershipSendBatch).not.toHaveBeenCalled();
    expect(ownershipSend).toHaveBeenCalledTimes(1);
    expect(ownershipSend).toHaveBeenCalledWith({
      vendorId: OWNED,
      reason: 'proposal_accepted',
      enqueuedAt: expect.any(String),
    });
  });

  it('an accept naming two owned vendors enqueues one message each, as one sendBatch (ruled 2026-10-20, D3)', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' }, [
      { ref: 'v1', supabaseId: OWNED, companyName: 'Bentley' },
      { ref: 'v2', supabaseId: PARTNER, companyName: 'Topcon' },
      { ref: 'v3', supabaseId: OTHER, companyName: 'Hexagon' },
    ]);
    expect((await accept(id)).status).toBe(200);
    expect(ownershipSend).not.toHaveBeenCalled();
    expect(ownershipSendBatch).toHaveBeenCalledTimes(1);
    const bodies = (ownershipSendBatch.mock.calls[0]![0] as { body: { vendorId: string } }[]).map(
      (m) => m.body,
    );
    expect(bodies.map((b) => b.vendorId).sort()).toEqual([OWNED, OTHER].sort());
    expect(
      bodies.every((b) => (b as unknown as { reason: string }).reason === 'proposal_accepted'),
    ).toBe(true);
  });

  it('a return to AECi that lands between the read and the batch writes nothing', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    const racing = raceBeforeDecision(() =>
      t.db.update(vendors).set({ ownedAt: null }).where(eq(vendors.id, OWNED)),
    );
    const { status, body } = await accept(id, { factory: racing });
    expect(status).toBe(409);
    expect(body.error.code).toBe(ApiErrorCode.VENDOR_NOT_OWNED);
    expect((await proposalRow(id)).decision).toBeNull();
  });
});

describe('POST /api/vendor/proposals/:id/decline', () => {
  it('records the decision and its audit row, and nothing else', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    const before = await t.db.select().from(products);
    const { status } = await decline(id);
    expect(status).toBe(204);
    expect(await proposalRow(id)).toMatchObject({
      decision: 'declined',
      decidedBy: OWNER,
      createdProductId: null,
    });
    expect((await proposalRow(id)).decidedAt).not.toBeNull();
    expect(await t.db.select().from(products)).toEqual(before);
    expect((await audits()).find((r) => r.action === PROPOSAL_DECLINED_ACTION)).toMatchObject({
      entityType: 'product_proposal',
      entityId: id,
      actorId: OWNER,
      vendorId: OWNED,
    });
    expect(queueSend).not.toHaveBeenCalled();
    expect(vi.mocked(syncIndexTargets)).not.toHaveBeenCalled();
    // AECI-1418: the review app learns the decline, once.
    expect(ownershipSend).toHaveBeenCalledTimes(1);
    expect(ownershipSend).toHaveBeenCalledWith(
      expect.objectContaining({ vendorId: OWNED, reason: 'proposal_declined' }),
    );
  });

  it('refuses a decided proposal, a member seat, and another vendor’s proposal', async () => {
    const id = await propose('p:recOpenRoads', { name: 'OpenRoads' });
    expect((await decline(id, { auth: seat(MEMBER, OWNED) })).status).toBe(403);
    expect((await decline(id, { auth: seat(OTHER_OWNER, OTHER) })).status).toBe(404);
    expect((await decline(id)).status).toBe(204);
    const again = await decline(id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe(ApiErrorCode.PROPOSAL_ALREADY_DECIDED);
    expect((await audits()).filter((r) => r.action === PROPOSAL_DECLINED_ACTION)).toHaveLength(1);
  });
});
