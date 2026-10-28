/**
 * Vendor-portal post-commit tail — connection hygiene (AECI-666).
 *
 * `afterVendorWrite` runs after EVERY vendor write. It used to be
 * `Promise.all([purgeTags(…), ...entries.map(forwardAuditLog)])`, and because
 * the §3.1 dual-run fans `logToPosthog` out to PostHog AND Datadog, a write that
 * emits N audit rows — AECI-301's `POST /api/vendor/claims` writes a
 * `claim.created` plus one `attestation.created` per owned slot — opened 2N
 * simultaneous connections from one invocation, alongside the queue send sitting
 * in the same array. A Worker invocation may hold only a bounded number; past
 * the limit the runtime cancels the stalled responses into `fetch` promises that
 * never settle, so the forwards are lost with no error at all.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../db/client';
import { profiles, vendors } from '../db/schema';
import type { Env } from '../env';
import type { AuthzVariables, SessionLicense } from '../lib/authz';
import { enqueueGscRecrawlUrls } from '../lib/gsc-recrawl-queue';
import { enqueueIndexNowUrls } from '../lib/indexnow-queue';
import { enqueueRecrawlCauses } from '../lib/recrawl-causes';
import { logBatchToPosthog, submitCount } from '../posthog';
import { SITEMAP_DIRTY_KEY } from '../lib/sitemap-store';
import { makeTestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import { memoryKv } from '../test/memory-kv';
import {
  afterVendorWrite,
  AUDIT_SOURCE,
  ownerSeatsOf,
  ownedSideProductId,
  seatsOf,
  sessionProductPlan,
  stampCauseProductPlan,
  vendorAuditEntry,
  vendorProductRecrawlEnabled,
  vendorRecrawlEnabled,
  withRecrawlProduct,
  type VendorContext,
  type VendorRecrawl,
} from './vendor-shared';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

vi.mock('../lib/indexnow-queue', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/indexnow-queue')>()),
  enqueueIndexNowUrls: vi.fn().mockResolvedValue(1),
}));
vi.mock('../lib/gsc-recrawl-queue', () => ({
  enqueueGscRecrawlUrls: vi.fn().mockResolvedValue({
    touched: 1,
    urls: ['https://www.aecintegrations.com/products/revit'],
  }),
}));
vi.mock('../lib/recrawl-causes', () => ({
  enqueueRecrawlCauses: vi.fn().mockResolvedValue(1),
}));

function entry(n: number): AuditLogEntry {
  return {
    actorId: null,
    actorType: 'user',
    action: n === 0 ? 'claim.created' : 'attestation.created',
    entityType: n === 0 ? 'claim' : 'attestation',
    entityId: `entity-${n}`,
  };
}

function makeCtx(env: Partial<Env> = {}, auth?: Partial<AuthzVariables['auth']>) {
  const execCtx = fakeExecutionContext();
  const sendBatch = vi.fn().mockResolvedValue(undefined);
  const send = vi.fn().mockResolvedValue(undefined);
  const c = {
    env: { ENV: 'staging', ...env } as Env,
    executionCtx: execCtx,
    req: { raw: new Request('http://localhost:8787/api/vendor/claims') },
    get: (key: string) => (key === 'auth' ? auth : undefined),
  } as unknown as VendorContext;
  return { c, execCtx, send, sendBatch };
}

beforeEach(() => vi.mocked(logBatchToPosthog).mockClear());

describe('afterVendorWrite', () => {
  it('forwards N audit entries in ONE batched call, not N', () => {
    const { c } = makeCtx();

    afterVendorWrite(c, [], [entry(0), entry(1), entry(2), entry(3)]);

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3]).toHaveLength(4);
  });

  it('accepts a bare entry as well as an array', () => {
    const { c } = makeCtx();

    afterVendorWrite(c, [], entry(0));

    expect(vi.mocked(logBatchToPosthog).mock.calls[0][3]).toEqual([
      {
        level: 'info',
        message: 'audit claim.created entity-0',
        action: 'claim.created',
        entity_type: 'claim',
        entity_id: 'entity-0',
        source: AUDIT_SOURCE,
      },
    ]);
  });

  it('dispatches with no vendor key configured — each leg self-gates', () => {
    // The old forwarder returned `undefined` (dropping every forward) unless
    // `POSTHOG_PROJECT_KEY` was set. The transport gates itself
    // now, so the call site must not re-add that.
    const { c } = makeCtx();

    afterVendorWrite(c, [], entry(0));

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });

  it('still enqueues the cache purge, on its own waitUntil task', async () => {
    const { c, execCtx, sendBatch, send } = makeCtx();
    (c.env as Env).CACHE_PURGE_QUEUE = { send, sendBatch } as unknown as Env['CACHE_PURGE_QUEUE'];

    afterVendorWrite(c, ['product:revit'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(send).toHaveBeenCalledWith({ tags: ['product:revit'], source: 'vendor' });
  });

  // AECI-1505: the sitemap is rebuilt by its cron, not purged by a writer.
  it('marks sitemap:dirty instead of queueing the sitemap tag', async () => {
    const { c, execCtx, sendBatch, send } = makeCtx();
    const kv = memoryKv();
    (c.env as Env).CACHE_PURGE_QUEUE = { send, sendBatch } as unknown as Env['CACHE_PURGE_QUEUE'];
    (c.env as Env).TAXONOMY_KV = kv.kv;

    afterVendorWrite(c, ['product:revit', 'taxonomy', 'sitemap'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(send).toHaveBeenCalledWith({ tags: ['product:revit', 'taxonomy'], source: 'vendor' });
    expect(kv.store.get(SITEMAP_DIRTY_KEY)?.value).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('sends nothing when the sitemap was the only tag, and still marks it dirty', async () => {
    const { c, execCtx, sendBatch, send } = makeCtx();
    const kv = memoryKv();
    (c.env as Env).CACHE_PURGE_QUEUE = { send, sendBatch } as unknown as Env['CACHE_PURGE_QUEUE'];
    (c.env as Env).TAXONOMY_KV = kv.kv;

    afterVendorWrite(c, ['sitemap'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(send).not.toHaveBeenCalled();
    expect(kv.store.has(SITEMAP_DIRTY_KEY)).toBe(true);
  });

  it('no-ops the purge without a queue binding, and still forwards', async () => {
    const { c, execCtx } = makeCtx();

    afterVendorWrite(c, ['product:revit'], entry(0));
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    expect(logBatchToPosthog).toHaveBeenCalledTimes(1);
  });
});

// ─── AECI-1186: search-engine submission is Managed-only ────────────────────

describe('afterVendorWrite — the re-crawl plan gate (AECI-1186)', () => {
  const PUBLIC: Partial<Env> = {
    INDEXNOW_KEY: 'test-key',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };
  const FREE = { entitlementTier: 'unclaimed', entitlement: null } as const;
  const MANAGED = {
    entitlementTier: 'verified',
    entitlement: { status: 'active', periodEnd: null },
    // Per product since the 2026-10-14 ruling: `product-1` holds the live license.
    licensedProductIds: ['product-1'],
  } as const;
  const RECRAWL: VendorRecrawl = {
    indexNow: ['https://www.aecintegrations.com/products/revit'],
    gsc: [{ url: 'https://www.aecintegrations.com/products/revit', reason: 'product.updated' }],
  };
  const db = {} as Db;

  beforeEach(() => {
    vi.mocked(enqueueIndexNowUrls).mockClear();
    vi.mocked(enqueueGscRecrawlUrls).mockClear();
    vi.mocked(enqueueRecrawlCauses).mockClear();
    vi.mocked(submitCount).mockClear();
  });

  async function run(
    auth: Partial<AuthzVariables['auth']>,
    origin?: Parameters<typeof afterVendorWrite>[5],
    recrawl: VendorRecrawl | Promise<VendorRecrawl> = RECRAWL,
  ) {
    const { c, execCtx } = makeCtx(PUBLIC, auth);
    afterVendorWrite(c, [], entry(0), recrawl, db, origin);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));
  }

  it('buffers nothing into either queue for a vendor write with no active entitlement', async () => {
    await run(FREE);
    expect(enqueueIndexNowUrls).not.toHaveBeenCalled();
    // Decision 4 of AECI-1182 (2026-10-02): the Google worklist is Managed-only too.
    expect(enqueueGscRecrawlUrls).not.toHaveBeenCalled();
    expect(enqueueRecrawlCauses).not.toHaveBeenCalled();
    expect(submitCount).not.toHaveBeenCalled();
  });

  it('buffers both legs as before for a vendor write with an active entitlement', async () => {
    await run(MANAGED);
    expect(enqueueIndexNowUrls).toHaveBeenCalledTimes(1);
    expect(vi.mocked(enqueueIndexNowUrls).mock.calls[0][2]).toBe('vendor');
    expect(enqueueGscRecrawlUrls).toHaveBeenCalledWith(db, RECRAWL.gsc, 'vendor');
  });

  it('keeps an AECi admin write ungated, though its session carries no entitlement', async () => {
    // The admin retire shares this tail with a `NO_ENTITLEMENT` session. Gating
    // on the session alone would silently drop AECi's own re-crawls.
    await run(FREE, { auditSource: 'admin-moderation', purgeSource: 'moderation' });
    expect(enqueueIndexNowUrls).toHaveBeenCalledTimes(1);
    expect(enqueueGscRecrawlUrls).toHaveBeenCalledTimes(1);
  });

  // ── AECI-1184: the cause each queued URL is recorded under ─────────────────

  it('records a vendor cause naming the first audit entry, the vendor and the product', async () => {
    const { c, execCtx } = makeCtx(PUBLIC, { ...MANAGED, vendorId: 'vendor-1' });
    const first = { ...entry(0), id: 'audit-first' };
    afterVendorWrite(
      c,
      [],
      [first, { ...entry(1), id: 'audit-second' }],
      { ...RECRAWL, productId: 'product-1' },
      db,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((call) => call[0]));

    const cause = {
      source: 'vendor',
      auditLogId: 'audit-first',
      vendorId: 'vendor-1',
      productId: 'product-1',
      promoteJobId: null,
    };
    expect(enqueueRecrawlCauses).toHaveBeenCalledWith(db, 'indexnow', RECRAWL.indexNow, cause);
    // The URLs the worklist reports it took, not the list handed in.
    expect(enqueueRecrawlCauses).toHaveBeenCalledWith(
      db,
      'gsc',
      ['https://www.aecintegrations.com/products/revit'],
      cause,
    );
  });

  it('records an admin-origin cause with no vendor, even when the session names one', async () => {
    await run(
      { ...FREE, vendorId: 'vendor-1' },
      { auditSource: 'admin-moderation', purgeSource: 'moderation' },
    );
    for (const call of vi.mocked(enqueueRecrawlCauses).mock.calls) {
      expect(call[3]).toMatchObject({ source: 'admin', vendorId: null, productId: null });
    }
    expect(enqueueRecrawlCauses).toHaveBeenCalledTimes(2);
  });

  it('writes no gsc cause when the worklist took no URL', async () => {
    vi.mocked(enqueueGscRecrawlUrls).mockResolvedValueOnce({ touched: 0, urls: [] });
    await run(MANAGED);
    expect(vi.mocked(enqueueRecrawlCauses).mock.calls.map((call) => call[1])).toEqual(['indexnow']);
  });

  it('a throwing cause write settles quietly and leaves the queue writes made', async () => {
    vi.mocked(enqueueRecrawlCauses).mockRejectedValue(new Error('D1 down'));
    try {
      await expect(run(MANAGED)).resolves.toBeUndefined();
      expect(enqueueIndexNowUrls).toHaveBeenCalledTimes(1);
      expect(enqueueGscRecrawlUrls).toHaveBeenCalledTimes(1);
      // The gsc leg still ran after the IndexNow cause failed.
      expect(enqueueRecrawlCauses).toHaveBeenCalledTimes(2);
    } finally {
      vi.mocked(enqueueRecrawlCauses).mockResolvedValue(1);
    }
  });

  it('records the product a write names', async () => {
    await run(MANAGED, undefined, withRecrawlProduct(Promise.resolve(RECRAWL), 'product-1')!);
    for (const call of vi.mocked(enqueueRecrawlCauses).mock.calls) {
      expect(call[3]).toMatchObject({ productId: 'product-1' });
    }
    expect(enqueueRecrawlCauses).toHaveBeenCalledTimes(2);
  });

  // ── Ruled 2026-10-14: resubmission is per product ─────────────────────────

  it('buffers nothing for a write naming a product the vendor did not license', async () => {
    // The vendor holds a live license (vendor-level tier paid), but on another product.
    await run({ ...MANAGED, licensedProductIds: ['product-2'] }, undefined, {
      ...RECRAWL,
      productId: 'product-1',
    });
    expect(enqueueIndexNowUrls).not.toHaveBeenCalled();
    expect(enqueueGscRecrawlUrls).not.toHaveBeenCalled();
    expect(enqueueRecrawlCauses).not.toHaveBeenCalled();
  });

  it('keeps a write naming no product (a profile edit) on the vendor-level gate', async () => {
    await run({ ...MANAGED, licensedProductIds: [] }, undefined, { ...RECRAWL, productId: null });
    expect(enqueueIndexNowUrls).toHaveBeenCalledTimes(1);
    expect(enqueueGscRecrawlUrls).toHaveBeenCalledTimes(1);
  });

  it('settles a rejected derivation handed over by a Free write', async () => {
    const rejected = Promise.reject(new Error('trade floor read failed'));
    await expect(run(FREE, undefined, rejected)).resolves.toBeUndefined();
    expect(enqueueIndexNowUrls).not.toHaveBeenCalled();
  });
});

describe('vendorRecrawlEnabled', () => {
  const PUBLIC: Partial<Env> = {
    INDEXNOW_KEY: 'test-key',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };

  it.each([
    ['public env, active entitlement', PUBLIC, 'verified', true],
    ['public env, no entitlement', PUBLIC, 'unclaimed', false],
    ['gated env, active entitlement', {}, 'verified', false],
    ['gated env, no entitlement', {}, 'unclaimed', false],
  ] as const)('%s → %s', (_label, env, entitlementTier, expected) => {
    const { c } = makeCtx(env, { entitlementTier, entitlement: null });
    expect(vendorRecrawlEnabled(c)).toBe(expected);
  });
});

describe('vendorProductRecrawlEnabled (ruled 2026-10-14)', () => {
  const PUBLIC: Partial<Env> = {
    INDEXNOW_KEY: 'test-key',
    PUBLIC_SITE_URL: 'https://www.aecintegrations.com',
  };
  const PAID = { entitlementTier: 'verified', entitlement: null } as const;

  it.each([
    ['public env, the product licensed', PUBLIC, ['p1'], true],
    ['public env, another product licensed', PUBLIC, ['p2'], false],
    ['public env, nothing licensed', PUBLIC, [], false],
    ['gated env, the product licensed', {}, ['p1'], false],
  ] as const)('%s → %s', (_label, env, licensedProductIds, expected) => {
    const { c } = makeCtx(env, { ...PAID, licensedProductIds });
    expect(vendorProductRecrawlEnabled(c, 'p1')).toBe(expected);
  });
});

describe('withRecrawlProduct / ownedSideProductId (AECI-1184)', () => {
  const RECRAWL: VendorRecrawl = { indexNow: ['u'], gsc: [] };

  it('passes undefined through', () => {
    expect(withRecrawlProduct(undefined, 'p')).toBeUndefined();
  });

  it('stamps a value and a promise alike', async () => {
    expect(withRecrawlProduct(RECRAWL, 'p1')).toEqual({ ...RECRAWL, productId: 'p1' });
    await expect(withRecrawlProduct(Promise.resolve(RECRAWL), 'p2')).resolves.toEqual({
      ...RECRAWL,
      productId: 'p2',
    });
  });

  it('picks the source, then the target, then null', () => {
    expect(ownedSideProductId(['a', 'b'], 'a', 'b')).toBe('a');
    expect(ownedSideProductId(['b'], 'a', 'b')).toBe('b');
    expect(ownedSideProductId([], 'a', 'b')).toBeNull();
  });
});

// ─── AECI-1376: the cause product's plan on the audit row ───────────────────

describe('sessionProductPlan / stampCauseProductPlan / vendorAuditEntry (AECI-1376)', () => {
  const NOW = '2026-10-16T00:00:00.000Z';
  function license(productId: string, over: Partial<SessionLicense> = {}): SessionLicense {
    return {
      product_id: productId,
      source: 'invoice',
      ends_at: null,
      ended_at: null,
      end_reason: null,
      ...over,
    } as SessionLicense;
  }
  // Licensed on product-1, Free on product-2, and product-3 lapsed in September.
  const AUTH = {
    vendorId: 'vendor-1',
    licensedProductIds: ['product-1'],
    licenses: [
      license('product-1'),
      license('product-3', { ended_at: '2026-09-01T00:00:00Z', end_reason: 'lapsed' }),
    ],
  };

  it('records Managed for a licensed product', () => {
    const { c } = makeCtx({}, AUTH);
    expect(sessionProductPlan(c, 'product-1', NOW)).toEqual({ tier: 'verified', status: 'active' });
  });

  it('records no plan for a Free product of a vendor licensed elsewhere', () => {
    const { c } = makeCtx({}, AUTH);
    expect(sessionProductPlan(c, 'product-2', NOW)).toEqual({ tier: 'none', status: 'none' });
  });

  it('records an ended license on the product as expired', () => {
    const { c } = makeCtx({}, AUTH);
    expect(sessionProductPlan(c, 'product-3', NOW)).toEqual({
      tier: 'verified',
      status: 'expired',
    });
  });

  it('follows the gate: a live license the session does not list reads as not Managed', () => {
    const { c } = makeCtx({}, { ...AUTH, licensedProductIds: [] });
    expect(sessionProductPlan(c, 'product-1', NOW).status).toBe('none');
  });

  it('records Managed for a listed product when the session carries no license rows', () => {
    const { c } = makeCtx({}, { licensedProductIds: ['product-1'] });
    expect(sessionProductPlan(c, 'product-1', NOW)).toEqual({ tier: 'verified', status: 'active' });
  });

  it('stamps every entry but a notification, and a null cause stamps nothing', () => {
    const { c } = makeCtx({}, AUTH);
    const rows = [entry(0), entry(1), { ...entry(2), action: 'notification.sent' }];
    stampCauseProductPlan(c, rows, 'product-2');
    expect(rows.map((row) => row.productPlan?.status)).toEqual(['none', 'none', undefined]);

    const untouched = entry(0);
    stampCauseProductPlan(c, untouched, null);
    expect(untouched.productPlan).toBeUndefined();
  });

  it('vendorAuditEntry records the plan of a row about one product', () => {
    const { c } = makeCtx({}, AUTH);
    const row = vendorAuditEntry(c, { ...entry(0), productId: 'product-1' });
    expect(row.productPlan).toEqual({ tier: 'verified', status: 'active' });
  });

  it('vendorAuditEntry keeps a handler stamp, so the post-commit re-call cannot clear it', () => {
    const { c } = makeCtx({}, AUTH);
    const row = entry(0);
    stampCauseProductPlan(c, row, 'product-2');
    vendorAuditEntry(c, row);
    vendorAuditEntry(c, row);
    expect(row.productPlan).toEqual({ tier: 'none', status: 'none' });
  });

  it('vendorAuditEntry leaves an integration row without a stamp alone', () => {
    const { c } = makeCtx({}, AUTH);
    expect(vendorAuditEntry(c, entry(0)).productPlan).toBeUndefined();
  });
});

describe('ownerSeatsOf (AECI-1351, decision 10)', () => {
  it('selects the vendor_admin seats with seat_owner set, banned included', async () => {
    const t = await makeTestDb();
    try {
      const V = '11111111-1111-4111-8111-111111111111';
      const OTHER = '22222222-2222-4222-8222-222222222222';
      await t.db.insert(vendors).values([
        { id: V, slug: 'acme', companyName: 'Acme' },
        { id: OTHER, slug: 'other', companyName: 'Other' },
      ]);
      await t.db.insert(profiles).values([
        // The claim-approved owner.
        {
          id: 'a0000000-0000-4000-8000-000000000001',
          role: 'vendor_admin',
          vendorId: V,
          seatOwner: true,
        },
        // A banned owner is still an owner seat, as in `seatsOf`.
        {
          id: 'a0000000-0000-4000-8000-000000000002',
          role: 'vendor_admin',
          vendorId: V,
          seatOwner: true,
          bannedAt: '2026-01-01T00:00:00.000Z',
        },
        // An invite-accepted colleague: a seat, not an owner.
        {
          id: 'a0000000-0000-4000-8000-000000000003',
          role: 'vendor_admin',
          vendorId: V,
          seatOwner: false,
        },
        // A reviewer carrying a stale owner bit and vendor id is not a seat at all.
        {
          id: 'a0000000-0000-4000-8000-000000000004',
          role: 'reviewer',
          vendorId: V,
          seatOwner: true,
        },
        // Another vendor's owner.
        {
          id: 'a0000000-0000-4000-8000-000000000005',
          role: 'vendor_admin',
          vendorId: OTHER,
          seatOwner: true,
        },
      ]);
      const ids = async (where: ReturnType<typeof seatsOf>) =>
        (await t.db.select({ id: profiles.id }).from(profiles).where(where))
          .map((r) => r.id.slice(-1))
          .sort();

      expect(await ids(ownerSeatsOf(V))).toEqual(['1', '2']);
      expect(await ids(seatsOf(V))).toEqual(['1', '2', '3']);
    } finally {
      t.dispose();
    }
  });
});
