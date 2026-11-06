/**
 * The removal election's two routes (AECI-1618, `STAGE_2_5_SPEC.md` §12.2), against the
 * real-SQLite harness. A stub middleware sets the `auth` Variable.
 */

import { ApiErrorCode, RemovalElectionResponseSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../posthog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../posthog')>()),
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
}));

import {
  auditLog,
  fieldOverrides,
  products,
  productTrades,
  productVendors,
  profiles,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { seedLicense } from '../test/licenses';
import {
  createGetRemovalElectionHandler,
  createRemovalElectionHandler,
} from './vendor-removal-election';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(1);
const PRODUCT = u(11);
const OWNER = u(100);
const MEMBER = u(101);
const ENDED = '2026-10-01T23:30:00.000Z';
const URL_PATH = `/api/vendor/products/${PRODUCT}/removal-election`;

let t: TestDb;
let send: ReturnType<typeof vi.fn>;

function app(userId = OWNER) {
  const hono = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  hono.onError(errorHandler());
  hono.use('*', async (c, next) => {
    c.set('auth', {
      userId,
      email: 'seat@example.test',
      role: 'vendor_admin',
      vendorId: VENDOR,
      entitlementTier: 'unclaimed',
      entitlement: null,
    } as never);
    await next();
  });
  hono.get(URL_PATH.replace(PRODUCT, ':id'), createGetRemovalElectionHandler(t.factory));
  hono.post(URL_PATH.replace(PRODUCT, ':id'), createRemovalElectionHandler(t.factory));
  return hono;
}

const env = () => ({ ENV: 'staging', CACHE_PURGE_QUEUE: { send } }) as unknown as Env;
const get = (userId = OWNER) => app(userId).request(URL_PATH, {}, env(), fakeExecutionContext());
const post = (userId = OWNER) =>
  app(userId).request(
    URL_PATH,
    { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
    env(),
    fakeExecutionContext(),
  );
const code = async (res: Response) =>
  ((await res.json()) as { error: { code: string } }).error.code;
const product = async () =>
  (await t.db.select().from(products).where(eq(products.id, PRODUCT)))[0]!;

/** A vendor seat's save, as `PATCH /api/vendor/products/:id` records it. */
async function vendorWrote(after: Record<string, unknown>, id = 200) {
  await t.db.insert(auditLog).values({
    id: u(id),
    actorId: OWNER,
    actorType: 'user',
    action: 'product.updated',
    entityType: 'product',
    entityId: PRODUCT,
    afterState: after,
    metadata: { source: 'vendor-portal', vendorId: VENDOR, fields: Object.keys(after) },
    createdAt: `2026-09-01T00:00:${String(id % 60).padStart(2, '0')}.000Z`,
  });
}

beforeEach(async () => {
  t = await makeTestDb();
  send = vi.fn(async () => undefined);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T12:00:00.000Z'));
  await t.db.insert(vendors).values({
    id: VENDOR,
    slug: 'acme',
    companyName: 'Acme',
    ownedAt: '2026-01-01T00:00:00.000Z',
  });
  await t.db.insert(products).values({
    id: PRODUCT,
    slug: 'widget',
    name: 'Widget',
    description: 'We wrote this.',
    toolIntegrationsUrl: 'https://acme.example/integrations',
    apiDocsUrl: 'https://acme.example/api',
    usefulness: { audiences: [], phases: [] },
    usefulnessSource: 'vendor',
    maintainedBy: 'vendor',
  });
  await t.db
    .insert(productVendors)
    .values({ productId: PRODUCT, vendorId: VENDOR, isPrimary: true });
  await t.db.insert(profiles).values([
    { id: OWNER, role: 'vendor_admin', vendorId: VENDOR, seatOwner: true },
    { id: MEMBER, role: 'vendor_admin', vendorId: VENDOR },
  ]);
  await vendorWrote({
    description: 'We wrote this.',
    toolIntegrationsUrl: 'https://acme.example/integrations',
    apiDocsUrl: 'https://acme.example/api',
  });
  await seedLicense(t.db, VENDOR, { productId: PRODUCT, endedAt: ENDED, endReason: 'lapsed' });
});

afterEach(() => {
  vi.useRealTimers();
  t.dispose();
});

describe('GET', () => {
  it('names the eligible fields and the end of the 30th UTC day', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(RemovalElectionResponseSchema.parse(await res.json())).toEqual({
      eligible_fields: ['description', 'usefulness', 'tool_integrations_url', 'api_docs_url'],
      closes_at: '2026-10-31T23:59:59.999Z',
      elected_at: null,
    });
  });

  it('is empty with a null close when no window is open, for any seat', async () => {
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
    expect(await (await get(MEMBER)).json()).toEqual({
      eligible_fields: [],
      closes_at: null,
      elected_at: null,
    });
  });

  it('answers 404 for a product the vendor does not hold', async () => {
    await t.db.delete(productVendors);
    expect((await get()).status).toBe(404);
  });
});

describe('POST: the window', () => {
  it('is open on day 30, to the last UTC millisecond', async () => {
    vi.setSystemTime(new Date('2026-10-31T23:59:59.999Z'));
    expect((await post()).status).toBe(200);
  });

  it('is closed on day 31', async () => {
    vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
    const res = await post();
    expect(res.status).toBe(409);
    expect(await code(res)).toBe(ApiErrorCode.REMOVAL_ELECTION_CLOSED);
    expect((await product()).description).toBe('We wrote this.');
  });

  it('is closed while the product holds a live license', async () => {
    await seedLicense(t.db, VENDOR, { productId: PRODUCT });
    expect(await code(await post())).toBe(ApiErrorCode.REMOVAL_ELECTION_CLOSED);
  });

  it('is closed for a product that never had a plan', async () => {
    await t.db.update(products).set({ slug: 'widget' });
    t.raw.prepare('DELETE FROM licenses').run();
    expect(await code(await post())).toBe(ApiErrorCode.REMOVAL_ELECTION_CLOSED);
  });

  it('is refused after a termination', async () => {
    t.raw.prepare("UPDATE licenses SET end_reason = 'banned'").run();
    const res = await post();
    expect(res.status).toBe(409);
    expect(await code(res)).toBe(ApiErrorCode.REMOVAL_ELECTION_CLOSED);
  });
});

describe('POST: who and what', () => {
  it('refuses a member seat, after the ownership check', async () => {
    expect((await post(MEMBER)).status).toBe(403);
    expect((await product()).description).toBe('We wrote this.');
  });

  it('blanks the text, with the audit row in the batch and the purge after it', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      removed_fields: ['description', 'usefulness', 'tool_integrations_url', 'api_docs_url'],
      elected_at: '2026-10-10T12:00:00.000Z',
    });
    expect(batchSpy).toHaveBeenCalledTimes(1);
    expect(await product()).toMatchObject({
      description: null,
      usefulness: null,
      toolIntegrationsUrl: null,
      apiDocsUrl: null,
      // These stay, so promote cannot refill the fields.
      usefulnessSource: 'vendor',
      maintainedBy: 'vendor',
      updatedAt: '2026-10-10T12:00:00.000Z',
    });
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'product.authored_content_removed'));
    expect(row).toMatchObject({ vendorId: VENDOR, productId: PRODUCT, actorId: OWNER });
    expect(row!.beforeState).toMatchObject({ description: 'We wrote this.' });
    expect(row!.afterState).toMatchObject({ description: null });
    expect(send).toHaveBeenCalledWith({
      tags: ['product:widget', 'vendor:acme', 'index:products'],
      source: 'vendor',
    });
  });

  it('skips a field with an active AECi lock', async () => {
    await t.db.insert(fieldOverrides).values({
      id: u(300),
      entityType: 'product',
      entityId: PRODUCT,
      field: 'api_docs_url',
      value: 'https://aeci.example/docs',
      reason: 'Corrected',
      setAt: '2026-09-02T00:00:00.000Z',
    });
    const res = await post();
    expect(((await res.json()) as { removed_fields: string[] }).removed_fields).not.toContain(
      'api_docs_url',
    );
    expect((await product()).apiDocsUrl).toBe('https://acme.example/api');
  });

  it('leaves a promote-written field alone: no vendor row wrote it', async () => {
    t.raw.prepare('DELETE FROM audit_log').run();
    await vendorWrote({ apiDocsUrl: 'https://acme.example/api' });
    await post();
    expect(await product()).toMatchObject({
      description: 'We wrote this.',
      toolIntegrationsUrl: 'https://acme.example/integrations',
      apiDocsUrl: null,
    });
  });

  it('leaves a field someone rewrote after the vendor saved it', async () => {
    await t.db
      .update(products)
      .set({ description: 'AECi rewrote this.' })
      .where(eq(products.id, PRODUCT));
    await post();
    expect((await product()).description).toBe('AECi rewrote this.');
  });

  it('leaves promote-written usefulness alone', async () => {
    await t.db.update(products).set({ usefulnessSource: null }).where(eq(products.id, PRODUCT));
    await post();
    expect((await product()).usefulness).not.toBeNull();
  });

  it('never touches tags', async () => {
    await t.db
      .insert(taxonomyTrades)
      .values({ id: u(400), slug: 'roofing', name: 'Roofing', description: 'Roofs.' });
    await t.db.insert(productTrades).values({ productId: PRODUCT, tradeId: u(400) });
    await post();
    expect(await t.db.select().from(productTrades)).toHaveLength(1);
  });

  it('answers EMPTY once nothing qualifies, and GET reports the election', async () => {
    expect((await post()).status).toBe(200);
    const again = await post();
    expect(again.status).toBe(409);
    expect(await code(again)).toBe(ApiErrorCode.REMOVAL_ELECTION_EMPTY);
    expect(await (await get()).json()).toMatchObject({
      eligible_fields: [],
      elected_at: expect.any(String),
    });
  });

  it('a license granted after the reads aborts the batch', async () => {
    const batch = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementation((async (stmts: never) => {
      await seedLicense(t.db, VENDOR, { productId: PRODUCT });
      return batch(stmts);
    }) as never);
    const res = await post();
    expect(res.status).toBe(409);
    expect(await code(res)).toBe(ApiErrorCode.REMOVAL_ELECTION_CLOSED);
    expect((await product()).description).toBe('We wrote this.');
  });
});
