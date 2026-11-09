/**
 * Promote and the listing hide (AECI-1238, `REVIEW_APP_PROMOTE_API.md` §4a).
 *
 * A NEW product joined to a hidden company is skipped at plan time with the
 * `VENDOR_HIDDEN` reason, and every edge through it is skipped too. Promote never
 * writes `hidden_*`: a hidden product it updates stays hidden. The ledger rules are
 * untouched.
 */

import { PromotePayloadSchema } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, productVendors, products, vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  runPromoteIngest,
  VENDOR_HIDDEN_INTEGRATION_REASON,
  VENDOR_HIDDEN_REASON,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';

const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const HIDDEN = uuid(10); // AECi-held, hidden
const LIVE = uuid(11);
const P_LIVE = uuid(20);
const P_HIDDEN = uuid(21); // hidden with HIDDEN
const HIDDEN_AT = '2026-11-01T00:00:00.000Z';

let t: TestDb;

const rc = (): PromoteRunCtx => ({
  env: { ENV: 'staging' } as Env,
  request: new Request('http://localhost:8787/api/promote'),
  waitUntil: () => {},
  bookmark: () => null,
});
const deps = (): PromoteIngestDeps => ({
  dbFor: t.factory,
  syncAlgolia: async () => {},
  notifyIndexNow: async () => {},
  refreshHomeStats: async () => {},
});
const ingest = (body: unknown, jobId: string) =>
  runPromoteIngest(rc(), PromotePayloadSchema.parse(body), deps(), { jobId });

beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(vendors).values([
    {
      id: HIDDEN,
      slug: 'gone-co',
      companyName: 'Gone Co',
      hiddenAt: HIDDEN_AT,
      hiddenHideId: uuid(30),
    },
    { id: LIVE, slug: 'acme', companyName: 'Acme' },
  ]);
  await t.db.insert(products).values([
    { id: P_LIVE, slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    {
      id: P_HIDDEN,
      slug: 'gone-tool',
      name: 'Gone Tool',
      promotionStatus: 'promoted',
      hiddenAt: HIDDEN_AT,
      hiddenHideId: uuid(31),
    },
  ]);
  await t.db.insert(productVendors).values([
    { productId: P_LIVE, vendorId: LIVE, isPrimary: true },
    { productId: P_HIDDEN, vendorId: HIDDEN, isPrimary: true },
  ]);
});
afterEach(() => t.dispose());

describe('promote under a hidden company (AECI-1238)', () => {
  it('skips a new product joined to a hidden company, and its edges, with VENDOR_HIDDEN', async () => {
    const before = (await t.db.select().from(products)).length;
    const { response } = await ingest(
      {
        vendors: [{ ref: 'v1', supabaseId: HIDDEN, companyName: 'Gone Co' }],
        product: { ref: 'p:recNew01', name: 'New Tool', description: 'New.' },
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { ref: 'p:recNew01' },
            targetProduct: { supabaseId: P_LIVE },
          },
        ],
      },
      'job-hidden-new',
    );
    expect(response.product).toBeNull();
    expect(response.skipped).toEqual(
      expect.arrayContaining([
        { ref: 'p:recNew01', kind: 'product', reason: VENDOR_HIDDEN_REASON },
        { ref: 'i1', kind: 'integration', reason: VENDOR_HIDDEN_INTEGRATION_REASON },
      ]),
    );
    expect(VENDOR_HIDDEN_REASON.startsWith('VENDOR_HIDDEN:')).toBe(true);
    expect((await t.db.select().from(products)).length).toBe(before);
    const blocked = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'promote.blocked'));
    expect(blocked.map((r) => r.metadata)).toEqual(
      expect.arrayContaining([expect.objectContaining({ cause: 'vendor-hidden' })]),
    );
  });

  it('never writes hidden_*: a hidden product it updates stays hidden', async () => {
    await ingest(
      {
        vendors: [{ ref: 'v1', supabaseId: HIDDEN, companyName: 'Gone Co' }],
        product: {
          ref: 'p:recGone',
          supabaseId: P_HIDDEN,
          name: 'Gone Tool',
          description: 'Edited.',
        },
      },
      'job-hidden-update',
    );
    const row = (await t.db.query.products.findFirst({ where: eq(products.id, P_HIDDEN) }))!;
    expect(row.description).toBe('Edited.');
    expect(row).toMatchObject({ hiddenAt: HIDDEN_AT, hiddenHideId: uuid(31) });
    const company = (await t.db.query.vendors.findFirst({ where: eq(vendors.id, HIDDEN) }))!;
    expect(company.hiddenAt).toBe(HIDDEN_AT);
  });

  it('creates a new product for a visible company as before', async () => {
    const { response } = await ingest(
      {
        vendors: [{ ref: 'v1', supabaseId: LIVE, companyName: 'Acme' }],
        product: { ref: 'p:recAcme', name: 'Acme Field', description: 'Field.' },
      },
      'job-live-new',
    );
    expect(response.product?.operation).toBe('created');
    expect(response.skipped.filter((s) => s.kind === 'product')).toEqual([]);
  });
});
