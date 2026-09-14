/**
 * Vendor-portal writes actually reach the two re-crawl buffers (AECI-944).
 *
 * `vendor-recrawl.spec.ts` covers the URL derivation as pure functions. This
 * covers the wiring, which is the half that can silently not happen: the
 * buffering rides `ctx.waitUntil` inside `afterVendorWrite`, so a handler that
 * forgets to pass `recrawl` still returns 200 and still purges, and nothing
 * anywhere reports the missing rows.
 *
 * Three INVARIANTS:
 *
 *   1. **A vendor write lands rows in BOTH tables**, tagged `source = 'vendor'`
 *      so a row is attributable per row rather than only per deploy.
 *   2. **The environment gate holds.** With no `INDEXNOW_KEY` nothing is
 *      buffered at all, so a preview tier never accumulates rows that a later
 *      launch would release as a backlog of stale work.
 *   3. **A buffering failure never fails the write.** These are post-commit
 *      hooks on an already-committed edit.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  gscRecrawlQueue,
  indexnowQueue,
  productVendors,
  products,
  profiles,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import type { AuthzVariables } from '../lib/authz';
import { makeTestDb, type TestDb } from '../test/d1';
import { submitCount } from '../posthog';
import { fakeExecutionContext, TEST_ENV } from '../test/helpers';

import { createUpdateVendorProductHandler, createUpdateVendorProfileHandler } from './vendor';

vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const VENDOR = u(10);
const PRODUCT = u(20);
const SEAT = u(30);
const BASE = 'https://www.aecintegrations.com';

const AUTH: AuthzVariables['auth'] = {
  userId: SEAT,
  email: 'seat@example.com',
  role: 'vendor_admin',
  vendorId: VENDOR,
  entitlementTier: 'verified',
  entitlement: null,
};

/** `INDEXNOW_KEY` is the API Worker's only signal for "this environment is
 *  public and indexable" — there is no `ALLOW_INDEXING` here. See
 *  `bufferVendorRecrawl`. */
const PUBLIC_ENV = {
  ...TEST_ENV,
  PUBLIC_SITE_URL: BASE,
  INDEXNOW_KEY: 'test-key',
} as Env;

let t: TestDb;
beforeEach(async () => {
  vi.mocked(submitCount).mockClear();
  t = await makeTestDb();
  await t.db.insert(vendors).values({ id: VENDOR, slug: 'procore-inc', companyName: 'Procore' });
  await t.db.insert(products).values({ id: PRODUCT, slug: 'procore', name: 'Procore' });
  await t.db
    .insert(productVendors)
    .values({ productId: PRODUCT, vendorId: VENDOR, isPrimary: true });
  await t.db.insert(profiles).values({ id: SEAT, role: 'vendor_admin', vendorId: VENDOR });
  await t.db.insert(taxonomyTrades).values({
    id: u(40),
    slug: 'roofing',
    name: 'Roofing',
    description: 'Roofing work.',
    displayOrder: 1,
  });
});
afterEach(() => t.dispose());

function app() {
  const a = new Hono<{ Bindings: Env; Variables: AuthzVariables }>();
  a.onError(errorHandler());
  a.use('*', async (c, next) => {
    c.set('auth', AUTH);
    await next();
  });
  a.patch('/api/vendor/profile', createUpdateVendorProfileHandler(t.factory));
  a.patch('/api/vendor/products/:id', createUpdateVendorProductHandler(t.factory));
  return a;
}

async function patchJson(path: string, body: unknown, env: Env = PUBLIC_ENV) {
  const execCtx = fakeExecutionContext();
  const res = await app().request(
    path,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    },
    {
      ...env,
      CACHE_PURGE_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
      } as unknown as Env['CACHE_PURGE_QUEUE'],
    },
    execCtx,
  );
  // Drain the post-commit hooks — the buffering rides `waitUntil`.
  await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  return res;
}

const indexNowRows = () => t.db.select().from(indexnowQueue);
const gscRows = () => t.db.select().from(gscRecrawlQueue);

// ─── The wiring ──────────────────────────────────────────────────────────────

describe('PATCH /api/vendor/products/:id — re-crawl buffering', () => {
  it('buffers into BOTH queues, tagged as a vendor write', async () => {
    const res = await patchJson(`/api/vendor/products/${PRODUCT}`, {
      description: 'A rewritten description.',
    });
    expect(res.status).toBe(200);

    const indexNow = await indexNowRows();
    expect(indexNow.map((r) => r.url)).toContain(`${BASE}/products/procore`);
    expect(indexNow.every((r) => r.source === 'vendor')).toBe(true);

    const gsc = await gscRows();
    expect(gsc).toHaveLength(1);
    expect(gsc[0]!.url).toBe(`${BASE}/products/procore`);
    expect(gsc[0]!.source).toBe('vendor');
    // A description rewrite is material, so tier 2 rather than the tier-4
    // bucket a logo swap lands in.
    expect(gsc[0]!.reason).toBe('product.updated');
    expect(gsc[0]!.priority).toBe(2);
  });

  it('emits a vendor-tagged count for each queue, so the series splits by arm', async () => {
    // Without the tag the metric would measure the promote arm alone while the
    // tables filled from two writers. A rate that under-reports by an unknown
    // factor is worse than no rate at all.
    await patchJson(`/api/vendor/products/${PRODUCT}`, { description: 'x' });

    const counts = vi
      .mocked(submitCount)
      .mock.calls.map((call) => [call[3], call[5]] as [string, string[] | undefined]);

    expect(counts).toContainEqual(['aeci.indexnow.queued', ['source:vendor']]);
    expect(counts).toContainEqual(['aeci.gsc_recrawl.queued', ['source:vendor']]);
  });

  it('tiers a link-only edit into the bottom bucket', async () => {
    await patchJson(`/api/vendor/products/${PRODUCT}`, { logo_url: `${BASE}/logo.png` });
    const gsc = await gscRows();
    expect(gsc[0]!.reason).toBe('product.minor');
    expect(gsc[0]!.priority).toBe(4);
  });

  it('announces a trade page once the vendor tagging clears the publication floor', async () => {
    await patchJson(`/api/vendor/products/${PRODUCT}`, { trade_slugs: ['roofing'] });

    // The floor is resolved AFTER the commit, against the post-write count — so
    // the product that just joined is what makes the term publishable.
    const gsc = await gscRows();
    expect(gsc.map((r) => r.url)).toContain(`${BASE}/trades/roofing`);
    const trade = gsc.find((r) => r.url === `${BASE}/trades/roofing`);
    expect(trade!.reason).toBe('trade.published');

    const indexNow = await indexNowRows();
    expect(indexNow.map((r) => r.url)).toContain(`${BASE}/trades/roofing`);
    // The index moves too: its tiles are floor-filtered.
    expect(indexNow.map((r) => r.url)).toContain(`${BASE}/trades`);
  });

  it('keeps hub pages off the Google list while announcing them to IndexNow', async () => {
    await patchJson(`/api/vendor/products/${PRODUCT}`, { description: 'x' });
    expect((await indexNowRows()).map((r) => r.url)).toContain(`${BASE}/products`);
    expect((await gscRows()).map((r) => r.url)).not.toContain(`${BASE}/products`);
  });
});

describe('PATCH /api/vendor/profile — re-crawl buffering', () => {
  it('buffers the vendor page and tiers a facts change as material', async () => {
    const res = await patchJson('/api/vendor/profile', { headquarters: 'Carpinteria, CA' });
    expect(res.status).toBe(200);

    const gsc = await gscRows();
    expect(gsc).toHaveLength(1);
    expect(gsc[0]!.url).toBe(`${BASE}/vendors/procore-inc`);
    expect(gsc[0]!.reason).toBe('vendor.updated');
    // One tier below the same event on a product page, which is the rule.
    expect(gsc[0]!.priority).toBe(3);
  });

  it('tiers a social-link change into the bottom bucket', async () => {
    await patchJson('/api/vendor/profile', { linkedin_url: 'https://linkedin.com/company/x' });
    const gsc = await gscRows();
    expect(gsc[0]!.reason).toBe('vendor.minor');
  });
});

// ─── The environment gate ────────────────────────────────────────────────────

describe('the environment gate', () => {
  it('buffers nothing at all without INDEXNOW_KEY', async () => {
    // A preview tier renders `noindex`, so accumulating rows there would build a
    // backlog of stale work that a later launch would release in one go.
    const res = await patchJson(`/api/vendor/products/${PRODUCT}`, { description: 'x' }, {
      ...TEST_ENV,
      PUBLIC_SITE_URL: BASE,
    } as Env);
    expect(res.status).toBe(200);
    expect(await indexNowRows()).toHaveLength(0);
    expect(await gscRows()).toHaveLength(0);
  });

  it('buffers nothing without PUBLIC_SITE_URL', async () => {
    const res = await patchJson(`/api/vendor/products/${PRODUCT}`, { description: 'x' }, {
      ...TEST_ENV,
      INDEXNOW_KEY: 'test-key',
    } as Env);
    expect(res.status).toBe(200);
    expect(await gscRows()).toHaveLength(0);
  });

  it('does not even run the trade-floor read on a gated environment', async () => {
    // `resolvePublishedTradeSlugs` is a grouped D1 count. Running it to feed a
    // buffer that will not be written is pure waste on every preview and every
    // local request, so `recrawlEnabled` is checked BEFORE the derivation rather
    // than only inside the buffer.
    const spy = vi.spyOn(t.raw, 'prepare');
    await patchJson(`/api/vendor/products/${PRODUCT}`, { trade_slugs: ['roofing'] }, {
      ...TEST_ENV,
      PUBLIC_SITE_URL: BASE,
    } as Env);

    const grouped = spy.mock.calls
      .map((c) => String(c[0]))
      .filter((sql) => /taxonomy_trades/i.test(sql) && /group by/i.test(sql));
    expect(grouped).toHaveLength(0);
    spy.mockRestore();
  });

  it('buffers nothing when PUBLIC_SITE_URL is unparseable', async () => {
    // Malformed URLs are caught at the producer rather than left for a consumer
    // to discard later.
    const res = await patchJson(`/api/vendor/products/${PRODUCT}`, { description: 'x' }, {
      ...TEST_ENV,
      INDEXNOW_KEY: 'test-key',
      PUBLIC_SITE_URL: 'not a url',
    } as Env);
    expect(res.status).toBe(200);
    expect(await gscRows()).toHaveLength(0);
  });
});
