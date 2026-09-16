/**
 * `POST /api/promote` on the Drizzle/D1 path (ADR 0016 / AECI-253, AECI-249),
 * against the in-memory D1 harness. The plan-then-`db.batch` upsert is exercised
 * over real SQL: seed real rows, assert the real vendor/product/taxonomy/
 * integration/join/audit rows + the post-batch count recompute.
 *
 * The post-commit Algolia upsert is injected as a seam (its transport is
 * `algolia-sync.spec`'s job); the cache-purge enqueue (WC-5: onto a mock
 * `CACHE_PURGE_QUEUE`) + `cacheTagsForPromote` are DB-independent. The 409/500
 * unique-violation paths inject a
 * `db.batch` that throws the SQLite error the DB would raise.
 */

import { PromotePayloadSchema, type CachePurgeMessage, type PromoteResponse } from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attestations,
  auditLog,
  claims,
  connectorEvidencedPairs,
  gscRecrawlQueue,
  indexnowQueue,
  integrations,
  integrationEndpointMoves,
  productCategories,
  products,
  productTrades,
  productVendors,
  profiles,
  promoteJobs,
  statsCache,
  taxonomyAudiences,
  taxonomyCategories,
  taxonomyDataObjects,
  taxonomyPhases,
  taxonomyTrades,
  vendors,
} from '../db/schema';
import type { Env } from '../env';
import { ApiError, errorHandler } from '../errors';
import { json } from '../http';
import type { DbFactory } from '../lib/handler-utils';
import {
  PRESERVED_CONVERTED_CLAIM,
  PRESERVED_UNCONVERTED_CLAIM,
  PRESERVED_VENDOR_ATTESTATIONS,
  PRESERVED_VENDOR_CLAIM,
} from '../lib/promote-claims';
import { makeTestDb, recordingFactory, type TestDb } from '../test/d1';
import { fakeExecutionContext } from '../test/helpers';
import {
  bufferIndexNowAfterPromote,
  dispatchPromoteHooks,
  refreshHomeStatsAfterPromote,
  runPromoteIngest,
  type PromoteAlgoliaSync,
  type PromoteHomeStatsRefresh,
  type PromoteIndexNowNotify,
  type PromoteIngestDeps,
  type PromoteRunCtx,
} from './promote';
import { cacheTagsForPromote, touchedTradeSlugs } from './promote-cache-tags';
import { affectedUrlsForPromote, type AffectedUrlOptions } from './promote-indexnow-urls';

/** Deterministic UUID for seeded rows referenced via `supabaseId`. */
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const baseEnv: Env = {
  ENV: 'preview',
  REVIEW_APP_TOKEN: 'secret-token',
};

/** A no-op Algolia seam — default for all tests so the real (Prisma) default is
 *  never hit; the wiring tests inject a spy instead. */
const noopAlgolia: PromoteAlgoliaSync = async () => {};

/** A no-op IndexNow seam — default for all tests so the real default (which calls
 *  the global `fetch`) is never hit; the wiring tests inject a spy instead. */
const noopIndexNow: PromoteIndexNowNotify = async () => {};

/** A no-op home-stats refresh seam — default for all tests so the real default
 *  (which opens a fresh `getDb` on `env.DB` + recomputes/purges) is never hit; the
 *  wiring tests inject a spy, and the default-behavior tests call
 *  `refreshHomeStatsAfterPromote` directly against the in-memory `t.db`. */
const noopHomeStats: PromoteHomeStatsRefresh = async () => {};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  t.dispose();
  vi.unstubAllGlobals();
});

/**
 * `PromoteRunCtx` over a Hono context — the test-lane equivalent of what
 * `createWorkflowRunCtx` builds for a real run. `setBookmark` mirrors the workflow's
 * mutable holder: the post-commit seams read `rc.bookmark()`, and the bookmark only
 * exists once the ingest has returned.
 */
function testRunCtx(
  c: Context<{ Bindings: Env }>,
): PromoteRunCtx & { setBookmark(bookmark: string | null): void } {
  let bookmark: string | null = null;
  return {
    env: c.env,
    request: c.req.raw,
    waitUntil: (promise) => c.executionCtx.waitUntil(promise),
    bookmark: () => bookmark,
    setBookmark: (next) => {
      bookmark = next;
    },
  };
}

/**
 * Drives the ingest over HTTP the way the retired `createPromoteHandler` did, so the
 * assertions below (status codes, response bodies, `execCtx.waitUntil` counts) keep
 * exercising the same behaviour after AECI-563 moved the commit into a Workflow.
 *
 * This is a HARNESS, not a shipped route: `POST /api/promote` now returns `202 { jobId }`
 * (`promote-kickoff.spec.ts`) and this sequence — validate → `runPromoteIngest` →
 * `dispatchPromoteHooks` → return the ID map — is what `runPromoteWorkflow` performs
 * inside its commit step (`promote-workflow.spec.ts`). Keeping it here means the ~90
 * ingest cases stay a direct test of the plan-then-batch SQL rather than being rewritten
 * around a fake step, and the real `errorHandler` still renders the thrown `ApiError` /
 * `ZodError` envelopes the Workflow now maps onto job errors.
 */
function buildApp(
  opts: {
    syncAlgolia?: PromoteAlgoliaSync;
    notifyIndexNow?: PromoteIndexNowNotify;
    refreshHomeStats?: PromoteHomeStatsRefresh;
    dbFor?: DbFactory;
  } = {},
) {
  const deps: PromoteIngestDeps = {
    dbFor: opts.dbFor ?? t.factory,
    syncAlgolia: opts.syncAlgolia ?? noopAlgolia,
    notifyIndexNow: opts.notifyIndexNow ?? noopIndexNow,
    refreshHomeStats: opts.refreshHomeStats ?? noopHomeStats,
  };
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  app.post('/api/promote', async (c) => {
    let raw: unknown;
    try {
      raw = JSON.parse(await c.req.text());
    } catch {
      throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
    }
    const payload = PromotePayloadSchema.parse(raw);
    const rc = testRunCtx(c);
    const result = await runPromoteIngest(rc, payload, deps);
    rc.setBookmark(result.bookmark);
    dispatchPromoteHooks(rc, result, deps);
    return json(result.response);
  });
  return app;
}

function post(body: unknown, headers: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

function promote(body: unknown, env = baseEnv, execCtx = fakeExecutionContext()) {
  return buildApp().request('/api/promote', post(body), env, execCtx);
}

const auditActions = async () => (await t.db.select().from(auditLog)).map((e) => e.action);

// ─── Seed helpers ──────────────────────────────────────────────────────────────
const seedVendor = (id: string, slug: string, name: string) =>
  t.db.insert(vendors).values({ id, slug, companyName: name, promotionStatus: 'promoted' });
const seedProduct = (
  id: string,
  slug: string,
  name: string,
  extra: Partial<typeof products.$inferInsert> = {},
) => t.db.insert(products).values({ id, slug, name, promotionStatus: 'promoted', ...extra });
const seedDataObject = (id: string, slug: string, name: string, aliases: string[] = []) =>
  t.db.insert(taxonomyDataObjects).values({ id, slug, name, aliases });

describe('runPromoteIngest — Sessions API anchoring (AECI-250 / AECI-563)', () => {
  it('anchors the write session at first-primary and returns the outbound bookmark', async () => {
    const rec = recordingFactory(t.db);
    rec.setBookmark('bk-after-write');

    const rc: PromoteRunCtx = {
      env: baseEnv,
      request: new Request('http://localhost:8787/api/promote'),
      waitUntil: () => {},
      bookmark: () => null,
    };

    const result = await runPromoteIngest(
      rc,
      PromotePayloadSchema.parse({
        vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
        product: { ref: 'p1', name: 'Revit' },
        integrations: [],
      }),
      {
        dbFor: rec.factory,
        syncAlgolia: noopAlgolia,
        notifyIndexNow: noopIndexNow,
        refreshHomeStats: noopHomeStats,
      },
    );

    // The write anchor reaches getDb. There is no inbound bookmark to thread any more:
    // the ingest runs in a Workflow step, not on a request, so there is no
    // `x-d1-bookmark` header and `bookmarkMiddleware` never sees this path (AECI-563).
    expect(rec.calls[0]).toEqual({ bookmark: null, constraint: 'first-primary' });
    // The session bookmark rides the result instead of a response header — that is what
    // the workflow feeds to `rc.setBookmark` so the post-commit re-reads see the write.
    expect(result.bookmark).toBe('bk-after-write');
    // The real write still happened over the recording factory's client.
    expect(await t.db.select().from(products)).toHaveLength(1);
  });
});

describe('runPromoteIngest', () => {
  it('creates a product with vendor and taxonomy', async () => {
    const existingProd = uuid(1);
    await seedProduct(existingProd, 'navisworks', 'Navisworks');

    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: {
        ref: 'p1',
        name: 'Revit',
        categories: ['BIM', 'Design'],
        audiences: ['Architecture'],
      },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: existingProd },
          builtByVendor: { ref: 'v1' },
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      vendors: { ref: string; slug: string; operation: string }[];
      product: { ref: string; id: string; slug: string; operation: string };
      integrations: { ref: string; operation: string }[];
      taxonomy: { categories: unknown[]; audiences: unknown[] };
      skipped: unknown[];
    };

    expect(b.vendors[0]).toMatchObject({ ref: 'v1', slug: 'autodesk', operation: 'created' });
    expect(b.product).toMatchObject({ ref: 'p1', slug: 'revit', operation: 'created' });
    expect(b.taxonomy.categories).toHaveLength(2);
    expect(b.taxonomy.audiences).toHaveLength(1);
    expect(b.skipped).toHaveLength(0);
    expect(b.integrations[0]).toMatchObject({ ref: 'i1', operation: 'created' });

    // Join rows + integration reflect the bundle.
    expect(await t.db.select().from(productVendors)).toHaveLength(1);
    expect(await t.db.select().from(productCategories)).toHaveLength(2);
    expect(await t.db.select().from(integrations)).toHaveLength(1);

    // Post-batch recompute: both endpoints' integration_count = 1.
    const revit = await t.db.query.products.findFirst({ where: eq(products.id, b.product.id) });
    const navis = await t.db.query.products.findFirst({ where: eq(products.id, existingProd) });
    expect(revit!.integrationCount).toBe(1);
    expect(navis!.integrationCount).toBe(1);

    const audits = await t.db.select().from(auditLog);
    expect(audits.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'vendor.created',
        'category.created',
        'product.created',
        'integration.created',
      ]),
    );
    expect(
      audits.every((e) => (e.metadata as { source?: string }).source === 'review-app-promote'),
    ).toBe(true);
  });

  it('updates by supabaseId and keeps the slug stable', async () => {
    const vendX = uuid(2);
    const prodX = uuid(3);
    await seedVendor(vendX, 'autodesk', 'Autodesk');
    await seedProduct(prodX, 'revit', 'Revit');

    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: vendX, companyName: 'Autodesk Inc.' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit 2025' },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      vendors: { slug: string; operation: string }[];
      product: { slug: string; operation: string };
    };
    expect(b.vendors[0]).toMatchObject({ slug: 'autodesk', operation: 'updated' });
    expect(b.product).toMatchObject({ slug: 'revit', operation: 'updated' });

    const prod = await t.db.query.products.findFirst({ where: eq(products.id, prodX) });
    expect(prod).toMatchObject({ name: 'Revit 2025', slug: 'revit' });
    expect(await auditActions()).toEqual(
      expect.arrayContaining(['vendor.updated', 'product.updated']),
    );
  });

  // ── products.promoted_at (AECI-581 / §13 D6) ────────────────────────────────
  // Set-once, or it degrades to "last promoted" and buys nothing over
  // `updated_at`: this branch re-asserts `promotion_status: 'promoted'` on EVERY
  // re-promote, and `product.updated` outnumbers `product.created` ~2.7:1.

  it('stamps promoted_at on a first promote', async () => {
    const before = new Date().toISOString();
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' },
    });
    expect(res.status).toBe(200);

    const after = new Date().toISOString();

    const prod = await t.db.query.products.findFirst({ where: eq(products.slug, 'revit') });
    expect(prod?.promotedAt).toBeTruthy();
    expect(String(prod?.promotedAt) >= before).toBe(true);
    expect(String(prod?.promotedAt) <= after).toBe(true);
    // A create IS the first promote, so the stamp is the insert time. Not asserted
    // byte-equal to `created_at`: `promoted_at` is stamped once for the whole
    // ingest run while Drizzle's `$defaultFn` fires per statement, so they can sit
    // a millisecond apart.
    const skewMs = Math.abs(
      Date.parse(String(prod?.promotedAt)) - Date.parse(String(prod?.createdAt)),
    );
    expect(skewMs).toBeLessThan(1000);
  });

  it('leaves promoted_at unchanged when a product is mutated and re-promoted', async () => {
    const prodX = uuid(3);
    const firstPromote = '2026-01-15T09:30:00.000Z';
    await seedProduct(prodX, 'revit', 'Revit', { promotedAt: firstPromote });

    // Re-promote twice, changing the row each time — exactly the update branch
    // that would otherwise overwrite the stamp.
    for (const name of ['Revit 2025', 'Revit 2026']) {
      const res = await promote({
        vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
        product: { ref: 'p1', supabaseId: prodX, name },
      });
      expect(res.status).toBe(200);
    }

    const prod = await t.db.query.products.findFirst({ where: eq(products.id, prodX) });
    expect(prod?.name).toBe('Revit 2026');
    expect(prod?.promotedAt).toBe(firstPromote);
  });

  it('fills promoted_at on a re-promote when it is still NULL (a pre-backfill row)', async () => {
    const prodX = uuid(3);
    await seedProduct(prodX, 'revit', 'Revit');
    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, prodX) }))?.promotedAt,
    ).toBeNull();

    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit 2025' },
    });
    expect(res.status).toBe(200);

    // COALESCE fills a NULL — it does not require the ops backfill to have run.
    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, prodX) }))?.promotedAt,
    ).toBeTruthy();
  });

  // ── last_reviewed_at (AECI-616 / STAGE_2_ATTESTATIONS_SPEC.md §13) ──────────
  // The whole feature rests on ABSENCE meaning "untouched". If a plain re-promote
  // could advance this, the marker would re-advertise the entire catalog as freshly
  // reviewed on every bulk push — the exact fake freshness it exists to expose, and
  // the reason the date was withheld in Stage 1 rather than wired to `updated_at`.

  it('leaves last_reviewed_at untouched on a re-promote that carries no review signal', async () => {
    const vendX = uuid(2);
    const prodX = uuid(3);
    const intgX = uuid(4);
    const reviewed = '2026-03-04T00:00:00.000Z';
    await seedVendor(vendX, 'autodesk', 'Autodesk');
    await seedProduct(prodX, 'revit', 'Revit', { lastReviewedAt: reviewed });
    const otherX = uuid(5);
    await seedProduct(otherX, 'procore', 'Procore');
    await t.db
      .insert(integrations)
      .values({ id: intgX, sourceProductId: prodX, targetProductId: otherX });
    await t.db
      .update(integrations)
      .set({ lastReviewedAt: reviewed })
      .where(eq(integrations.id, intgX));
    await t.db.update(vendors).set({ lastReviewedAt: reviewed }).where(eq(vendors.id, vendX));

    // Mutate every entity twice without sending the signal — the update branch that
    // would otherwise overwrite the stamp, exercised the way a real bulk push does.
    for (const name of ['Revit 2025', 'Revit 2026']) {
      const res = await promote({
        vendors: [{ ref: 'v1', supabaseId: vendX, companyName: 'Autodesk Inc.' }],
        product: { ref: 'p1', supabaseId: prodX, name },
        integrations: [
          {
            ref: 'i1',
            supabaseId: intgX,
            name,
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: otherX },
          },
        ],
      });
      expect(res.status).toBe(200);
    }

    const prod = await t.db.query.products.findFirst({ where: eq(products.id, prodX) });
    const vend = await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendX) });
    const intg = await t.db.query.integrations.findFirst({ where: eq(integrations.id, intgX) });

    // The rows genuinely changed…
    expect(prod?.name).toBe('Revit 2026');
    expect(intg?.name).toBe('Revit 2026');
    // …and `updated_at` moved with them, which is precisely why it cannot be the
    // marker's source. `last_reviewed_at` did not move.
    expect(String(prod?.updatedAt) > reviewed).toBe(true);
    expect(prod?.lastReviewedAt).toBe(reviewed);
    expect(vend?.lastReviewedAt).toBe(reviewed);
    expect(intg?.lastReviewedAt).toBe(reviewed);
  });

  it('advances last_reviewed_at on every entity when the review signal is present', async () => {
    const vendX = uuid(2);
    const prodX = uuid(3);
    const otherX = uuid(5);
    const intgX = uuid(4);
    const stale = '2026-03-04T00:00:00.000Z';
    const rechecked = '2026-08-18T10:00:00.000Z';
    await seedVendor(vendX, 'autodesk', 'Autodesk');
    await seedProduct(prodX, 'revit', 'Revit', { lastReviewedAt: stale });
    await seedProduct(otherX, 'procore', 'Procore');
    await t.db
      .insert(integrations)
      .values({ id: intgX, sourceProductId: prodX, targetProductId: otherX });

    const res = await promote({
      vendors: [
        { ref: 'v1', supabaseId: vendX, companyName: 'Autodesk', lastReviewedAt: rechecked },
      ],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit', lastReviewedAt: rechecked },
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgX,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: otherX },
          lastReviewedAt: rechecked,
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, prodX) }))?.lastReviewedAt,
    ).toBe(rechecked);
    expect(
      (await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendX) }))?.lastReviewedAt,
    ).toBe(rechecked);
    expect(
      (await t.db.query.integrations.findFirst({ where: eq(integrations.id, intgX) }))
        ?.lastReviewedAt,
    ).toBe(rechecked);
  });

  it('never writes maintained_by, so a re-promote cannot un-vendor a record', async () => {
    const prodX = uuid(3);
    const otherX = uuid(5);
    const intgX = uuid(4);
    await seedProduct(prodX, 'revit', 'Revit');
    await seedProduct(otherX, 'procore', 'Procore');
    await t.db
      .insert(integrations)
      .values({ id: intgX, sourceProductId: prodX, targetProductId: otherX });
    // A vendor has taken the integration over (what AECI-301's write path does).
    await t.db
      .update(integrations)
      .set({ maintainedBy: 'vendor' })
      .where(eq(integrations.id, intgX));

    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit 2026' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgX,
          name: 'Revit ↔ Procore',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: otherX },
        },
      ],
    });
    expect(res.status).toBe(200);

    const intg = await t.db.query.integrations.findFirst({ where: eq(integrations.id, intgX) });
    expect(intg?.name).toBe('Revit ↔ Procore'); // the push DID land…
    expect(intg?.maintainedBy).toBe('vendor'); // …and left the vendor's ownership alone
  });

  it('cannot un-vendor a PRODUCT or a VENDOR either (AECI-981)', async () => {
    // The sibling case above covered `integrations` only, because until AECI-981
    // nothing could make a product or vendor row vendor-maintained. A vendor
    // profile/product save can now, so the guarantee is asserted where it lives.
    const vendX = uuid(2);
    const prodX = uuid(3);
    await seedVendor(vendX, 'autodesk', 'Autodesk');
    await seedProduct(prodX, 'revit', 'Revit');
    await t.db.update(vendors).set({ maintainedBy: 'vendor' }).where(eq(vendors.id, vendX));
    await t.db.update(products).set({ maintainedBy: 'vendor' }).where(eq(products.id, prodX));

    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: vendX, companyName: 'Autodesk Inc.' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit 2026' },
    });
    expect(res.status).toBe(200);

    const vend = await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendX) });
    const prod = await t.db.query.products.findFirst({ where: eq(products.id, prodX) });
    expect(vend?.companyName).toBe('Autodesk Inc.'); // the push DID land…
    expect(prod?.name).toBe('Revit 2026');
    expect(vend?.maintainedBy).toBe('vendor'); // …and left both records on the vendor's name
    expect(prod?.maintainedBy).toBe('vendor');
  });

  // ── The maintenance fence (AECI-981 / §13.9) ─────────────────────────────
  //
  // Promote may advance the date on a record AECi maintains and must not on one a
  // vendor maintains: the marker renders the SAME column as `Reviewed <date>` in
  // one branch and `Updated <date>` in the other, so an AECi review date on a
  // vendor-maintained row credits AECi's work to the vendor.

  it('refuses a supplied lastReviewedAt on a vendor-maintained record, and says so', async () => {
    const vendX = uuid(2);
    const prodX = uuid(3);
    const otherX = uuid(5);
    const intgX = uuid(4);
    const held = '2026-03-04T00:00:00.000Z';
    await seedVendor(vendX, 'autodesk', 'Autodesk');
    await seedProduct(prodX, 'revit', 'Revit', { lastReviewedAt: held });
    await seedProduct(otherX, 'procore', 'Procore');
    await t.db
      .insert(integrations)
      .values({ id: intgX, sourceProductId: prodX, targetProductId: otherX });
    for (const stmt of [
      t.db.update(vendors).set({ maintainedBy: 'vendor', lastReviewedAt: held }),
      t.db.update(products).set({ maintainedBy: 'vendor' }),
      t.db.update(integrations).set({ maintainedBy: 'vendor', lastReviewedAt: held }),
    ]) {
      await stmt;
    }

    const rechecked = '2026-08-17T00:00:00.000Z';
    const res = await promote({
      vendors: [
        { ref: 'v1', supabaseId: vendX, companyName: 'Autodesk', lastReviewedAt: rechecked },
      ],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit', lastReviewedAt: rechecked },
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgX,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: otherX },
          lastReviewedAt: rechecked,
        },
      ],
    });
    expect(res.status).toBe(200);

    // Every stored date held.
    expect(
      (await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendX) }))?.lastReviewedAt,
    ).toBe(held);
    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, prodX) }))?.lastReviewedAt,
    ).toBe(held);
    expect(
      (await t.db.query.integrations.findFirst({ where: eq(integrations.id, intgX) }))
        ?.lastReviewedAt,
    ).toBe(held);

    // …and the refusal is REPORTED rather than silent. `skipped` is the right
    // array by its own definition: "something you sent was not written".
    const body = (await res.json()) as { skipped: { ref: string; kind: string }[] };
    expect(
      body.skipped
        .filter((e) => e.kind === 'review-signal')
        .map((e) => e.ref)
        .sort(),
    ).toEqual(['i1', 'p1', 'v1']);
  });

  it('still advances the date on an AECi-maintained record — the fence is not a block', async () => {
    const prodX = uuid(3);
    await seedProduct(prodX, 'revit', 'Revit');
    const rechecked = '2026-08-17T00:00:00.000Z';
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit', lastReviewedAt: rechecked },
    });
    expect(res.status).toBe(200);
    expect(
      (await t.db.query.products.findFirst({ where: eq(products.id, prodX) }))?.lastReviewedAt,
    ).toBe(rechecked);
    const body = (await res.json()) as { skipped: { kind: string }[] };
    expect(body.skipped.filter((e) => e.kind === 'review-signal')).toHaveLength(0);
  });

  it('reports nothing when no review signal was sent — absence is the normal path', async () => {
    const prodX = uuid(3);
    await seedProduct(prodX, 'revit', 'Revit');
    await t.db.update(products).set({ maintainedBy: 'vendor' }).where(eq(products.id, prodX));
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit 2026' },
    });
    const body = (await res.json()) as { skipped: { kind: string }[] };
    // A receipt on every push would fire for essentially every promote and mean
    // nothing — the §13.8 rule. Only an explicitly SENT value earns one.
    expect(body.skipped.filter((e) => e.kind === 'review-signal')).toHaveLength(0);
  });

  // AECI-568. A `supabaseId` pointing at a row that no longer exists (retracted,
  // pruned, deleted) used to take the update branch anyway: `UPDATE … WHERE id =
  // <gone>` writes nothing, yet the response said `operation: 'updated'` with an
  // empty slug — which the review app then wrote back over its real slug. The ingest
  // now falls through to a create, so the next write-back self-heals the pointer.
  describe('stale supabaseId → falls back to create', () => {
    it('recreates a vendor whose supabaseId no longer resolves', async () => {
      const gone = uuid(7);

      const res = await promote({
        vendors: [{ ref: 'v1', supabaseId: gone, companyName: 'Autodesk' }],
      });

      expect(res.status).toBe(200);
      const b = (await res.json()) as {
        vendors: { id: string; slug: string; operation: string }[];
      };
      expect(b.vendors[0]).toMatchObject({ slug: 'autodesk', operation: 'created' });
      expect(b.vendors[0].id).not.toBe(gone);

      const rows = await t.db.select().from(vendors);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: b.vendors[0].id, slug: 'autodesk' });
      expect(await auditActions()).toEqual(['vendor.created']);
    });

    it('recreates a product whose supabaseId no longer resolves, with a real slug', async () => {
      const gone = uuid(7);

      const res = await promote({
        vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
        product: { ref: 'p1', supabaseId: gone, name: 'Revit' },
      });

      expect(res.status).toBe(200);
      const b = (await res.json()) as { product: { id: string; slug: string; operation: string } };
      // The slug is generated, not the '' the no-op update used to report.
      expect(b.product).toMatchObject({ slug: 'revit', operation: 'created' });
      expect(b.product.id).not.toBe(gone);

      const rows = await t.db.select().from(products);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: b.product.id, slug: 'revit', name: 'Revit' });
      expect(await auditActions()).toEqual(
        expect.arrayContaining(['vendor.created', 'product.created']),
      );
    });

    it('recreates an integration whose supabaseId no longer resolves, with its claims', async () => {
      const srcId = uuid(1);
      const tgtId = uuid(2);
      const gone = uuid(7);
      await seedProduct(srcId, 'revit', 'Revit');
      await seedProduct(tgtId, 'navisworks', 'Navisworks');
      await seedDataObject(uuid(3), 'rfis', 'RFIs');

      const res = await promote({
        integrations: [
          {
            ref: 'i1',
            supabaseId: gone,
            sourceProduct: { supabaseId: srcId },
            targetProduct: { supabaseId: tgtId },
            claims: [
              {
                dataObject: 'rfis',
                direction: 'a_to_b',
                attestations: [{ source: 'aeci', asserted: true }],
              },
            ],
          },
        ],
      });

      expect(res.status).toBe(200);
      const b = (await res.json()) as { integrations: { id: string; operation: string }[] };
      expect(b.integrations[0]).toMatchObject({ operation: 'created' });
      expect(b.integrations[0].id).not.toBe(gone);

      const rows = await t.db.select().from(integrations);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(b.integrations[0].id);
      // The claim rides the NEW integration id, not the dead one.
      const claimRows = await t.db.select().from(claims);
      expect(claimRows).toHaveLength(1);
      expect(claimRows[0].integrationId).toBe(b.integrations[0].id);
      expect(await t.db.select().from(attestations)).toHaveLength(1);
      expect(await auditActions()).toEqual(
        expect.arrayContaining(['integration.created', 'claim.created']),
      );
    });

    it('reports every fallback on staleSupabaseIds, and nothing when the ids resolve', async () => {
      const goneVendor = uuid(7);
      const goneProduct = uuid(8);
      const rc: PromoteRunCtx = {
        env: baseEnv,
        request: new Request('http://localhost:8787/api/promote'),
        waitUntil: () => {},
        bookmark: () => null,
      };
      const deps: PromoteIngestDeps = {
        dbFor: t.factory,
        syncAlgolia: noopAlgolia,
        notifyIndexNow: noopIndexNow,
        refreshHomeStats: noopHomeStats,
      };

      const stale = await runPromoteIngest(
        rc,
        PromotePayloadSchema.parse({
          vendors: [{ ref: 'v1', supabaseId: goneVendor, companyName: 'Autodesk' }],
          product: { ref: 'p1', supabaseId: goneProduct, name: 'Revit' },
        }),
        deps,
      );
      expect(stale.staleSupabaseIds).toEqual([
        { kind: 'vendor', ref: 'v1', supabaseId: goneVendor },
        { kind: 'product', ref: 'p1', supabaseId: goneProduct },
      ]);

      // Re-push with the ids the first run actually assigned: both resolve now, so the
      // pointer is healed and the report is empty.
      const healed = await runPromoteIngest(
        rc,
        PromotePayloadSchema.parse({
          vendors: [
            { ref: 'v1', supabaseId: stale.response.vendors[0].id, companyName: 'Autodesk' },
          ],
          product: { ref: 'p1', supabaseId: stale.response.product?.id, name: 'Revit' },
        }),
        deps,
      );
      expect(healed.staleSupabaseIds).toEqual([]);
      expect(healed.response.product).toMatchObject({ slug: 'revit', operation: 'updated' });
    });
  });

  /**
   * AECI-571 — the `promote_jobs` ledger makes the commit exactly-once per job id.
   *
   * Cloudflare Workflows guarantee a step runs *at least* once, so an engine crash
   * between `db.batch` committing and the step result being persisted re-executes the
   * whole ingest. Without the ledger the plan phase mints fresh uuids and re-derives the
   * slug against the row it just committed, so a *created* product lands twice — as
   * `revit` AND `revit-2`. These cases drive the ingest directly (the `buildApp` harness
   * has no job id) and assert the guard from both sides: the pre-read short-circuit and
   * the in-batch primary key.
   */
  describe('exactly-once job ledger (AECI-571)', () => {
    const LEDGER_JOB = 'job-aeci-571-0001';

    const ledgerRc = (): PromoteRunCtx => ({
      env: baseEnv,
      request: new Request('http://localhost:8787/api/promote'),
      waitUntil: () => {},
      bookmark: () => null,
    });
    const ledgerDeps = (): PromoteIngestDeps => ({
      dbFor: t.factory,
      syncAlgolia: noopAlgolia,
      notifyIndexNow: noopIndexNow,
      refreshHomeStats: noopHomeStats,
    });
    const ingest = (body: unknown, jobId?: string) =>
      runPromoteIngest(
        ledgerRc(),
        PromotePayloadSchema.parse(body),
        ledgerDeps(),
        jobId ? { jobId } : {},
      );

    const REVIT = {
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit', categories: ['BIM'] },
      integrations: [],
    };

    it('commits once and returns the identical ID map when the same jobId is ingested twice', async () => {
      const first = await ingest(REVIT, LEDGER_JOB);
      const auditsAfterFirst = await auditActions();

      const second = await ingest(REVIT, LEDGER_JOB);

      // One of everything, and — the part a deterministic-id fix would NOT give us —
      // the slug never drifted to `revit-2`.
      expect(await t.db.select().from(products)).toHaveLength(1);
      expect(await t.db.select().from(vendors)).toHaveLength(1);
      expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
      expect(second.response.product).toMatchObject({ slug: 'revit', operation: 'created' });
      expect(second.response).toEqual(first.response);

      // The audit rows are inside the same batch, so the rollback covers them too.
      expect(await auditActions()).toEqual(auditsAfterFirst);
      // …and the replay still hands the hooks the §26.5 entries the lost attempt never
      // forwarded, `metadata` re-attached after the ledger round-trip.
      expect(second.auditEntries).toEqual(first.auditEntries);
      expect(second.auditEntries[0]?.metadata).toEqual({ source: 'review-app-promote' });
    });

    it('rolls the entire replayed batch back — joins, integrations, claims and attestations included', async () => {
      const target = uuid(1);
      await seedProduct(target, 'navisworks', 'Navisworks');
      await seedDataObject(uuid(20), 'rfis', 'RFIs');

      const bundle = {
        vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
        product: { ref: 'p1', name: 'Revit', categories: ['BIM'] },
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: target },
            claims: [
              {
                dataObject: 'rfis',
                direction: 'a_to_b',
                attestations: [{ source: 'aeci', asserted: true }],
              },
            ],
          },
        ],
      };

      await ingest(bundle, LEDGER_JOB);
      const before = {
        integrations: await t.db.select().from(integrations),
        claims: await t.db.select().from(claims),
        attestations: await t.db.select().from(attestations),
        productVendors: await t.db.select().from(productVendors),
        productCategories: await t.db.select().from(productCategories),
      };

      await ingest(bundle, LEDGER_JOB);

      expect(await t.db.select().from(integrations)).toEqual(before.integrations);
      expect(await t.db.select().from(claims)).toEqual(before.claims);
      expect(await t.db.select().from(attestations)).toEqual(before.attestations);
      expect(await t.db.select().from(productVendors)).toEqual(before.productVendors);
      expect(await t.db.select().from(productCategories)).toEqual(before.productCategories);
    });

    it('short-circuits on the pre-read, before the plan phase runs', async () => {
      const first = await ingest(REVIT, LEDGER_JOB);

      // If the replay reached the batch at all, this spy would fire.
      const batch = vi.spyOn(t.db, 'batch');
      const second = await ingest(REVIT, LEDGER_JOB);

      expect(batch).not.toHaveBeenCalled();
      expect(second.response).toEqual(first.response);
    });

    it('falls back to the in-batch primary key when the pre-read misses (concurrent replay)', async () => {
      const first = await ingest(REVIT, LEDGER_JOB);

      // Force the replay to miss the short-circuit exactly once, so it plans in full and
      // the real guard — the PK inside `db.batch` — is what absorbs it. This is the only
      // case that exercises the guard rather than the optimization in front of it.
      const findFirst = vi
        .spyOn(t.db.query.promoteJobs, 'findFirst')
        .mockReturnValueOnce(Promise.resolve(undefined) as never);

      const second = await ingest(REVIT, LEDGER_JOB);

      expect(findFirst).toHaveBeenCalled();
      expect(second.response).toEqual(first.response);
      // The rollback was total: no orphaned `revit-2`, no second vendor.
      const rows = await t.db.select().from(products);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.slug).toBe('revit');
      expect(await t.db.select().from(vendors)).toHaveLength(1);
    });

    it('still returns 409 SLUG_CONFLICT when a jobId is supplied', async () => {
      // The new duplicate branch must not swallow the AECI-98 path.
      t.db.batch = (() =>
        Promise.reject(new Error('UNIQUE constraint failed: products.slug'))) as never;

      await expect(ingest(REVIT, LEDGER_JOB)).rejects.toMatchObject({
        status: 409,
        code: 'SLUG_CONFLICT',
      });
    });

    it('refuses to re-commit when the stored result is unreadable', async () => {
      // A future envelope version reads as unusable rather than being coerced. The
      // commit already happened, so re-planning is the one thing we must never do.
      await t.db.insert(promoteJobs).values({ jobId: LEDGER_JOB, result: { v: 99 } });

      await expect(ingest(REVIT, LEDGER_JOB)).rejects.toMatchObject({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: expect.stringMatching(/already committed/),
      });
      expect(await t.db.select().from(products)).toHaveLength(0);
    });

    it('keeps pre-AECI-571 behaviour when no jobId is supplied', async () => {
      await ingest(REVIT);
      await ingest(REVIT);

      // No ledger row, no protection: two creates, both slugs disambiguated against the
      // rows the first run committed (the vendor duplicates too, so the product's
      // vendor-qualified fallback is itself suffixed). This is exactly the damage the
      // ledger prevents, and the contract the other ~90 cases in this file depend on.
      expect((await t.db.select().from(products)).map((p) => p.slug).sort()).toEqual([
        'revit',
        'revit-autodesk-2',
      ]);
      expect((await t.db.select().from(vendors)).map((v) => v.slug).sort()).toEqual([
        'autodesk',
        'autodesk-2',
      ]);
      expect(await t.db.select().from(promoteJobs)).toHaveLength(0);
    });

    it('reports wrote:false for an all-skipped promote even though a ledger row is written', async () => {
      // `wrote` must be read BEFORE the ledger statement joins the batch — otherwise an
      // all-skipped promote claims a write and fires a pointless home-stats refresh.
      const result = await ingest(
        {
          integrations: [
            {
              ref: 'i1',
              sourceProduct: { supabaseId: uuid(8) },
              targetProduct: { supabaseId: uuid(9) },
            },
          ],
        },
        LEDGER_JOB,
      );

      expect(result.wrote).toBe(false);
      expect(await t.db.select().from(promoteJobs)).toHaveLength(1);
    });

    it('repairs the denormalized counts on replay', async () => {
      const target = uuid(1);
      await seedProduct(target, 'navisworks', 'Navisworks');
      const bundle = {
        product: { ref: 'p1', name: 'Revit' },
        integrations: [
          { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: target } },
        ],
      };
      const first = await ingest(bundle, LEDGER_JOB);
      const productId = first.response.product!.id;

      // The attempt whose result was lost may have died before `recomputeProductCounts`,
      // which runs after the batch and outside the transaction. Simulate that drift.
      await t.db.update(products).set({ integrationCount: 99 }).where(eq(products.id, productId));

      await ingest(bundle, LEDGER_JOB);

      const [row] = await t.db.select().from(products).where(eq(products.id, productId));
      expect(row!.integrationCount).toBe(1);
    });
  });

  it('promotes a vendor on its own (no product)', async () => {
    const vendX = uuid(2);
    await seedVendor(vendX, 'autodesk', 'Autodesk');

    const res = await promote({
      vendors: [
        {
          ref: 'v1',
          supabaseId: vendX,
          companyName: 'Autodesk',
          website: 'https://new.example',
          xUrl: 'https://x.com/autodesk',
          facebookUrl: 'https://www.facebook.com/autodesk',
          instagramUrl: 'https://www.instagram.com/autodesk',
          youtubeUrl: 'https://www.youtube.com/@autodesk',
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      vendors: { id: string; slug: string; operation: string }[];
      product: unknown;
      taxonomy: { categories: unknown[] };
    };
    expect(b.vendors[0]).toMatchObject({ id: vendX, slug: 'autodesk', operation: 'updated' });
    expect(b.product).toBeNull();
    expect(b.taxonomy.categories).toHaveLength(0);

    const vend = await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendX) });
    expect(vend).toMatchObject({
      website: 'https://new.example',
      xUrl: 'https://x.com/autodesk',
      facebookUrl: 'https://www.facebook.com/autodesk',
      instagramUrl: 'https://www.instagram.com/autodesk',
      youtubeUrl: 'https://www.youtube.com/@autodesk',
    });
    expect(await t.db.select().from(products)).toHaveLength(0);
    expect(await auditActions()).toEqual(['vendor.updated']);
  });

  it('disambiguates a colliding product slug using the primary vendor slug', async () => {
    await seedProduct(uuid(5), 'revit', 'Revit');
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' },
    });
    const b = (await res.json()) as { product: { slug: string } };
    expect(b.product.slug).toBe('revit-autodesk');
  });

  it('reuses existing taxonomy rather than duplicating', async () => {
    await t.db.insert(taxonomyCategories).values({ id: uuid(6), slug: 'bim', name: 'BIM' });
    const res = await promote({ product: { ref: 'p1', name: 'Revit', categories: ['BIM'] } });
    const b = (await res.json()) as {
      taxonomy: { categories: { id: string; operation: string }[] };
    };
    expect(b.taxonomy.categories[0]).toMatchObject({ id: uuid(6), operation: 'reused' });
    expect(await t.db.select().from(taxonomyCategories)).toHaveLength(1);
    expect(await auditActions()).not.toContain('category.created');
  });

  it('skips an integration whose other endpoint is not promoted', async () => {
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: uuid(9) } },
      ],
    });
    const b = (await res.json()) as {
      integrations: unknown[];
      skipped: { ref: string; kind: string }[];
    };
    expect(b.integrations).toHaveLength(0);
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'i1', kind: 'integration' })]);
    expect(await t.db.select().from(integrations)).toHaveLength(0);
  });

  it('skips a self-referential integration', async () => {
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [{ ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { ref: 'p1' } }],
    });
    const b = (await res.json()) as { skipped: { ref: string; reason: string }[] };
    expect(b.skipped[0]!.ref).toBe('i1');
    expect(b.skipped[0]!.reason).toMatch(/self-link/i);
  });

  it('recomputes the OLD endpoint count when an integration update moves an endpoint', async () => {
    const [prodA, prodB, prodC, intgId] = [uuid(1), uuid(2), uuid(3), uuid(4)];
    await seedProduct(prodA, 'a', 'A', { integrationCount: 1 });
    await seedProduct(prodB, 'b', 'B', { integrationCount: 1 });
    await seedProduct(prodC, 'c', 'C', { integrationCount: 0 });
    await t.db
      .insert(integrations)
      .values({ id: intgId, sourceProductId: prodA, targetProductId: prodB });

    const res = await promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgId,
          sourceProduct: { supabaseId: prodA },
          targetProduct: { supabaseId: prodC },
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { integrations: { ref: string; operation: string }[] };
    expect(b.integrations[0]).toMatchObject({ ref: 'i1', operation: 'updated' });

    const row = await t.db.query.integrations.findFirst({ where: eq(integrations.id, intgId) });
    expect(row).toMatchObject({ sourceProductId: prodA, targetProductId: prodC });
    const get = async (id: string) =>
      (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.integrationCount;
    expect(await get(prodA)).toBe(1);
    expect(await get(prodC)).toBe(1);
    expect(await get(prodB)).toBe(0); // OLD endpoint recomputed — the AECI-86 drift fix
  });

  it('returns 400 for a payload missing the product', async () => {
    const res = await promote({ vendors: [] });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string }; trace_id: string };
    expect(b.error.code).toBe('VALIDATION_FAILED');
    expect(b.trace_id).toBeTruthy();
  });

  it('returns 400 for duplicate refs', async () => {
    const res = await promote({
      vendors: [{ ref: 'dup', companyName: 'A' }],
      product: { ref: 'dup', name: 'Revit' },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await buildApp().request(
      '/api/promote',
      post('not json'),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'MALFORMED_REQUEST',
    );
  });

  it('returns 409 SLUG_CONFLICT when the batch trips a slug unique constraint', async () => {
    // Inject the SQLite UNIQUE error the DB would raise on a racing duplicate slug.
    (t.db as unknown as { batch: () => Promise<unknown[]> }).batch = () =>
      Promise.reject(new Error('UNIQUE constraint failed: products.slug'));

    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(409);
    const b = (await res.json()) as {
      error: { code: string; details?: { target?: unknown } };
      trace_id: string;
    };
    expect(b.error.code).toBe('SLUG_CONFLICT');
    expect(b.error.details?.target).toEqual(['slug']);
    expect(b.trace_id).toBeTruthy();
  });

  it('still returns 500 for a non-slug unique violation (no mislabeling)', async () => {
    (t.db as unknown as { batch: () => Promise<unknown[]> }).batch = () =>
      Promise.reject(
        new Error(
          'UNIQUE constraint failed: product_vendors.product_id, product_vendors.vendor_id',
        ),
      );

    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
  });
});

describe('usefulness resolution on promote (AECI-172)', () => {
  type UseGroup = { slug: string; name: string; points: string[] };
  type Stored = { audiences: UseGroup[]; phases: UseGroup[] };

  const seedAudience = (id: string, slug: string, name: string) =>
    t.db.insert(taxonomyAudiences).values({ id, slug, name });
  const seedPhase = (id: string, slug: string, name: string) =>
    t.db.insert(taxonomyPhases).values({ id, slug, name });
  const storedUsefulness = async (id: string) =>
    (await t.db.query.products.findFirst({ where: eq(products.id, id) }))!.usefulness;

  it('resolves groups by name and by slug, storing the canonical {slug,name}', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    await seedPhase(uuid(2), 'design', 'Design');

    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [{ name: 'Architecture', points: ['Coordinate models', 'Clash detection'] }],
          phases: [{ slug: 'design', points: ['Author drawings'] }],
        },
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string }; skipped: unknown[] };
    expect(b.skipped).toHaveLength(0);
    expect(await storedUsefulness(b.product.id)).toEqual({
      audiences: [
        {
          slug: 'architecture',
          name: 'Architecture',
          points: ['Coordinate models', 'Clash detection'],
        },
      ],
      phases: [{ slug: 'design', name: 'Design', points: ['Author drawings'] }],
    });
  });

  it('resolves usefulness against a term created in the same promote (runs after taxonomy)', async () => {
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        audiences: ['Architecture'],
        usefulness: { audiences: [{ name: 'Architecture', points: ['x'] }], phases: [] },
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string }; skipped: unknown[] };
    expect(b.skipped).toHaveLength(0);
    expect((await storedUsefulness(b.product.id)) as Stored).toMatchObject({
      audiences: [{ slug: 'architecture', name: 'Architecture', points: ['x'] }],
    });
  });

  it('merges same-term groups, concatenating points in source order', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [
            { slug: 'architecture', points: ['first'] },
            { name: 'Architecture', points: ['second'] },
          ],
          phases: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string } };
    expect(((await storedUsefulness(b.product.id)) as Stored).audiences).toEqual([
      { slug: 'architecture', name: 'Architecture', points: ['first', 'second'] },
    ]);
  });

  it('drops an unresolvable group and reports it in skipped[] with kind=usefulness', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [
            { name: 'Architecture', points: ['kept'] },
            { name: 'Nonexistent Discipline', points: ['dropped'] },
          ],
          phases: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      product: { id: string };
      skipped: { ref: string; kind: string }[];
    };
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'p1', kind: 'usefulness' })]);
    expect(((await storedUsefulness(b.product.id)) as Stored).audiences).toEqual([
      { slug: 'architecture', name: 'Architecture', points: ['kept'] },
    ]);
  });

  it('clears the column to NULL when usefulness is null', async () => {
    const prodX = uuid(3);
    await seedProduct(prodX, 'revit', 'Revit', {
      usefulness: {
        audiences: [{ slug: 'architecture', name: 'Architecture', points: ['old'] }],
        phases: [],
      },
    });
    const res = await promote({
      product: { ref: 'p1', supabaseId: prodX, name: 'Revit', usefulness: null },
    });
    expect(res.status).toBe(200);
    expect(await storedUsefulness(prodX)).toBeNull();
  });

  it('leaves the column NULL when usefulness is absent on a create', async () => {
    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string } };
    expect(await storedUsefulness(b.product.id)).toBeNull();
  });

  it('accepts and strips unknown keys inside a usefulness group (Zod passthrough off)', async () => {
    await seedAudience(uuid(1), 'architecture', 'Architecture');
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: {
          audiences: [{ slug: 'architecture', points: ['x'], bogusKey: 'ignored' }],
          phases: [],
        },
      },
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { product: { id: string } };
    expect(((await storedUsefulness(b.product.id)) as Stored).audiences).toEqual([
      { slug: 'architecture', name: 'Architecture', points: ['x'] },
    ]);
  });

  it('rejects a usefulness group with neither slug nor name', async () => {
    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        usefulness: { audiences: [{ points: ['x'] }], phases: [] },
      },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'VALIDATION_FAILED',
    );
  });
});

describe('runPromoteIngest — trades ingest (AECI-542)', () => {
  // `taxonomy_trades.description` is NOT NULL (`/trades/:slug` ships as an SEO
  // landing page, so copy is part of the contract — TRADES_VOCABULARY.md §5).
  const seedTrade = (id: string, slug: string, name: string, aliases: string[] = []) =>
    t.db.insert(taxonomyTrades).values({ id, slug, name, description: `${name} work.`, aliases });

  const tradeSlugsFor = async (productId: string) =>
    (
      await t.db
        .select({ slug: taxonomyTrades.slug })
        .from(productTrades)
        .innerJoin(taxonomyTrades, eq(taxonomyTrades.id, productTrades.tradeId))
        .where(eq(productTrades.productId, productId))
    )
      .map((r) => r.slug)
      .sort();

  type Body = {
    product: { id: string };
    taxonomy: { trades: { slug: string; id: string; operation: string }[] };
    skipped: { ref: string; kind: string; reason: string }[];
  };

  it('leaves behaviour unchanged for a payload with no trades key', async () => {
    await seedTrade(uuid(1), 'electrical', 'Electrical');

    const res = await promote({ product: { ref: 'p1', name: 'Revit' } });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    expect(b.taxonomy.trades).toEqual([]);
    expect(b.skipped).toHaveLength(0);
    expect(await tradeSlugsFor(b.product.id)).toEqual([]);
  });

  it('resolves by slug, name, and alias case-insensitively, deduping to one join row', async () => {
    await seedTrade(uuid(1), 'electrical', 'Electrical', ['Electrician']);
    await seedTrade(uuid(2), 'hvac-mechanical', 'HVAC & Mechanical', ['HVAC', 'Mechanical']);

    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        // slug, name (odd casing), alias, and a second alias for the SAME term.
        trades: ['electrical', 'hvac & MECHANICAL', 'Electrician', 'HVAC'],
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    expect(b.skipped).toHaveLength(0);
    expect(b.taxonomy.trades).toEqual([
      { slug: 'electrical', id: uuid(1), operation: 'reused' },
      { slug: 'hvac-mechanical', id: uuid(2), operation: 'reused' },
    ]);
    expect(await tradeSlugsFor(b.product.id)).toEqual(['electrical', 'hvac-mechanical']);
  });

  it('writes the join rows and the product audit row in ONE atomic batch (§26.1)', async () => {
    await seedTrade(uuid(1), 'electrical', 'Electrical');
    const realBatch = t.db.batch.bind(t.db) as (s: unknown[]) => Promise<unknown[]>;
    let batchCalls = 0;
    (t.db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch = (stmts) => {
      batchCalls += 1;
      return realBatch(stmts);
    };

    const res = await promote({
      product: { ref: 'p1', name: 'Revit', trades: ['electrical'] },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    // One batch — so the join rows and the audit row commit or roll back together.
    expect(batchCalls).toBe(1);
    expect(await tradeSlugsFor(b.product.id)).toEqual(['electrical']);
    // Resolve-only: the product audit row lands, but no term was minted, so there
    // is no `trade.created` action to log.
    const actions = await auditActions();
    expect(actions).toContain('product.created');
    expect(actions).not.toContain('trade.created');
  });

  it('reports an unresolvable trade in skipped[] (kind: trade) and creates no term', async () => {
    await seedTrade(uuid(1), 'paving-asphalt', 'Paving & Asphalt', ['Blacktop']);

    const res = await promote({
      product: {
        ref: 'p1',
        name: 'Revit',
        trades: ['paving-asphalt', 'paving-contractors'],
      },
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as Body;
    // The known trade still lands; only the unmatched value is dropped.
    expect(b.taxonomy.trades).toEqual([
      { slug: 'paving-asphalt', id: uuid(1), operation: 'reused' },
    ]);
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'p1', kind: 'trade' })]);
    expect(b.skipped[0]!.reason).toMatch(/paving-contractors/);
    expect(await tradeSlugsFor(b.product.id)).toEqual(['paving-asphalt']);
    // The governance guarantee: a typo must NEVER mint a term (§5.5a / ADR 0008).
    expect(await t.db.select().from(taxonomyTrades)).toHaveLength(1);
    expect(await auditActions()).not.toContain('trade.created');
  });

  it('replaces the whole trade set on re-promote, removing a previously-set tag', async () => {
    const prodId = uuid(9);
    await seedTrade(uuid(1), 'electrical', 'Electrical');
    await seedTrade(uuid(2), 'roofing', 'Roofing');
    await seedProduct(prodId, 'revit', 'Revit');
    await t.db.insert(productTrades).values([
      { productId: prodId, tradeId: uuid(1) },
      { productId: prodId, tradeId: uuid(2) },
    ]);

    const res = await promote({
      product: { ref: 'p1', supabaseId: prodId, name: 'Revit', trades: ['roofing'] },
    });

    expect(res.status).toBe(200);
    expect(await tradeSlugsFor(prodId)).toEqual(['roofing']);
  });

  it('clears every trade when the product is re-promoted without the key', async () => {
    const prodId = uuid(9);
    await seedTrade(uuid(1), 'electrical', 'Electrical');
    await seedProduct(prodId, 'revit', 'Revit');
    await t.db.insert(productTrades).values({ productId: prodId, tradeId: uuid(1) });

    const res = await promote({
      product: { ref: 'p1', supabaseId: prodId, name: 'Revit' },
    });

    expect(res.status).toBe(200);
    expect(await tradeSlugsFor(prodId)).toEqual([]);
  });

  // ── Publication gate → indexing pings (AECI-546) ───────────────────────────
  // The handler resolves the floor POST-commit and hands the same result to both
  // ping seams. This asserts the wiring end to end: the count must include the
  // rows this very promote just wrote, or a term crossing the floor is missed.
  describe('trade URLs handed to the indexing pings', () => {
    const SITE = 'https://aecintegrations.com';
    const pingEnv: Env = {
      ...baseEnv,
      INDEXNOW_KEY: 'k',
      PUBLIC_SITE_URL: SITE,
    };

    /** Promote with recording ping seams; returns whatever each seam received. */
    async function promoteWithPingSeams(body: unknown, env: Env) {
      const captured: Promise<AffectedUrlOptions>[] = [];
      const record: PromoteIndexNowNotify = async (_c, _r, tradeUrls) => {
        captured.push(tradeUrls);
      };
      const app = buildApp({ notifyIndexNow: record });
      const res = await app.request('/api/promote', post(body), env, fakeExecutionContext());
      expect(res.status).toBe(200);
      return { res, captured };
    }

    /** The ping configured → its seam fires exactly once with one resolution.
     *
     *  This used to assert that the SAME promise reached TWO seams (IndexNow and
     *  Google), which was the §20.2 "no second deriver" guarantee. AECI-747
     *  removed the Google ping, so there is only one consumer left and the
     *  shared-promise assertion has nothing to compare. The single-read property
     *  it protected still holds — `resolveTradeUrlOptions` is called once per
     *  promote — and is what the length check below pins. */
    async function promoteAndCaptureTradeUrls(body: unknown) {
      const { res, captured } = await promoteWithPingSeams(body, pingEnv);
      expect(captured).toHaveLength(1);
      return { res, tradeUrls: await captured[0]! };
    }

    // `plumbing` is the load-bearing half: it has ZERO products until this promote
    // writes its link, so it clears the floor only if the resolver counts AFTER the
    // commit. A pre-commit read would see 0 and drop it. (At TRADE_PUBLISH_MIN_PRODUCTS
    // = 1 this is the only way a *set* trade can be sub-floor at all — one the promote
    // tags always ends with at least one product. The sub-floor exclusion itself is
    // covered by the removal test below, where a term drops back to zero.)
    it('submits trades this promote pushed over the floor, counting rows it just wrote', async () => {
      await seedTrade(uuid(1), 'electrical', 'Electrical');
      await seedTrade(uuid(2), 'plumbing', 'Plumbing');
      // Two products already carry `electrical`; the promoted one makes three.
      // Nothing carries `plumbing` — this promote takes it 0 → 1.
      for (const n of [10, 11]) {
        await seedProduct(uuid(n), `p${n}`, `P${n}`);
        await t.db.insert(productTrades).values({ productId: uuid(n), tradeId: uuid(1) });
      }

      const { res, tradeUrls } = await promoteAndCaptureTradeUrls({
        product: { ref: 'p1', name: 'Revit', trades: ['electrical', 'plumbing'] },
      });

      expect(tradeUrls.publishedTradeSlugs?.slice().sort()).toEqual(['electrical', 'plumbing']);
      const urls = affectedUrlsForPromote((await res.json()) as PromoteResponse, SITE, tradeUrls);
      expect(urls).toContain(`${SITE}/trades/electrical`);
      expect(urls).toContain(`${SITE}/trades/plumbing`);
      expect(urls).toContain(`${SITE}/trades`);
    });

    // A removal is not echoed on the response, so it reaches the ping only via
    // `removedTradeSlugs` — and it must be re-counted post-commit, since dropping
    // the link may have pushed the term back under the floor.
    it('carries removed trades through and re-counts them after the write', async () => {
      const prodId = uuid(9);
      await seedTrade(uuid(1), 'electrical', 'Electrical');
      await seedProduct(prodId, 'revit', 'Revit');
      await t.db.insert(productTrades).values({ productId: prodId, tradeId: uuid(1) });

      const { tradeUrls } = await promoteAndCaptureTradeUrls({
        product: { ref: 'p1', supabaseId: prodId, name: 'Revit' },
      });

      expect(tradeUrls.removedTradeSlugs).toEqual(['electrical']);
      // Down to zero products → unpublished → no term URL submitted.
      expect(tradeUrls.publishedTradeSlugs).toEqual([]);
    });

    // Trades are sparse by design: the overwhelming majority of promotes touch
    // none, and must not pay for the floor read.
    it('resolves to empty options when no trade was touched', async () => {
      const { tradeUrls } = await promoteAndCaptureTradeUrls({
        product: { ref: 'p1', name: 'Revit' },
      });

      expect(tradeUrls).toEqual({});
    });

    // Pre-launch, neither ping is provisioned (their secrets ARE the gate), so
    // nothing is submitted and the floor read never runs.
    it('fires no ping at all when neither is configured', async () => {
      await seedTrade(uuid(1), 'electrical', 'Electrical');

      const { captured } = await promoteWithPingSeams(
        { product: { ref: 'p1', name: 'Revit', trades: ['electrical'] } },
        baseEnv,
      );

      expect(captured).toEqual([]);
    });

    // AECI-747 removed the Google Indexing ping, so IndexNow is the only thing
    // that can arm this resolution. The floor read is not free — it is an extra
    // D1 query per trade-touching promote — so it must stay gated on a ping
    // actually being configured.
    it('does not resolve the floor when no ping is configured', async () => {
      await seedTrade(uuid(1), 'electrical', 'Electrical');
      for (const n of [10, 11]) {
        await seedProduct(uuid(n), `p${n}`, `P${n}`);
        await t.db.insert(productTrades).values({ productId: uuid(n), tradeId: uuid(1) });
      }

      const { captured } = await promoteWithPingSeams(
        { product: { ref: 'p1', name: 'Revit', trades: ['electrical'] } },
        { ...baseEnv, PUBLIC_SITE_URL: SITE },
      );

      expect(captured).toEqual([]);
    });
  });
});

describe('runPromoteIngest — claims ingest (AECI-297)', () => {
  it('ingests claims + attestations for a created integration and returns the pair slugs', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs', ['RFI', 'Requests for Information']);

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: { ref: string; sourceSlug?: string; targetSlug?: string }[];
      skipped: unknown[];
    };
    expect(b.skipped).toHaveLength(0);
    // The two product slugs ride back so the pair derivers need no DB read.
    expect(b.integrations[0]).toMatchObject({ sourceSlug: 'revit', targetSlug: 'navisworks' });

    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ dataObjectId: uuid(20), direction: 'a_to_b' });

    const attRows = await t.db.select().from(attestations);
    expect(attRows).toHaveLength(1);
    expect(attRows[0]).toMatchObject({ claimId: claimRows[0]!.id, source: 'aeci', asserted: true });

    expect(await auditActions()).toEqual(
      expect.arrayContaining(['integration.created', 'claim.created', 'attestation.created']),
    );
  });

  it('collapses a repeated attestation source within one claim rather than failing the batch', async () => {
    // `attestations_slot_key` (AECI-603) is unique on (claim_id, source) among
    // non-retracted rows, so without the in-payload dedupe a bundle that repeated a
    // source would take down the WHOLE promote, not just the duplicate row. First
    // occurrence wins, matching the claim-identity dedupe.
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs', []);

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [
                { source: 'aeci', asserted: true, note: 'first' },
                { source: 'aeci', asserted: false, note: 'duplicate' },
              ],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const attRows = await t.db.select().from(attestations);
    expect(attRows).toHaveLength(1);
    expect(attRows[0]).toMatchObject({ source: 'aeci', asserted: true, note: 'first' });
  });

  it('returns poweredBySlug for an integration powered by a connector product (Addendum B)', async () => {
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          claims: [],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: { ref: string; id: string; poweredBySlug?: string }[];
    };
    // The connector's slug rides back so the cache-tag deriver can purge its own
    // product page — it is neither endpoint, so no other tag reaches it.
    expect(b.integrations[0]).toMatchObject({ poweredBySlug: 'agave-erp-sync' });

    // AECI-721: the edge is ROUTED, not written to `integrations`. Without this the
    // migration undoes itself — the next promote of either endpoint would put every
    // migrated edge straight back, and both tables are summed, so it would then be
    // counted twice.
    expect(await t.db.select().from(integrations)).toEqual([]);
    const pairs = await t.db.select().from(connectorEvidencedPairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      id: b.integrations[0]!.id,
      connectorProductId: connector,
      // `mechanism_kind` has nowhere to go — the table has no such column, because
      // the lane answers "which mechanism".
      mechanismName: null,
    });
  });

  it('routes a connector-powered edge to the evidenced tier, canonicalised (AECI-721)', async () => {
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          mechanismKind: 'marketplace-app',
          mechanismName: 'Agave ERP Sync',
          direction: 'one-way',
          listingUrl: 'https://useagave.com/x',
          claims: [],
        },
      ],
    });
    expect(res.status).toBe(200);

    const [pair] = await t.db.select().from(connectorEvidencedPairs);
    // Canonical order is a CHECK, so the planner sorts the endpoints and moves the
    // orientation into `direction` — using claims' vocabulary, because once the pair
    // is ordered `one-way` no longer says which way.
    const sourceId = (await t.db.select().from(products).where(eq(products.slug, 'revit')))[0]!.id;
    const [a, b2] = [sourceId, target].sort();
    expect(pair).toMatchObject({
      productAId: a,
      productBId: b2,
      direction: sourceId < target ? 'a_to_b' : 'b_to_a',
      listingUrl: 'https://useagave.com/x',
      mechanismName: 'Agave ERP Sync',
    });
  });

  // ── AECI-921: the direction vocabulary on the wire ──────────────────────────
  describe('integration direction (AECI-921)', () => {
    const promoteEdge = async (direction: string | null) => {
      const target = uuid(1);
      await seedProduct(target, 'navisworks', 'Navisworks');
      const res = await promote({
        product: { ref: 'p1', name: 'Revit' },
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: target },
            mechanismKind: 'native',
            direction,
            claims: [],
          },
        ],
      });
      expect(res.status).toBe(200);
      const [row] = await t.db.select().from(integrations);
      return row!;
    };

    it('normalises the LEGACY wire spellings — the review app deploys separately', async () => {
      // The review app is a different repo on a different deploy, so there is no
      // moment at which both sides change spelling together. A promote carrying
      // `one-way` mid-window must land, not 400.
      expect((await promoteEdge('one-way')).direction).toBe('a_to_b');
    });

    it('normalises legacy `bidirectional` to `both`', async () => {
      expect((await promoteEdge('bidirectional')).direction).toBe('both');
    });

    it('stores `b_to_a` — the value the old wire could not express', async () => {
      // THE POINT OF AECI-921. Upstream orders endpoints by who BUILT the
      // connector, so a read-only consumer edge keeps its authorship ordering and
      // says the flow runs the other way. Before this it arrived as `one-way` and
      // rendered backwards (AECI-920).
      expect((await promoteEdge('b_to_a')).direction).toBe('b_to_a');
    });

    it('stores `a_to_b` unchanged', async () => {
      expect((await promoteEdge('a_to_b')).direction).toBe('a_to_b');
    });

    it('stores `both` unchanged', async () => {
      expect((await promoteEdge('both')).direction).toBe('both');
    });

    it('keeps null as null — nobody established it', async () => {
      expect((await promoteEdge(null)).direction).toBeNull();
    });

    it('rejects a value in neither vocabulary', async () => {
      const target = uuid(1);
      await seedProduct(target, 'navisworks', 'Navisworks');
      const res = await promote({
        product: { ref: 'p1', name: 'Revit' },
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: target },
            direction: 'sideways',
            claims: [],
          },
        ],
      });
      expect(res.status).toBe(400);
    });

    it('RE-ANCHORS `b_to_a` when routing to the evidenced tier', async () => {
      // The evidenced table's A/B is the id-sorted canonical order, not the
      // payload's source/target. So the wire value has to be re-anchored, and
      // whether it flips depends on which endpoint sorts first.
      const target = uuid(1);
      const connector = uuid(2);
      await seedProduct(target, 'navisworks', 'Navisworks');
      await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', {
        productRole: 'connector',
      });

      const res = await promote({
        product: { ref: 'p1', name: 'Revit' },
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: target },
            poweredByProduct: { supabaseId: connector },
            mechanismKind: 'marketplace-app',
            direction: 'b_to_a',
            listingUrl: 'https://useagave.com/x',
            claims: [],
          },
        ],
      });
      expect(res.status).toBe(200);

      const sourceId = (await t.db.select().from(products).where(eq(products.slug, 'revit')))[0]!
        .id;
      const [pair] = await t.db.select().from(connectorEvidencedPairs);
      // Payload says "flows target -> source". If the payload's source is already
      // endpoint A, that stays `b_to_a`; if the sort flips them, it becomes `a_to_b`.
      expect(pair!.direction).toBe(sourceId < target ? 'b_to_a' : 'a_to_b');
    });
  });

  it('keeps a Convention-A self-referential edge in `integrations` (§13.2a)', async () => {
    // `powered_by` equal to one of its own endpoints — ~60 production rows (Aquifer,
    // Kroo). Routing it would render "Via Aquifer → Aquifer", and the destination's
    // distinct-connector CHECK refuses it outright.
    const connector = uuid(2);
    await seedProduct(connector, 'aquifer', 'Aquifer', { productRole: 'connector' });

    const res = await promote({
      product: { ref: 'p1', name: 'ADP Workforce Now' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: connector },
          poweredByProduct: { supabaseId: connector },
          mechanismKind: 'iPaaS',
          claims: [],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    const rows = await t.db.select().from(integrations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ poweredByProductId: connector, mechanismKind: 'iPaaS' });
  });

  it("anchors a routed edge's claims on the evidenced pair, not on `integrations`", async () => {
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });
    await seedDataObject(uuid(3), 'rfis', 'RFIs');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          claims: [{ dataObject: 'rfis', direction: 'a_to_b', attestations: [] }],
        },
      ],
    });
    expect(res.status).toBe(200);

    const [pair] = await t.db.select().from(connectorEvidencedPairs);
    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    // "Nothing silently dropped" — the claim rides the edge into the other table
    // rather than being orphaned or skipped, and `anchor_id` is what carries its
    // identity across.
    expect(claimRows[0]).toMatchObject({
      integrationId: null,
      connectorEvidencedPairId: pair!.id,
      anchorId: pair!.id,
    });
  });

  it('re-promotes an already-routed evidenced pair as an UPDATE, not a duplicate (AECI-721)', async () => {
    // The migration preserves an edge's id when it moves it to the evidenced tier,
    // so the review app keeps re-sending that id as the integration's `supabaseId`.
    // A pre-read that consulted only `integrations` would find nothing, route the
    // edge to a fresh-id INSERT, and collide on `connector_evidenced_pairs_pair_idx`
    // — turning a routine re-promote of any of the 19 migrated production edges into
    // a failed batch (an outage), which is exactly what the routing comment warns of.
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    const intg = {
      ref: 'i1',
      sourceProduct: { ref: 'p1' },
      targetProduct: { supabaseId: target },
      poweredByProduct: { supabaseId: connector },
      mechanismName: 'Agave ERP Sync',
      claims: [],
    };

    const first = await promote({ product: { ref: 'p1', name: 'Revit' }, integrations: [intg] });
    expect(first.status).toBe(200);
    const pairId = ((await first.json()) as { integrations: { id: string }[] }).integrations[0]!.id;

    // Second push: the review app hands back the id the migration preserved.
    const second = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [{ ...intg, supabaseId: pairId, mechanismName: 'Agave ERP Sync v2' }],
    });
    expect(second.status).toBe(200);
    expect(
      ((await second.json()) as { integrations: { id: string; operation: string }[] })
        .integrations[0],
    ).toMatchObject({ id: pairId, operation: 'updated' });

    // One row, updated in place — no duplicate, no collision.
    const pairs = await t.db.select().from(connectorEvidencedPairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ id: pairId, mechanismName: 'Agave ERP Sync v2' });
    expect(await t.db.select().from(integrations)).toEqual([]);
  });

  it('moves an existing `integrations` edge into the evidenced tier, preserving its claims and vendor attestations (AECI-721)', async () => {
    // A curator adds a third-party connector to an edge that was already promoted as
    // an accountable-party integration. The edge must MOVE tables with its id intact,
    // and its claims (and their vendor attestations) must ride along — a naive
    // "UPDATE the evidenced row then DELETE the integrations row" writes nothing while
    // the `ON DELETE CASCADE` takes the claim and its attestations with it.
    const target = uuid(1);
    const connector = uuid(2);
    const vendor = uuid(4);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });
    await seedVendor(vendor, 'acme', 'Acme');
    await seedDataObject(uuid(3), 'rfis', 'RFIs');

    // First push: a plain integration (no connector) carrying one claim.
    const claim = {
      dataObject: 'rfis',
      direction: 'a_to_b' as const,
      attestations: [{ source: 'aeci' as const, asserted: true }],
    };
    const first = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [claim],
        },
      ],
    });
    expect(first.status).toBe(200);
    const [intgRow] = await t.db.select().from(integrations);
    const [claimRow] = await t.db.select().from(claims);
    expect(intgRow?.poweredByProductId).toBeNull();

    // A vendor has independently attested to that claim — promote can never write
    // this, so seed it directly; it is the row a cascade would silently destroy.
    await t.db.insert(attestations).values({
      id: uuid(5),
      claimId: claimRow!.id,
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: vendor,
    });

    // Second push: the same edge, now powered by the connector → routes to evidenced.
    const second = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgRow!.id,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          claims: [claim],
        },
      ],
    });
    expect(second.status).toBe(200);

    // The edge left `integrations` and landed in the evidenced tier with its id kept.
    expect(await t.db.select().from(integrations)).toEqual([]);
    const pairs = await t.db.select().from(connectorEvidencedPairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.id).toBe(intgRow!.id);

    // The claim rode along: same row id, re-anchored, not cascade-deleted.
    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({
      id: claimRow!.id,
      integrationId: null,
      connectorEvidencedPairId: intgRow!.id,
    });

    // The vendor attestation survived the move — the whole point of re-homing before
    // the delete rather than after.
    const vendorAtts = (await t.db.select().from(attestations)).filter(
      (a) => a.source === 'vendor_a',
    );
    expect(vendorAtts).toHaveLength(1);
    expect(vendorAtts[0]).toMatchObject({ claimId: claimRow!.id, attestedByVendorId: vendor });
  });

  // ─── AECI-888: the REVERSE move, and the two ways it must NOT fire ──────────
  //
  // AECI-798 diagnosed this and shipped only the cleanup. Clearing `powered_by` on a
  // promoted edge routed it back to `integrations`, the pre-read looked in one table,
  // found nothing, called the id dead and minted a fresh row — leaving the evidenced
  // row addressable by nothing, for ever. The public symptom was the edge rendering
  // twice on three URLs.
  //
  // The trigger is narrower than "the key is not set". §3.6 says an OMITTED key means
  // "no opinion" and AECI-730 says an unresolvable one leaves the stored value alone,
  // so neither may move a row. Only an explicit `null` is a statement. The four cases
  // below are that distinction, and the round-trip after them is the count argument.

  /** An edge already living in the evidenced tier, with a claim and a vendor
   *  attestation on it — the two rows a mis-ordered cascade would destroy. */
  async function seedRoutedEdge(ids: { target: string; connector: string; vendor: string }) {
    await seedProduct(ids.target, 'navisworks', 'Navisworks');
    await seedProduct(ids.connector, 'agave-erp-sync', 'Agave ERP Sync', {
      productRole: 'connector',
    });
    await seedVendor(ids.vendor, 'acme', 'Acme');
    await seedDataObject(uuid(90), 'rfis', 'RFIs');

    const claim = {
      dataObject: 'rfis',
      direction: 'a_to_b' as const,
      attestations: [{ source: 'aeci' as const, asserted: true }],
    };
    const first = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: ids.target },
          poweredByProduct: { supabaseId: ids.connector },
          mechanismKind: 'iPaaS',
          direction: 'one-way',
          claims: [claim],
        },
      ],
    });
    expect(first.status).toBe(200);
    const [pair] = await t.db.select().from(connectorEvidencedPairs);
    const [claimRow] = await t.db.select().from(claims);
    // Promote can never write a vendor attestation, so seed it. It is the row that
    // disappears if the pair is dropped before its claims are re-homed.
    await t.db.insert(attestations).values({
      id: uuid(91),
      claimId: claimRow!.id,
      source: 'vendor_a',
      asserted: true,
      attestedByVendorId: ids.vendor,
    });
    return { pairId: pair!.id, claimId: claimRow!.id, claim };
  }

  it('moves an evidenced pair back into `integrations` when poweredByProduct is explicitly cleared (AECI-888)', async () => {
    const ids = { target: uuid(1), connector: uuid(2), vendor: uuid(4) };
    const { pairId, claimId, claim } = await seedRoutedEdge(ids);

    // The AECI-798 payload verbatim: the curator corrected the edge to `native` and
    // cleared the connector. `null`, not an omitted key — that is what makes it a move.
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: pairId,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: ids.target },
          poweredByProduct: null,
          mechanismKind: 'native',
          direction: 'one-way',
          claims: [claim],
        },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromoteResponse;

    // The row moved and kept its id. Before AECI-888 this was a second row under a
    // fresh uuid, with the pair left behind and unreachable.
    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    const rows = await t.db.select().from(integrations);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: pairId,
      poweredByProductId: null,
      mechanismKind: 'native',
    });
    expect(body.integrations[0]).toMatchObject({ id: pairId, operation: 'updated' });

    // The claim rode across on the same row id, so the vendor attestation kept its slot.
    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({
      id: claimId,
      integrationId: pairId,
      connectorEvidencedPairId: null,
    });
    const vendorAtts = (await t.db.select().from(attestations)).filter(
      (a) => a.source === 'vendor_a',
    );
    expect(vendorAtts).toHaveLength(1);

    // The move is recorded. Same action and entity id as an ordinary update, so
    // `movedFrom` is the only thing that distinguishes the two after the fact.
    const moved = (await t.db.select().from(auditLog)).filter(
      (e) => e.action === 'integration.updated',
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]!.metadata).toMatchObject({ movedFrom: 'connector_evidenced_pairs' });
  });

  it('carries maintained_by and last_reviewed_at ACROSS the move (AECI-981)', async () => {
    // The fence guards UPDATEs; a move is an INSERT plus a drop, so it needs its
    // own carry. Without one the destination row takes the `'aeci'` column
    // default and an ordinary promote silently un-vendors an edge a vendor
    // maintains — the failure §13.3 exists to prevent, through a door it did not
    // cover.
    const ids = { target: uuid(1), connector: uuid(2), vendor: uuid(4) };
    const { pairId } = await seedRoutedEdge(ids);
    const held = '2026-03-04T00:00:00.000Z';
    await t.db
      .update(connectorEvidencedPairs)
      .set({ maintainedBy: 'vendor', lastReviewedAt: held })
      .where(eq(connectorEvidencedPairs.id, pairId));

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: pairId,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: ids.target },
          poweredByProduct: null,
          mechanismKind: 'native',
          direction: 'one-way',
        },
      ],
    });
    expect(res.status).toBe(200);

    const moved = await t.db.query.integrations.findFirst({
      where: eq(integrations.id, pairId),
    });
    expect(moved?.maintainedBy).toBe('vendor');
    expect(moved?.lastReviewedAt).toBe(held);
  });

  it('does NOT report a stale supabaseId when the id resolves in the other anchor table (AECI-888 narrows AECI-568)', async () => {
    const ids = { target: uuid(1), connector: uuid(2), vendor: uuid(4) };
    const { pairId, claim } = await seedRoutedEdge(ids);

    const staleIds: string[] = [];
    const rc: PromoteRunCtx = {
      env: baseEnv,
      request: new Request('http://localhost:8787/api/promote'),
      waitUntil: () => {},
      bookmark: () => null,
    };
    const result = await runPromoteIngest(
      rc,
      PromotePayloadSchema.parse({
        product: { ref: 'p1', name: 'Revit' },
        integrations: [
          {
            ref: 'i1',
            supabaseId: pairId,
            sourceProduct: { ref: 'p1' },
            targetProduct: { supabaseId: ids.target },
            poweredByProduct: null,
            claims: [claim],
          },
        ],
      }),
      {
        dbFor: recordingFactory(t.db).factory,
        syncAlgolia: noopAlgolia,
        notifyIndexNow: noopIndexNow,
        refreshHomeStats: noopHomeStats,
      },
    );
    staleIds.push(...result.staleSupabaseIds.map((s) => s.supabaseId));
    // A live pointer into the pairs table is not a dead pointer. Reporting it as one is
    // what fed `aeci.api.promote.stale_id` a population that was never stale.
    expect(staleIds).toEqual([]);
  });

  it('leaves an evidenced pair where it is when poweredByProduct is OMITTED (AECI-888 / §3.6)', async () => {
    const ids = { target: uuid(1), connector: uuid(2), vendor: uuid(4) };
    const { pairId, claim } = await seedRoutedEdge(ids);

    // No `poweredByProduct` key at all. §3.6: absent means "no opinion", so the stored
    // connector still applies and the edge has not been re-routed. Moving it here would
    // be inference from absence — the thing ADR 0030 refuses.
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: pairId,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: ids.target },
          description: 'edited copy, nothing said about the connector',
          claims: [claim],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(await t.db.select().from(integrations)).toEqual([]);
    const pairs = await t.db.select().from(connectorEvidencedPairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      id: pairId,
      connectorProductId: ids.connector,
      description: 'edited copy, nothing said about the connector',
    });
  });

  it('leaves an evidenced pair where it is when poweredByProduct does not resolve (AECI-888 / AECI-730)', async () => {
    const ids = { target: uuid(1), connector: uuid(2), vendor: uuid(4) };
    const { pairId, claim } = await seedRoutedEdge(ids);

    // An unpromoted connector resolves to `undefined`, which AECI-730 defines as
    // "leave the stored column alone". Same conclusion as the omitted key: no move.
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: pairId,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: ids.target },
          poweredByProduct: { supabaseId: uuid(77) },
          claims: [claim],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(await t.db.select().from(integrations)).toEqual([]);
    const pairs = await t.db.select().from(connectorEvidencedPairs);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ id: pairId, connectorProductId: ids.connector });

    // Still reported (AECI-730 / §3.4a). An unresolvable key is UNSTATED, so since
    // AECI-888 it stays on this branch instead of falling through to the shared
    // reporter — which is how `field:powered_by` could lose the whole connector tier.
    const body = (await res.json()) as PromoteResponse;
    expect(body.unresolvedLinks).toEqual([
      expect.objectContaining({ ref: 'i1', field: 'powered_by', outcome: 'preserved' }),
    ]);
  });

  it('moves the edge to `integrations` when the inherited connector has become an endpoint (Convention A, §13.2a)', async () => {
    const ids = { target: uuid(1), connector: uuid(2), vendor: uuid(4) };
    const { pairId, claim } = await seedRoutedEdge(ids);

    // The payload says nothing about the connector, so the stored one is inherited —
    // but an endpoint has since MOVED onto it. `connector_evidenced_pairs_distinct_connector`
    // would reject that row and fail the whole batch, turning a routine re-promote into
    // an outage. Convention A puts a self-referential edge in `integrations` instead.
    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: pairId,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: ids.connector },
          claims: [claim],
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(await t.db.select().from(connectorEvidencedPairs)).toEqual([]);
    const rows = await t.db.select().from(integrations);
    expect(rows).toHaveLength(1);
    // The connector is not discarded — it rides in the column that can hold a
    // self-reference, which is exactly what the ~60 production Convention A rows do.
    expect(rows[0]).toMatchObject({
      id: pairId,
      targetProductId: ids.connector,
      poweredByProductId: ids.connector,
    });
  });

  it('round-trips an edge across both tables without changing any count, and loses only `mechanism_kind` (AECI-888)', async () => {
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    // The SOURCE product must be re-addressed by id on every push. Omitting its
    // `supabaseId` creates `revit-2` on push 2 and measures a different product.
    const source = uuid(3);
    await seedProduct(source, 'revit', 'Revit');

    const edge = (extra: Record<string, unknown>) => ({
      product: { ref: 'p1', supabaseId: source, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [],
          ...extra,
        },
      ],
    });
    const totals = async () => {
      const i = await t.db.select().from(integrations);
      const p = await t.db.select().from(connectorEvidencedPairs);
      const all = await t.db.select().from(products);
      return {
        products: all.length,
        rows: i.length + p.length,
        // The three products the edge can ever count for: both endpoints and, while it
        // is routed, the connector. §13.5 option B is the reason the third one moves.
        counts: Object.fromEntries(all.map((x) => [x.slug, x.integrationCount])),
      };
    };

    // 1. Born in `integrations`. The connector counts nothing yet.
    const a = await promote(edge({ mechanismKind: 'native', direction: 'one-way' }));
    const id = ((await a.json()) as PromoteResponse).integrations[0]!.id;
    expect(await totals()).toEqual({
      products: 3,
      rows: 1,
      counts: { revit: 1, navisworks: 1, 'agave-erp-sync': 0 },
    });

    // 2. Gains a connector → moves to the evidenced tier, id preserved. One row still,
    //    because the two tables are summed everywhere (§13.5) — and the connector now
    //    counts the edge too.
    await promote(
      edge({ supabaseId: id, poweredByProduct: { supabaseId: connector }, direction: 'one-way' }),
    );
    expect(await totals()).toEqual({
      products: 3,
      rows: 1,
      counts: { revit: 1, navisworks: 1, 'agave-erp-sync': 1 },
    });
    expect((await t.db.select().from(connectorEvidencedPairs))[0]).toMatchObject({ id });

    // 3. Connector cleared → moves back, still one row, and the connector's count drops
    //    to zero. That drop is the AECI-888 recompute: before it, the old connector's
    //    hub kept counting an edge it no longer carried.
    //
    //    `mechanismKind` is deliberately NOT restated here, and it cannot be recovered —
    //    `connector_evidenced_pairs` has no such column, so step 2 dropped the value.
    //    The loss is real and silent, so it is asserted rather than discovered. The
    //    column is nullable and the CHECK passes on NULL.
    await promote(edge({ supabaseId: id, poweredByProduct: null, direction: 'one-way' }));
    expect(await totals()).toEqual({
      products: 3,
      rows: 1,
      counts: { revit: 1, navisworks: 1, 'agave-erp-sync': 0 },
    });
    const [back] = await t.db.select().from(integrations);
    expect(back).toMatchObject({ id, poweredByProductId: null, mechanismKind: null });

    // 4. Restating it puts the value back. Nothing else has to be replayed.
    await promote(
      edge({
        supabaseId: id,
        poweredByProduct: null,
        mechanismKind: 'native',
        direction: 'one-way',
      }),
    );
    const [restored] = await t.db.select().from(integrations);
    expect(restored).toMatchObject({ id, mechanismKind: 'native' });
  });

  it('omits poweredBySlug when the integration names no powered-by product', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as { integrations: { poweredBySlug?: string }[] };
    expect(b.integrations[0]?.poweredBySlug).toBeUndefined();
  });

  // ── AECI-730: unresolvable optional links ────────────────────────────────────
  // An unresolvable ENDPOINT refuses the whole row into `skipped[]`. The two
  // OPTIONAL links used to do neither: the edge was written with the FK silently
  // NULLed, and on an UPDATE that actively cleared a correct value an earlier
  // promote had set. Both halves are covered here — the report and the guard.
  describe('unresolved optional links (AECI-730)', () => {
    /** Body promoting one edge Revit→Navisworks, with whatever link overrides. */
    const edge = (overrides: Record<string, unknown>) => ({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid(1) },
          claims: [],
          ...overrides,
        },
      ],
    });

    const body = async (res: Response) => (await res.json()) as PromoteResponse;

    beforeEach(async () => {
      await seedProduct(uuid(1), 'navisworks', 'Navisworks');
    });

    it('writes the integration but reports the connector, on create', async () => {
      // uuid(9) is a product that was never promoted — the Zapier/Workato case.
      const res = await promote(edge({ poweredByProduct: { supabaseId: uuid(9) } }));
      expect(res.status).toBe(200);
      const b = await body(res);

      // The row LANDS — this is the difference from `skipped[]`.
      expect(b.integrations).toHaveLength(1);
      expect(b.skipped).toHaveLength(0);
      const rows = await t.db.select().from(integrations);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.poweredByProductId).toBeNull();

      expect(b.unresolvedLinks).toHaveLength(1);
      expect(b.unresolvedLinks![0]).toMatchObject({
        ref: 'i1',
        field: 'powered_by',
        supabaseId: uuid(9),
        outcome: 'unset',
      });
      expect(b.unresolvedLinks![0]!.reason).toContain('powered_by_product_id left unset');
      // No slug either — nothing to purge, because nothing is linked.
      expect(b.integrations[0]!.poweredBySlug).toBeUndefined();
    });

    it('does NOT clear an existing powered_by when the connector stops resolving', async () => {
      // The clobber regression. The stored FK is correct; the payload names a
      // connector that no longer resolves. Before AECI-730 this wrote NULL.
      const connector = uuid(2);
      await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', {
        productRole: 'connector',
      });
      await t.db.insert(integrations).values({
        id: uuid(5),
        sourceProductId: uuid(1),
        targetProductId: connector,
        poweredByProductId: connector,
      });

      const res = await promote(
        edge({ supabaseId: uuid(5), poweredByProduct: { supabaseId: uuid(9) } }),
      );
      expect(res.status).toBe(200);
      const b = await body(res);

      const rows = await t.db.select().from(integrations);
      expect(rows[0]!.poweredByProductId).toBe(connector);
      expect(b.unresolvedLinks![0]).toMatchObject({ field: 'powered_by', outcome: 'preserved' });
      expect(b.unresolvedLinks![0]!.reason).toContain('powered_by_product_id left unchanged');
      // The preserved connector still rides back, so its own product page — which
      // renders this edge in its "Integrations it powers" hub — is still purged.
      expect(b.integrations[0]!.poweredBySlug).toBe('agave-erp-sync');
    });

    it('leaves powered_by untouched when the payload omits the key', async () => {
      const connector = uuid(2);
      await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync');
      await t.db.insert(integrations).values({
        id: uuid(5),
        sourceProductId: uuid(1),
        targetProductId: connector,
        poweredByProductId: connector,
      });

      const res = await promote(edge({ supabaseId: uuid(5) }));
      expect(res.status).toBe(200);
      const b = await body(res);

      // Omission means "no opinion", exactly as `compact()` treats every scalar.
      const rows = await t.db.select().from(integrations);
      expect(rows[0]!.poweredByProductId).toBe(connector);
      expect(b.unresolvedLinks).toHaveLength(0);
    });

    it('still clears powered_by on an explicit null', async () => {
      // The curator's removal path has to keep working — the guard must not swallow it.
      const connector = uuid(2);
      await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync');
      await t.db.insert(integrations).values({
        id: uuid(5),
        sourceProductId: uuid(1),
        targetProductId: connector,
        poweredByProductId: connector,
      });

      const res = await promote(edge({ supabaseId: uuid(5), poweredByProduct: null }));
      expect(res.status).toBe(200);
      const b = await body(res);

      const rows = await t.db.select().from(integrations);
      expect(rows[0]!.poweredByProductId).toBeNull();
      expect(b.unresolvedLinks).toHaveLength(0);
      expect(b.integrations[0]!.poweredBySlug).toBeUndefined();
    });

    it('applies the same guard + report to builtByVendor', async () => {
      const vendorId = uuid(3);
      await seedVendor(vendorId, 'autodesk', 'Autodesk');
      // Distinct endpoints — `integrations_distinct_endpoints_check` rejects a self-link.
      await seedProduct(uuid(4), 'civil-3d', 'Civil 3D');
      await t.db.insert(integrations).values({
        id: uuid(5),
        sourceProductId: uuid(1),
        targetProductId: uuid(4),
        builtByVendorId: vendorId,
      });

      const res = await promote(
        edge({ supabaseId: uuid(5), builtByVendor: { supabaseId: uuid(9) } }),
      );
      expect(res.status).toBe(200);
      const b = await body(res);

      const rows = await t.db.select().from(integrations);
      expect(rows[0]!.builtByVendorId).toBe(vendorId);
      expect(b.unresolvedLinks).toHaveLength(1);
      expect(b.unresolvedLinks![0]).toMatchObject({
        ref: 'i1',
        field: 'built_by',
        supabaseId: uuid(9),
        outcome: 'preserved',
      });
      expect(b.unresolvedLinks![0]!.reason).toContain('built_by_vendor_id left unchanged');
    });

    it('reports both links independently on one integration', async () => {
      const res = await promote(
        edge({
          poweredByProduct: { supabaseId: uuid(9) },
          builtByVendor: { supabaseId: uuid(8) },
        }),
      );
      expect(res.status).toBe(200);
      const b = await body(res);

      expect(b.unresolvedLinks?.map((l) => l.field).sort()).toEqual(['built_by', 'powered_by']);
      expect(b.unresolvedLinks!.every((l) => l.outcome === 'unset')).toBe(true);
    });

    it('is an empty array on a clean promote', async () => {
      const res = await promote(edge({}));
      expect(res.status).toBe(200);
      expect((await body(res)).unresolvedLinks).toEqual([]);
    });
  });

  it('reports an unresolved dataObject in skipped[] (kind: claim), never a 500', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [{ dataObject: 'not-a-real-object', direction: 'both', attestations: [] }],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: unknown[];
      skipped: { ref: string; kind: string }[];
    };
    // The integration still lands; only the unresolved claim is skipped.
    expect(b.integrations).toHaveLength(1);
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'i1', kind: 'claim' })]);
    expect(await t.db.select().from(claims)).toHaveLength(0);
    expect(await t.db.select().from(integrations)).toHaveLength(1);
  });

  it('resolves a dataObject by alias (case-insensitive)', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'models', 'Models', ['BIM Models', 'IFC']);

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [{ dataObject: 'BIM Models', direction: 'b_to_a', attestations: [] }],
        },
      ],
    });

    expect(res.status).toBe(200);
    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ dataObjectId: uuid(20), direction: 'b_to_a' });
  });

  it('replaces the claim set (+ cascades attestations) on re-promote by supabaseId; idempotent', async () => {
    const [srcId, tgtId, intgId] = [uuid(3), uuid(1), uuid(2)];
    await seedProduct(srcId, 'revit', 'Revit');
    await seedProduct(tgtId, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');
    await seedDataObject(uuid(21), 'models', 'Models');
    await t.db
      .insert(integrations)
      .values({ id: intgId, sourceProductId: srcId, targetProductId: tgtId });
    // A stale claim + attestation already on the integration.
    await t.db
      .insert(claims)
      .values({ id: uuid(30), integrationId: intgId, dataObjectId: uuid(20), direction: 'a_to_b' });
    await t.db
      .insert(attestations)
      .values({ id: uuid(40), claimId: uuid(30), source: 'aeci', asserted: true });

    const body = {
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgId,
          sourceProduct: { supabaseId: srcId },
          targetProduct: { supabaseId: tgtId },
          claims: [
            {
              dataObject: 'models',
              direction: 'both',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    };

    const res = await promote(body);
    expect(res.status).toBe(200);

    // Stale claim (rfis/a_to_b) is gone; only the new one survives.
    let claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ dataObjectId: uuid(21), direction: 'both' });
    // The stale attestation cascade-deleted with its claim; one remains (the new claim's).
    let attRows = await t.db.select().from(attestations);
    expect(attRows).toHaveLength(1);
    expect(attRows[0]!.claimId).toBe(claimRows[0]!.id);

    // Re-pushing the identical bundle is idempotent (still exactly one claim/attestation).
    const res2 = await promote(body);
    expect(res2.status).toBe(200);
    claimRows = await t.db.select().from(claims);
    attRows = await t.db.select().from(attestations);
    expect(claimRows).toHaveLength(1);
    expect(attRows).toHaveLength(1);
  });

  it('withholds claims when their integration is withheld (far endpoint not promoted)', async () => {
    await seedDataObject(uuid(20), 'rfis', 'RFIs');

    const res = await promote({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: uuid(9) },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      integrations: unknown[];
      skipped: { ref: string; kind: string }[];
    };
    expect(b.integrations).toHaveLength(0);
    // The integration is skipped; its claims ride with it (not separately ingested).
    expect(b.skipped).toEqual([expect.objectContaining({ ref: 'i1', kind: 'integration' })]);
    expect(await t.db.select().from(claims)).toHaveLength(0);
  });

  it('clears prior claims when an integration is re-promoted with an empty claims[]', async () => {
    const [srcId, tgtId, intgId] = [uuid(3), uuid(1), uuid(2)];
    await seedProduct(srcId, 'revit', 'Revit');
    await seedProduct(tgtId, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');
    await t.db
      .insert(integrations)
      .values({ id: intgId, sourceProductId: srcId, targetProductId: tgtId });
    await t.db
      .insert(claims)
      .values({ id: uuid(30), integrationId: intgId, dataObjectId: uuid(20), direction: 'a_to_b' });

    const res = await promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: intgId,
          sourceProduct: { supabaseId: srcId },
          targetProduct: { supabaseId: tgtId },
          // no claims → replace-by-origin retires AECi's prior curation
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(await t.db.select().from(claims)).toHaveLength(0);
  });
});

// ── AECI-953: the moved-from record that makes the old pair URL 301 ────────────
//
// A re-pointed endpoint keeps the edge's id and updates its row in place, but the
// pair page is keyed by two product SLUGS — so the URL moves and the old one served
// 200 + `noindex`. AECI-726 did that to 37 live Procore edges; AECI-950 to 15 more.
describe('runPromoteIngest — endpoint moves (AECI-953)', () => {
  const OLD_SRC = uuid(3);
  const NEW_SRC = uuid(4);
  const TGT = uuid(1);
  const INTG = uuid(2);

  /** One edge OLD_SRC → TGT, already promoted, the AECI-726 starting state. */
  const seedEdge = async () => {
    await seedProduct(OLD_SRC, 'procore-project-management', 'Procore Project Management');
    await seedProduct(NEW_SRC, 'procore', 'Procore');
    await seedProduct(TGT, 'okta', 'Okta');
    await t.db
      .insert(integrations)
      .values({ id: INTG, sourceProductId: OLD_SRC, targetProductId: TGT });
  };

  /** Re-promote the same edge with whichever source product. */
  const repromote = (sourceId: string) =>
    promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: INTG,
          sourceProduct: { supabaseId: sourceId },
          targetProduct: { supabaseId: TGT },
        },
      ],
    });

  it('records the old pair when an endpoint is re-pointed', async () => {
    await seedEdge();
    const res = await repromote(NEW_SRC);
    expect(res.status).toBe(200);

    // The edge kept its id and moved in place — the premise the record rests on.
    const [edge] = await t.db.select().from(integrations);
    expect(edge).toMatchObject({ id: INTG, sourceProductId: NEW_SRC, targetProductId: TGT });

    // Stored in canonical ID order, which is what the read's single equality pair needs.
    const [a, b] = [OLD_SRC, TGT].sort();
    expect(await t.db.select().from(integrationEndpointMoves)).toEqual([
      expect.objectContaining({
        integrationId: INTG,
        fromProductAId: a,
        fromProductBId: b,
      }),
    ]);
  });

  it('writes the move audit row in the SAME batch as the mutation (§26.1)', async () => {
    await seedEdge();
    await repromote(NEW_SRC);

    const moved = (await t.db.select().from(auditLog)).filter(
      (e) => e.action === 'integration.endpoint_moved',
    );
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ actorType: 'system', entityType: 'integration' });
    expect(moved[0]!.entityId).toBe(INTG);
    // Both endpoint sets, so the move is reconstructable from the log alone.
    expect(moved[0]!.beforeState).toEqual({ productIds: [OLD_SRC, TGT].sort() });
    expect(moved[0]!.afterState).toEqual({ productIds: [NEW_SRC, TGT].sort() });
  });

  it('writes NOTHING when a re-promote restates the same endpoints', async () => {
    await seedEdge();
    expect((await repromote(OLD_SRC)).status).toBe(200);

    expect(await t.db.select().from(integrationEndpointMoves)).toEqual([]);
    expect(
      (await t.db.select().from(auditLog)).filter((e) => e.action === 'integration.endpoint_moved'),
    ).toEqual([]);
  });

  it('writes NOTHING when source and target merely swap — direction moved, the URL did not', async () => {
    // Upstream orients rows by who BUILT the connector, and AECI-920 is correcting a
    // population of inverted rows. Those re-promotes must not mint a redirect to the
    // page they are already on.
    await seedEdge();
    const res = await promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: INTG,
          sourceProduct: { supabaseId: TGT },
          targetProduct: { supabaseId: OLD_SRC },
        },
      ],
    });
    expect(res.status).toBe(200);
    const [edge] = await t.db.select().from(integrations);
    expect(edge).toMatchObject({ sourceProductId: TGT, targetProductId: OLD_SRC });
    expect(await t.db.select().from(integrationEndpointMoves)).toEqual([]);
  });

  it('is idempotent — re-sending the same move adds no second row and no second audit row', async () => {
    await seedEdge();
    await repromote(NEW_SRC);
    expect((await repromote(NEW_SRC)).status).toBe(200);

    // The second push restates the CURRENT endpoints, so it plans nothing at all —
    // and even if it did, the composite PK's `ON CONFLICT DO NOTHING` would absorb it.
    expect(await t.db.select().from(integrationEndpointMoves)).toHaveLength(1);
    expect(
      (await t.db.select().from(auditLog)).filter((e) => e.action === 'integration.endpoint_moved'),
    ).toHaveLength(1);
  });

  it('echoes the old endpoint slugs so the OLD pair page gets purged', async () => {
    await seedEdge();
    const res = await repromote(NEW_SRC);
    const body = (await res.json()) as PromoteResponse;

    expect(body.integrations[0]?.movedFromSlugs?.slice().sort()).toEqual([
      'okta',
      'procore-project-management',
    ]);
    // The whole point: `cacheTagsForPromote` reads the POST-update endpoints for
    // everything else, so without this the old page served a cached copy of an edge
    // it no longer holds — now, a cached 200 hiding a 301.
    const tags = cacheTagsForPromote(body);
    expect(tags).toContain('pair:okta__procore-project-management');
    expect(tags).toContain('product:procore-project-management');
    expect(tags).toContain('pair:okta__procore');
  });

  it('records the move when an edge crosses INTO the connector-evidenced tier with new endpoints', async () => {
    // The evidenced arm renders on the same pair page (§13.1), so its endpoint moves
    // have to be recorded too or half the delivered tier loses its redirects.
    await seedEdge();
    const connector = uuid(5);
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync');

    const res = await promote({
      integrations: [
        {
          ref: 'i1',
          supabaseId: INTG,
          sourceProduct: { supabaseId: NEW_SRC },
          targetProduct: { supabaseId: TGT },
          poweredByProduct: { supabaseId: connector },
        },
      ],
    });
    expect(res.status).toBe(200);

    expect(await t.db.select().from(integrations)).toEqual([]);
    expect(await t.db.select().from(connectorEvidencedPairs)).toHaveLength(1);
    const [a, b] = [OLD_SRC, TGT].sort();
    expect(await t.db.select().from(integrationEndpointMoves)).toEqual([
      expect.objectContaining({ integrationId: INTG, fromProductAId: a, fromProductBId: b }),
    ]);
  });
});

describe('runPromoteIngest — replace-by-origin claim coexistence (AECI-604)', () => {
  const SRC = uuid(3);
  const TGT = uuid(1);
  const INTG = uuid(2);
  const VENDOR = uuid(50);
  const RFIS = uuid(20);
  const MODELS = uuid(21);

  /** Source + target products, one integration, two vocabulary terms, one vendor. */
  async function seedPair() {
    await seedProduct(SRC, 'revit', 'Revit');
    await seedProduct(TGT, 'navisworks', 'Navisworks');
    await seedDataObject(RFIS, 'rfis', 'RFIs');
    await seedDataObject(MODELS, 'models', 'Models');
    await seedVendor(VENDOR, 'autodesk', 'Autodesk');
    await t.db
      .insert(integrations)
      .values({ id: INTG, sourceProductId: SRC, targetProductId: TGT });
  }

  /** A claim already on the integration, with the given provenance. */
  const seedClaim = (
    id: string,
    dataObjectId: string,
    direction: string,
    origin: 'aeci' | 'vendor' = 'aeci',
    createdByVendorId: string | null = null,
  ) =>
    t.db
      .insert(claims)
      .values({ id, integrationId: INTG, dataObjectId, direction, origin, createdByVendorId });

  const seedAttestation = (
    id: string,
    claimId: string,
    source: 'aeci' | 'vendor_a' | 'vendor_b',
    attestedByVendorId: string | null = null,
  ) =>
    t.db.insert(attestations).values({ id, claimId, source, asserted: true, attestedByVendorId });

  /** The payload shape these tests re-push, parameterised by which claims it asserts. */
  const bundle = (claimList: unknown[]) => ({
    integrations: [
      {
        ref: 'i1',
        supabaseId: INTG,
        sourceProduct: { supabaseId: SRC },
        targetProduct: { supabaseId: TGT },
        claims: claimList,
      },
    ],
  });

  const aeciClaim = (dataObject: string, direction: string) => ({
    dataObject,
    direction,
    attestations: [{ source: 'aeci', asserted: true }],
  });

  type PreservedBody = {
    preserved: { ref: string; kind: string; reason: string; count: number }[];
  };

  it('keeps every claim id stable across a re-promote of an unchanged payload', async () => {
    // The headline regression. The old ingest deleted and re-inserted with fresh
    // UUIDs, so every claim id churned on every promote even when nothing about the
    // claim moved — taking its attestations with it.
    await seedPair();
    const body = bundle([aeciClaim('rfis', 'a_to_b'), aeciClaim('models', 'both')]);

    expect((await promote(body)).status).toBe(200);
    const before = (await t.db.select().from(claims)).map((c) => c.id).sort();
    expect(before).toHaveLength(2);

    expect((await promote(body)).status).toBe(200);
    const after = (await t.db.select().from(claims)).map((c) => c.id).sort();

    expect(after).toEqual(before);
  });

  it('converts a dropped AECi claim that a vendor still attests, instead of deleting it', async () => {
    await seedPair();
    await seedClaim(uuid(30), RFIS, 'a_to_b');
    await seedAttestation(uuid(40), uuid(30), 'aeci');
    await seedAttestation(uuid(41), uuid(30), 'vendor_a', VENDOR);

    // The payload drops rfis entirely and curates models instead.
    const res = await promote(bundle([aeciClaim('models', 'both')]));
    expect(res.status).toBe(200);

    // The claim survives, with its id, now owned by the vendor.
    const rfiClaim = (await t.db.select().from(claims)).find((c) => c.id === uuid(30));
    expect(rfiClaim).toMatchObject({ origin: 'vendor', createdByVendorId: VENDOR });

    // The vendor's assertion survives; AECi's is gone.
    const attRows = await t.db
      .select()
      .from(attestations)
      .where(eq(attestations.claimId, uuid(30)));
    expect(attRows).toHaveLength(1);
    expect(attRows[0]).toMatchObject({ id: uuid(41), source: 'vendor_a' });

    expect(await auditActions()).toEqual(expect.arrayContaining(['claim.converted']));
    const b = (await res.json()) as PreservedBody;
    expect(b.preserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: 'i1', kind: 'claim', reason: PRESERVED_CONVERTED_CLAIM }),
        expect.objectContaining({ ref: 'i1', kind: 'attestation', count: 1 }),
      ]),
    );
  });

  it('deletes a dropped AECi claim nobody else attests, and audits the delete', async () => {
    // The other half of the rule: coexistence must not become "promote can never
    // retire anything". With no vendor voice on the claim, AECi still owns it.
    await seedPair();
    await seedClaim(uuid(30), RFIS, 'a_to_b');
    await seedAttestation(uuid(40), uuid(30), 'aeci');

    const res = await promote(bundle([aeciClaim('models', 'both')]));
    expect(res.status).toBe(200);

    const remaining = await t.db.select().from(claims);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.dataObjectId).toBe(MODELS);
    // The wholesale delete this replaced emitted no audit row at all (§26.1 gap).
    expect(await auditActions()).toEqual(expect.arrayContaining(['claim.deleted']));
  });

  it('never deletes a vendor-origin claim, even when the payload sends no claims at all', async () => {
    await seedPair();
    await seedClaim(uuid(31), MODELS, 'both', 'vendor', VENDOR);
    await seedAttestation(uuid(42), uuid(31), 'vendor_b', VENDOR);
    // An AECi claim alongside it, to prove the empty payload still retires AECi's own.
    await seedClaim(uuid(30), RFIS, 'a_to_b');

    const res = await promote(bundle([]));
    expect(res.status).toBe(200);

    const remaining = await t.db.select().from(claims);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: uuid(31), origin: 'vendor' });
    expect(await t.db.select().from(attestations)).toHaveLength(1);

    const b = (await res.json()) as PreservedBody;
    expect(b.preserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', reason: PRESERVED_VENDOR_CLAIM, count: 1 }),
      ]),
    );
  });

  it('replaces only the AECi attestation on a claim the payload re-asserts', async () => {
    // The claim stays, so its vendor attestation must too — only AECi's own row is
    // rewritten. This is the case the ON DELETE CASCADE used to destroy.
    await seedPair();
    await seedClaim(uuid(30), RFIS, 'a_to_b');
    await seedAttestation(uuid(40), uuid(30), 'aeci');
    await seedAttestation(uuid(41), uuid(30), 'vendor_a', VENDOR);

    const res = await promote(bundle([aeciClaim('rfis', 'a_to_b')]));
    expect(res.status).toBe(200);

    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({ id: uuid(30), origin: 'aeci' });

    const attRows = await t.db
      .select()
      .from(attestations)
      .where(eq(attestations.claimId, uuid(30)));
    // The vendor row is untouched; the aeci row was replaced (new id, same slot).
    const vendorRow = attRows.find((a) => a.source === 'vendor_a');
    const aeciRow = attRows.find((a) => a.source === 'aeci');
    expect(vendorRow).toMatchObject({ id: uuid(41), attestedByVendorId: VENDOR });
    expect(aeciRow).toBeDefined();
    expect(aeciRow!.id).not.toBe(uuid(40));

    const b = (await res.json()) as PreservedBody;
    expect(b.preserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'attestation', reason: PRESERVED_VENDOR_ATTESTATIONS }),
      ]),
    );
  });

  it('skips a vendor-owned attestation source in the payload rather than failing the batch', async () => {
    // `PromoteAttestationSchema` permits vendor_a/vendor_b, and a live vendor row
    // already occupies that slot — inserting would trip `attestations_slot_key` and
    // roll back the WHOLE promote. Reported like an unresolved dataObject instead.
    await seedPair();
    await seedClaim(uuid(30), RFIS, 'a_to_b');
    await seedAttestation(uuid(41), uuid(30), 'vendor_a', VENDOR);

    const res = await promote(
      bundle([
        {
          dataObject: 'rfis',
          direction: 'a_to_b',
          attestations: [
            { source: 'vendor_a', asserted: false },
            { source: 'aeci', asserted: true },
          ],
        },
      ]),
    );

    expect(res.status).toBe(200);
    const b = (await res.json()) as { skipped: { ref: string; kind: string; reason: string }[] };
    expect(b.skipped).toEqual([
      expect.objectContaining({
        ref: 'i1',
        kind: 'claim',
        reason: expect.stringContaining('vendor-owned'),
      }),
    ]);

    // The vendor's own row is intact and was NOT overwritten by the payload's.
    const attRows = await t.db
      .select()
      .from(attestations)
      .where(eq(attestations.claimId, uuid(30)));
    expect(attRows.filter((a) => a.source === 'vendor_a')).toEqual([
      expect.objectContaining({ id: uuid(41), asserted: true }),
    ]);
    expect(attRows.filter((a) => a.source === 'aeci')).toHaveLength(1);
  });

  it('degrades rather than 500s when the attesting vendor of a dropped claim is unknown', async () => {
    // `attested_by_vendor_id` is ON DELETE SET NULL, so it can be null. Converting
    // then would write origin='vendor' with a null vendor — the §2.2 biconditional
    // `assertClaimProvenance` raises a 500 on. Keep the row instead and retry later.
    await seedPair();
    await seedClaim(uuid(30), RFIS, 'a_to_b');
    await seedAttestation(uuid(40), uuid(30), 'aeci');
    await seedAttestation(uuid(41), uuid(30), 'vendor_a', null);

    const res = await promote(bundle([aeciClaim('models', 'both')]));
    expect(res.status).toBe(200);

    const rfiClaim = (await t.db.select().from(claims)).find((c) => c.id === uuid(30));
    // Not converted — provenance invariant intact — but not destroyed either.
    expect(rfiClaim).toMatchObject({ origin: 'aeci', createdByVendorId: null });
    const attRows = await t.db
      .select()
      .from(attestations)
      .where(eq(attestations.claimId, uuid(30)));
    expect(attRows).toEqual([expect.objectContaining({ id: uuid(41), source: 'vendor_a' })]);

    const b = (await res.json()) as PreservedBody;
    expect(b.preserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'claim', reason: PRESERVED_UNCONVERTED_CLAIM }),
      ]),
    );
  });

  it('curates onto an existing vendor-origin claim without seizing its provenance', async () => {
    // AECi asserting the same identity a vendor created reuses the row — provenance
    // records who CREATED it, and that is still the vendor. Seizing it would also
    // strip the rule-2 protection on the next promote.
    await seedPair();
    await seedClaim(uuid(31), MODELS, 'both', 'vendor', VENDOR);
    await seedAttestation(uuid(42), uuid(31), 'vendor_b', VENDOR);

    const res = await promote(bundle([aeciClaim('models', 'both')]));
    expect(res.status).toBe(200);

    const claimRows = await t.db.select().from(claims);
    expect(claimRows).toHaveLength(1);
    expect(claimRows[0]).toMatchObject({
      id: uuid(31),
      origin: 'vendor',
      createdByVendorId: VENDOR,
    });

    // Both voices now sit on the one claim.
    const attRows = await t.db
      .select()
      .from(attestations)
      .where(eq(attestations.claimId, uuid(31)));
    expect(attRows.map((a) => a.source).sort()).toEqual(['aeci', 'vendor_b']);
  });

  it('reports nothing in preserved[] for an ordinary promote of an unclaimed product', async () => {
    // The common case must stay quiet — `preserved[]` is a signal, not a log.
    await seedPair();
    await seedClaim(uuid(30), RFIS, 'a_to_b');
    await seedAttestation(uuid(40), uuid(30), 'aeci');

    const res = await promote(bundle([aeciClaim('rfis', 'a_to_b')]));
    expect(res.status).toBe(200);
    const b = (await res.json()) as PreservedBody;
    expect(b.preserved).toEqual([]);
  });
});

describe('cache purge after promote (AECI-105 → WC-5 / AECI-319)', () => {
  /** Run a promote with a mock `CACHE_PURGE_QUEUE` producer binding; drain the
   *  post-commit `waitUntil` tasks so the enqueue is observable. Returns the
   *  `sendBatch` spy — since AECI-666 the producer enqueues every batch in ONE
   *  `sendBatch()` call rather than a concurrent `send()` per batch, because a
   *  Queue producer call counts against the same per-invocation connection budget
   *  as `fetch`. */
  async function promoteWithPurge(body: unknown, sendBatch = vi.fn().mockResolvedValue(undefined)) {
    const env: Env = {
      ...baseEnv,
      CACHE_PURGE_QUEUE: {
        send: vi.fn().mockResolvedValue(undefined),
        sendBatch,
      } as unknown as Env['CACHE_PURGE_QUEUE'],
    };
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request('/api/promote', post(body), env, execCtx);
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    return { res, execCtx, sendBatch };
  }

  /** The first enqueued `CachePurgeMessage` out of a `sendBatch()` call. */
  function firstMessage(sendBatch: ReturnType<typeof vi.fn>): CachePurgeMessage {
    return (sendBatch.mock.calls[0][0] as { body: CachePurgeMessage }[])[0].body;
  }
  it('enqueues the expected tag set (source:promote) for a representative create', async () => {
    const { res, execCtx, sendBatch } = await promoteWithPurge({
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit', categories: ['BIM'], audiences: ['Architecture'] },
    });

    expect(res.status).toBe(200);
    // Two post-commit tasks on a write: the purge enqueue + the AECI-305 home-stats
    // refresh (a no-op seam here). Only the purge enqueues, and it does so in a
    // single `sendBatch` call (AECI-666).
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(2);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    const msg = firstMessage(sendBatch);
    expect(msg.source).toBe('promote');
    expect(new Set(msg.tags)).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'category:bim',
        'audience:architecture',
        'taxonomy',
        'sitemap',
      ]),
    );
    expect(msg.tags?.some((tag) => tag.startsWith('route:'))).toBe(false);
  });

  it('purges the pair page AND the connector for a ROUTED edge (AECI-721)', async () => {
    // `deriveCacheTags` iterates `response.integrations` to emit `pair:{a}__{b}` and
    // `product:{connectorSlug}`. A routed edge leaves the `integrations` table, so if
    // the routing branch failed to push its result into that array the tags would
    // vanish with it — and the pair page plus the connector's own hub would stay
    // stale until TTL, invisibly. §13.4(4)'s "no promote-deriver change is needed"
    // holds only because this stays true.
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    const { res, sendBatch } = await promoteWithPurge({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          claims: [],
        },
      ],
    });

    expect(res.status).toBe(200);
    const tags = new Set(firstMessage(sendBatch).tags);
    // The pair page for the two endpoints…
    expect(tags.has('pair:navisworks__revit')).toBe(true);
    // …and the connector's own page, which renders the edge in its "Integrations it
    // powers" hub and is reached by no other tag (it is neither endpoint).
    expect(tags.has('product:agave-erp-sync')).toBe(true);
  });

  it('purges the OLD connector when an edge is de-routed out of the evidenced tier (AECI-888)', async () => {
    // The mirror of the test above, and the half `CACHE_STRATEGY.md` §"Bounded gap"
    // warns about. On a de-route the WRITTEN `powered_by_product_id` is null, so deriving
    // the purge set from it reaches no connector at all — while the connector's own
    // "Integrations it powers" hub is precisely the page that just went wrong. The tag
    // has to come from the connector we moved AWAY from.
    const source = uuid(3);
    const target = uuid(1);
    const connector = uuid(2);
    await seedProduct(source, 'revit', 'Revit');
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedProduct(connector, 'agave-erp-sync', 'Agave ERP Sync', { productRole: 'connector' });

    const routed = await promote({
      product: { ref: 'p1', supabaseId: source, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: { supabaseId: connector },
          claims: [],
        },
      ],
    });
    const id = ((await routed.json()) as PromoteResponse).integrations[0]!.id;

    const { res, sendBatch } = await promoteWithPurge({
      product: { ref: 'p1', supabaseId: source, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: id,
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          poweredByProduct: null,
          claims: [],
        },
      ],
    });

    expect(res.status).toBe(200);
    const tags = new Set(firstMessage(sendBatch).tags);
    expect(tags.has('pair:navisworks__revit')).toBe(true);
    expect(tags.has('product:agave-erp-sync')).toBe(true);
  });

  it('enqueues the pair tag for an integration carrying claims (AECI-297)', async () => {
    const target = uuid(1);
    await seedProduct(target, 'navisworks', 'Navisworks');
    await seedDataObject(uuid(20), 'rfis', 'RFIs');

    const { res, sendBatch } = await promoteWithPurge({
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          sourceProduct: { ref: 'p1' },
          targetProduct: { supabaseId: target },
          claims: [
            {
              dataObject: 'rfis',
              direction: 'a_to_b',
              attestations: [{ source: 'aeci', asserted: true }],
            },
          ],
        },
      ],
    });

    expect(res.status).toBe(200);
    const msg = firstMessage(sendBatch);
    // Alphabetically-first slug is the pair context: navisworks < revit.
    expect(msg.tags).toContain('pair:navisworks__revit');
  });

  it('does not enqueue when the queue binding is absent (graceful no-op)', async () => {
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request(
      '/api/promote',
      post({ product: { ref: 'p1', name: 'Revit' } }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    // The AECI-305 home-stats refresh still schedules its waitUntil on a write, but
    // with no queue binding the purge is skipped — only the one waitUntil fires.
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when the enqueue rejects (never fails the promote)', async () => {
    const sendBatch = vi.fn().mockRejectedValue(new Error('queue unavailable'));
    const { res } = await promoteWithPurge({ product: { ref: 'p1', name: 'Revit' } }, sendBatch);
    expect(res.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledTimes(1);
  });

  it('enqueues every batch in ONE sendBatch call, never a send() per batch (AECI-666)', async () => {
    // A Queue producer call counts against the same per-invocation connection
    // budget as `fetch`, and the promote's post-commit tail is already close to
    // it. Latent today (`CACHE_PURGE_QUEUE_MAX_TAGS` is 1000, so a promote is one
    // batch) — this locks the shape so it stays fixed if that cap ever moves.
    const send = vi.fn().mockResolvedValue(undefined);
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const env: Env = {
      ...baseEnv,
      CACHE_PURGE_QUEUE: { send, sendBatch } as unknown as Env['CACHE_PURGE_QUEUE'],
    };
    const execCtx = fakeExecutionContext();
    const res = await buildApp().request(
      '/api/promote',
      post({ product: { ref: 'p1', name: 'Revit' } }),
      env,
      execCtx,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

    expect(res.status).toBe(200);
    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('Algolia index sync after promote (AECI-139)', () => {
  const algoliaEnv: Env = { ...baseEnv, ALGOLIA_APP_ID: 'APP', ALGOLIA_ADMIN_KEY: 'write-key' };

  async function promoteWithSeam(env: Env, body: unknown, syncAlgolia: PromoteAlgoliaSync) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ syncAlgolia }).request('/api/promote', post(body), env, execCtx);
    return { res, execCtx };
  }

  it('schedules the Algolia sync (with the touched product) when credentials are present', async () => {
    const id = uuid(1);
    await seedProduct(id, 'procore', 'Procore');
    const syncAlgolia = vi.fn<PromoteAlgoliaSync>(async () => {});

    const { res, execCtx } = await promoteWithSeam(
      algoliaEnv,
      { product: { ref: 'p1', supabaseId: id, name: 'Procore' } },
      syncAlgolia,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

    expect(res.status).toBe(200);
    expect(syncAlgolia).toHaveBeenCalledTimes(1);
    const response = syncAlgolia.mock.calls[0]![1] as PromoteResponse;
    expect(response.product?.id).toBe(id);
  });

  it('does not schedule the Algolia sync when credentials are absent (graceful no-op)', async () => {
    const syncAlgolia = vi.fn<PromoteAlgoliaSync>(async () => {});
    const { res } = await promoteWithSeam(
      baseEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      syncAlgolia,
    );
    expect(res.status).toBe(200);
    expect(syncAlgolia).not.toHaveBeenCalled();
  });

  it('still returns 200 when the Algolia sync rejects (post-response, never fails the promote)', async () => {
    const syncAlgolia = vi.fn<PromoteAlgoliaSync>(async () => {
      throw new Error('algolia unreachable');
    });
    const { res, execCtx } = await promoteWithSeam(
      algoliaEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      syncAlgolia,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });
});

describe('IndexNow submission after promote (AECI-236)', () => {
  const indexNowEnv: Env = {
    ...baseEnv,
    INDEXNOW_KEY: 'a1b2c3d4e5f6a7b8',
    PUBLIC_SITE_URL: 'https://aecintegrations.com',
  };

  async function promoteWithSeam(env: Env, body: unknown, notifyIndexNow: PromoteIndexNowNotify) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ notifyIndexNow }).request(
      '/api/promote',
      post(body),
      env,
      execCtx,
    );
    return { res, execCtx };
  }

  it('schedules the IndexNow notify (with the touched response) when creds are present', async () => {
    const notifyIndexNow = vi.fn<PromoteIndexNowNotify>(async () => {});
    const { res, execCtx } = await promoteWithSeam(
      indexNowEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyIndexNow,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));

    expect(res.status).toBe(200);
    expect(notifyIndexNow).toHaveBeenCalledTimes(1);
    const response = notifyIndexNow.mock.calls[0]![1] as PromoteResponse;
    expect(response.product?.slug).toBe('revit');
  });

  it('does not schedule the IndexNow notify when creds are absent (graceful no-op)', async () => {
    const notifyIndexNow = vi.fn<PromoteIndexNowNotify>(async () => {});
    const { res } = await promoteWithSeam(
      baseEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyIndexNow,
    );
    expect(res.status).toBe(200);
    expect(notifyIndexNow).not.toHaveBeenCalled();
  });

  it('still returns 200 when the IndexNow notify rejects (post-response, never fails the promote)', async () => {
    const notifyIndexNow = vi.fn<PromoteIndexNowNotify>(async () => {
      throw new Error('indexnow unreachable');
    });
    const { res, execCtx } = await promoteWithSeam(
      indexNowEnv,
      { product: { ref: 'p1', name: 'Revit' } },
      notifyIndexNow,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });

  // ── The real default, not the seam (AECI-826) ────────────────────────────────
  //
  // Everything above injects a mock, which proves the wiring and nothing about
  // what the hook DOES. These exercise `bufferIndexNowAfterPromote` itself,
  // because the behaviour that matters is a negative one: it must write a row and
  // make NO outbound request. A regression to a direct submit here is exactly what
  // produced 23 consecutive HTTP 429s in production.

  const runCtx = (env: Env): PromoteRunCtx => ({
    env,
    request: new Request('http://localhost:8787/api/promote'),
    waitUntil: () => {},
    bookmark: () => null,
  });

  /** A minimal committed-promote response: one created product, nothing else.
   *  `affectedUrlsForPromote` walks vendors, integrations and all three taxonomy
   *  facets unconditionally, so every collection has to be present and empty.
   *
   *  The field is `operation`, not `action` — this fixture said `action` until
   *  AECI-945 and the `as unknown as` cast hid it. Nothing noticed because the
   *  IndexNow deriver ignores the value; the Google deriver reads it to tell a
   *  new page from an edit, so a wrong key silently demoted every created
   *  product from tier 1 to tier 2. */
  const productResponse = (slug = 'revit'): PromoteResponse =>
    ({
      product: { ref: 'p1', id: 'p-1', slug, operation: 'created' },
      vendors: [],
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [], trades: [] },
      skipped: [],
    }) as unknown as PromoteResponse;

  it('buffers the affected URLs into indexnow_queue and calls no transport', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await bufferIndexNowAfterPromote(
      runCtx(indexNowEnv),
      productResponse(),
      Promise.resolve({} as AffectedUrlOptions),
      t.db,
    );

    const rows = await t.db.select({ url: indexnowQueue.url }).from(indexnowQueue);
    expect(rows.map((r) => r.url).sort()).toEqual([
      'https://aecintegrations.com/products',
      'https://aecintegrations.com/products/revit',
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('buffers nothing when the creds are absent', async () => {
    await bufferIndexNowAfterPromote(
      runCtx(baseEnv),
      productResponse(),
      Promise.resolve({} as AffectedUrlOptions),
      t.db,
    );
    expect(await t.db.select().from(indexnowQueue)).toHaveLength(0);
  });

  it('never throws when the buffer write fails — the promote is already committed', async () => {
    const exploding = {
      insert: () => {
        throw new Error('D1 unavailable');
      },
    } as unknown as typeof t.db;

    await expect(
      bufferIndexNowAfterPromote(
        runCtx(indexNowEnv),
        productResponse(),
        Promise.resolve({} as AffectedUrlOptions),
        exploding,
      ),
    ).resolves.toBeUndefined();
  });

  // ── The Google half of the same hook (AECI-945) ─────────────────────────────
  //
  // It rides `bufferIndexNowAfterPromote` rather than getting its own
  // `dispatchHook`, so these assert the two queues stay independent: different
  // URL sets, and the same fail-open contract.

  it('buffers the Google worklist alongside the IndexNow buffer', async () => {
    await bufferIndexNowAfterPromote(
      runCtx(indexNowEnv),
      productResponse(),
      Promise.resolve({} as AffectedUrlOptions),
      t.db,
    );

    const rows = await t.db
      .select({ url: gscRecrawlQueue.url, priority: gscRecrawlQueue.priority })
      .from(gscRecrawlQueue);

    // Entity detail pages ONLY. `/products` is on the IndexNow list above and
    // deliberately not here: a hub is re-crawled constantly anyway, and a
    // Request Indexing slot spent on it is one not spent on a page Google has
    // never seen.
    expect(rows).toEqual([{ url: 'https://aecintegrations.com/products/revit', priority: 1 }]);
  });

  it('buffers no Google rows when the creds are absent', async () => {
    await bufferIndexNowAfterPromote(
      runCtx(baseEnv),
      productResponse(),
      Promise.resolve({} as AffectedUrlOptions),
      t.db,
    );
    expect(await t.db.select().from(gscRecrawlQueue)).toHaveLength(0);
  });
});

describe('home-stats refresh after promote (AECI-305 → WC-5 / AECI-319)', () => {
  /** An env carrying a mock `CACHE_PURGE_QUEUE` producer binding + its `send` spy. */
  function purgeEnvWith(send: ReturnType<typeof vi.fn>): Env {
    return { ...baseEnv, CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'] };
  }

  // ── Seam wiring: scheduled iff the promote actually wrote rows ──────────────
  async function promoteWithSeam(body: unknown, refreshHomeStats: PromoteHomeStatsRefresh) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ refreshHomeStats }).request(
      '/api/promote',
      post(body),
      baseEnv,
      execCtx,
    );
    return { res, execCtx };
  }

  it('schedules the home-stats refresh when the promote wrote rows', async () => {
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {});
    const { res, execCtx } = await promoteWithSeam(
      { product: { ref: 'p1', name: 'Revit' } },
      refreshHomeStats,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    expect(res.status).toBe(200);
    expect(refreshHomeStats).toHaveBeenCalledTimes(1);
  });

  it('does not schedule the refresh for an all-skipped promote (nothing written)', async () => {
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {});
    // Both endpoints reference unpromoted products → the integration is skipped and
    // no product/vendor is written, so the batch is empty.
    const { res } = await promoteWithSeam(
      {
        integrations: [
          {
            ref: 'i1',
            sourceProduct: { supabaseId: uuid(8) },
            targetProduct: { supabaseId: uuid(9) },
          },
        ],
      },
      refreshHomeStats,
    );
    expect(res.status).toBe(200);
    expect(refreshHomeStats).not.toHaveBeenCalled();
  });

  it('still returns 200 when the refresh rejects (post-response, never fails the promote)', async () => {
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {
      throw new Error('stats recompute exploded');
    });
    const { res, execCtx } = await promoteWithSeam(
      { product: { ref: 'p1', name: 'Revit' } },
      refreshHomeStats,
    );
    expect(res.status).toBe(200); // returned before the waitUntil settles
    await Promise.allSettled(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
  });

  // ── Default behaviour: recompute stats_cache, THEN purge the home page ──────
  function fakeContext(env: Env) {
    return {
      env,
      executionCtx: fakeExecutionContext(),
      req: { raw: new Request('https://api.local/api/promote', { method: 'POST' }) },
    } as unknown as Parameters<typeof refreshHomeStatsAfterPromote>[0];
  }

  it('recomputes the home.* stats_cache keys, THEN enqueues the index:home purge', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit', { integrationCount: 2 });
    // Capture the stats_cache row count at enqueue time to prove the load-bearing
    // ordering: the recompute must have already landed when the purge is enqueued.
    let statsRowsAtEnqueue = -1;
    const send = vi.fn(async (_msg: CachePurgeMessage) => {
      statsRowsAtEnqueue = (await t.db.select().from(statsCache)).length;
    });

    await refreshHomeStatsAfterPromote(fakeContext(purgeEnvWith(send)), t.db);

    const cached = await t.db.select().from(statsCache);
    const byKey = new Map(cached.map((r) => [r.key, r.value]));
    // The counts the home banner reads are now written from live state.
    expect(byKey.get('home.total_products')).toBe(1);
    expect(byKey.has('home.total_integrations')).toBe(true);

    // …and only then is the home page purged, by exactly the tag the SSR route emits.
    expect(send).toHaveBeenCalledTimes(1);
    expect(statsRowsAtEnqueue).toBeGreaterThan(0);
    expect(send.mock.calls[0][0]).toEqual({ tags: ['index:home'], source: 'promote' });
  });

  it('recomputes the stats_cache but skips the enqueue when the queue is absent', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit');

    await refreshHomeStatsAfterPromote(fakeContext(baseEnv), t.db);

    expect((await t.db.select().from(statsCache)).length).toBeGreaterThan(0);
  });

  it('recomputes the stats_cache and never throws when the enqueue rejects', async () => {
    await seedProduct(uuid(1), 'revit', 'Revit');
    const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));

    // Must resolve (never reject) so the post-commit waitUntil can't turn into an
    // unhandled rejection — the recompute still lands.
    await expect(
      refreshHomeStatsAfterPromote(fakeContext(purgeEnvWith(send)), t.db),
    ).resolves.toBeUndefined();
    expect((await t.db.select().from(statsCache)).length).toBeGreaterThan(0);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('cacheTagsForPromote (AECI-105)', () => {
  const entity = (slug: string, operation: 'created' | 'updated') => ({
    ref: `ref-${slug}`,
    id: `id-${slug}`,
    slug,
    operation,
  });
  const tax = (slug: string, operation: 'created' | 'reused') => ({
    id: `id-${slug}`,
    slug,
    operation,
  });
  const emptyTaxonomy = { categories: [], audiences: [], phases: [], trades: [] };

  it('created product + vendor + mixed taxonomy → entity, index, taxonomy, sitemap tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        audiences: [tax('architecture', 'created')],
        phases: [],
        trades: [],
      },
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'category:bim',
        'audience:architecture',
        'taxonomy',
        'sitemap',
      ]),
    );
  });

  it('updated entities + all-reused taxonomy → no sitemap, no taxonomy tag', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [], trades: [] },
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products', 'vendor:autodesk', 'category:bim']),
    );
  });

  it('vendor-only update → vendor tag only', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(cacheTagsForPromote(response).sort()).toEqual(['vendor:autodesk']);
  });

  it('created vendor (no product) → vendor + sitemap', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(new Set(['vendor:autodesk', 'sitemap']));
  });

  it('a newly created phase → phase tag + taxonomy', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [tax('design', 'created')], trades: [] },
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products', 'phase:design', 'taxonomy']),
    );
  });

  it('nothing cacheable changed → empty tag set', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(cacheTagsForPromote(response)).toEqual([]);
  });

  it('a powered integration → the connector product tag alongside the pair tag', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [
        {
          ref: 'i1',
          id: 'id-i1',
          operation: 'updated',
          sourceSlug: 'revit',
          targetSlug: 'navisworks',
          poweredBySlug: 'agave-erp-sync',
        },
      ],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['pair:navisworks__revit', 'product:agave-erp-sync']),
    );
  });

  it('an integration with no powered-by product emits no connector tag', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: null,
      integrations: [
        {
          ref: 'i1',
          id: 'id-i1',
          operation: 'updated',
          sourceSlug: 'revit',
          targetSlug: 'navisworks',
        },
      ],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(cacheTagsForPromote(response)).toEqual(['pair:navisworks__revit']);
  });

  it('never emits coarse route-class tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'created')], audiences: [], phases: [], trades: [] },
      skipped: [],
      preserved: [],
    };
    expect(cacheTagsForPromote(response).some((tag) => tag.startsWith('route:'))).toBe(false);
  });

  // AECI-542 — trades diverge from the three sibling facets: they can never be
  // `created`, yet any touched trade still changes the publication-gated `/trades`
  // index, facet sidebar, and sitemap (`CACHE_STRATEGY.md` §2).
  it('a reused trade → trade tag + index:trades + taxonomy + sitemap', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: {
        categories: [],
        audiences: [],
        phases: [],
        trades: [tax('electrical', 'reused')],
      },
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'trade:electrical',
        'index:trades',
        'taxonomy',
        'sitemap',
      ]),
    );
  });

  it('a REMOVED trade still purges its browse page and the gated surfaces', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response, { removedTradeSlugs: ['roofing'] }))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'trade:roofing',
        'index:trades',
        'taxonomy',
        'sitemap',
      ]),
    );
  });

  it('a promote with no trades emits no trade tags', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
      preserved: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products']),
    );
  });
});

// AECI-546 — the touched-trade set, shared by `cacheTagsForPromote` and
// `affectedUrlsForPromote`. Pinned directly because the two consumers MUST agree:
// a trade URL pinged to IndexNow but never purged from the edge hands the crawler
// a stale page.
describe('touchedTradeSlugs', () => {
  const withTrades = (trades: string[]): PromoteResponse => ({
    vendors: [],
    product: { ref: 'ref-revit', id: 'id-revit', slug: 'revit', operation: 'updated' },
    integrations: [],
    taxonomy: {
      categories: [],
      audiences: [],
      phases: [],
      // Always `reused`: the vocabulary is closed and find-only, so a trade can
      // never be `created`.
      trades: trades.map((slug) => ({ id: `id-${slug}`, slug, operation: 'reused' as const })),
    },
    skipped: [],
    preserved: [],
  });

  it('unions the SET trades with the REMOVED ones', () => {
    expect(new Set(touchedTradeSlugs(withTrades(['electrical']), ['roofing']))).toEqual(
      new Set(['electrical', 'roofing']),
    );
  });

  // A re-promote that keeps a trade puts it in neither list twice; a caller that
  // passes overlapping sets must not get a duplicate tag or a duplicate ping.
  it('dedupes a slug present on both sides', () => {
    expect(touchedTradeSlugs(withTrades(['electrical']), ['electrical'])).toEqual(['electrical']);
  });

  it('is empty when the promote touched no trade', () => {
    expect(touchedTradeSlugs(withTrades([]))).toEqual([]);
  });

  it('agrees with the tag deriver about what was touched', () => {
    const response = withTrades(['electrical']);
    const removed = ['roofing'];
    const tags = cacheTagsForPromote(response, { removedTradeSlugs: removed });
    for (const slug of touchedTradeSlugs(response, removed)) {
      expect(tags).toContain(`trade:${slug}`);
    }
  });
});

// ─── Claimed-vendor guard (AECI-520) ──────────────────────────────────────────

/**
 * Once AECi grants a vendor-portal seat, that vendor's row and every product it
 * owns become vendor-owned — the vendor edits them through `/api/vendor/*`, and
 * this endpoint writes the very same columns. So a promote must not overwrite
 * them (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4).
 *
 * The failure modes are asymmetric, so both directions are pinned: under-blocking
 * silently reverts a vendor's edits (they'd report "AECi keeps undoing our
 * changes"), and over-blocking freezes a vendor out of AECi curation entirely.
 */
describe('createPromoteHandler — claimed-vendor block', () => {
  const V_CLAIMED = uuid(50);
  const V_FREE = uuid(51);
  const P_OWNED = uuid(60); // owned by the claimed vendor
  const P_FREE = uuid(61); // owned by nobody in particular
  const P_OTHER = uuid(62); // an unrelated integration endpoint

  /** Grant a seat — the ONLY thing that marks a vendor as claimed. */
  const seedSeat = (id: string, vendorId: string | null, role = 'vendor_admin') =>
    t.db.insert(profiles).values({ id, role, vendorId });
  const seedOwnership = (productId: string, vendorId: string) =>
    t.db.insert(productVendors).values({ productId, vendorId, isPrimary: true });

  const skippedKinds = (body: PromoteResponse) => body.skipped.map((s) => s.kind);

  beforeEach(async () => {
    await seedVendor(V_CLAIMED, 'autodesk', 'Autodesk');
    await seedVendor(V_FREE, 'bentley', 'Bentley');
    await seedProduct(P_OWNED, 'revit', 'Revit', { description: 'Vendor-owned copy' });
    await seedProduct(P_FREE, 'microstation', 'MicroStation');
    await seedProduct(P_OTHER, 'navisworks', 'Navisworks');
    await seedOwnership(P_OWNED, V_CLAIMED);
    await seedSeat(uuid(70), V_CLAIMED);
  });

  it('skips the claimed vendor while a sibling vendor still promotes', async () => {
    const res = await promote({
      vendors: [
        { ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk', website: 'https://new' },
        { ref: 'v2', supabaseId: V_FREE, companyName: 'Bentley', website: 'https://bentley.new' },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromoteResponse;

    // Blocked entities are OMITTED from the results, not marked — that is what
    // keeps them out of the purge / IndexNow / Algolia derivers for free.
    expect(body.vendors.map((v) => v.ref)).toEqual(['v2']);
    expect(body.skipped).toContainEqual(expect.objectContaining({ ref: 'v1', kind: 'vendor' }));

    const [claimed] = await t.db.select().from(vendors).where(eq(vendors.id, V_CLAIMED));
    const [free] = await t.db.select().from(vendors).where(eq(vendors.id, V_FREE));
    expect(claimed?.website).toBeNull(); // untouched
    expect(free?.website).toBe('https://bentley.new');

    const actions = await auditActions();
    expect(actions).toContain('promote.blocked');
    expect(actions.filter((a) => a === 'vendor.updated')).toHaveLength(1);
  });

  it('blocks an existing product owned by a claimed vendor, wholesale', async () => {
    const res = await promote({
      product: {
        ref: 'p1',
        supabaseId: P_OWNED,
        name: 'Revit 2027',
        description: 'review-app copy',
        categories: ['Brand New Category'],
      },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PromoteResponse;

    expect(body.product).toBeNull();
    expect(skippedKinds(body)).toEqual(['product']);

    const [row] = await t.db.select().from(products).where(eq(products.id, P_OWNED));
    expect(row?.name).toBe('Revit');
    expect(row?.description).toBe('Vendor-owned copy');
    expect(row?.promotionStatus).toBe('promoted'); // seeded value, not re-set

    // Taxonomy resolution is gated too: no orphan term is minted for a product
    // that was never written, and the response reports no taxonomy work.
    expect(await t.db.select().from(taxonomyCategories)).toHaveLength(0);
    expect(body.taxonomy.categories).toEqual([]);
    expect(await auditActions()).not.toContain('product.updated');
  });

  it('never wipes the ownership join rows of a blocked product', async () => {
    // The delete+reinsert of `product_vendors` is the destructive statement: a
    // payload that omits the claimed vendor would otherwise orphan the claim.
    await promote({
      vendors: [{ ref: 'v2', supabaseId: V_FREE, companyName: 'Bentley' }],
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
    });
    const rows = await t.db
      .select()
      .from(productVendors)
      .where(eq(productVendors.productId, P_OWNED));
    expect(rows.map((r) => r.vendorId)).toEqual([V_CLAIMED]);
  });

  it('blocks a product this payload would hand to a claimed vendor', async () => {
    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk' }],
      product: { ref: 'p1', supabaseId: P_FREE, name: 'MicroStation Renamed' },
    });
    const body = (await res.json()) as PromoteResponse;
    expect(body.product).toBeNull();
    expect(skippedKinds(body).sort()).toEqual(['product', 'vendor']);

    const [row] = await t.db.select().from(products).where(eq(products.id, P_FREE));
    expect(row?.name).toBe('MicroStation');
  });

  it('never blocks a CREATE, and the vendor slug suffix still resolves', async () => {
    // Creation is always allowed: nothing vendor-owned exists yet. This also
    // pins that the blocked-vendor branch still contributes `firstVendorSlug`,
    // which `generateSlug` uses to disambiguate a colliding product slug.
    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' }, // collides with the seeded 'revit'
    });
    const body = (await res.json()) as PromoteResponse;
    expect(body.product?.operation).toBe('created');
    expect(body.product?.slug).toBe('revit-autodesk');

    const joins = await t.db
      .select()
      .from(productVendors)
      .where(eq(productVendors.vendorId, V_CLAIMED));
    // The new product is still joined to the claimed vendor.
    expect(joins.map((r) => r.productId)).toContain(body.product?.id);
  });

  it('cascades to integrations referencing the blocked product by ref AND by id', async () => {
    const res = await promote({
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: P_OTHER } },
        // The superRefine only constrains `ref` endpoints, so this id-form
        // reference to the same blocked product must be caught explicitly.
        {
          ref: 'i2',
          sourceProduct: { supabaseId: P_OWNED },
          targetProduct: { supabaseId: P_OTHER },
        },
        // Unrelated: neither endpoint is the blocked product, so it promotes.
        {
          ref: 'i3',
          sourceProduct: { supabaseId: P_FREE },
          targetProduct: { supabaseId: P_OTHER },
        },
      ],
    });
    const body = (await res.json()) as PromoteResponse;

    expect(body.integrations.map((i) => i.ref)).toEqual(['i3']);
    const blocked = body.skipped.filter((s) => s.kind === 'integration');
    expect(blocked.map((s) => s.ref).sort()).toEqual(['i1', 'i2']);
    // The reason must name the real cause, not the misleading "not promoted yet".
    for (const entry of blocked) expect(entry.reason).toMatch(/claimed vendor/i);

    // The blocked product's own integration count is left alone.
    const [owned] = await t.db.select().from(products).where(eq(products.id, P_OWNED));
    expect(owned?.integrationCount).toBe(0);
    const [free] = await t.db.select().from(products).where(eq(products.id, P_FREE));
    expect(free?.integrationCount).toBe(1);
  });

  it('skips an integration whose poweredByProduct is the blocked product', async () => {
    // Without this the integration writes, `resolveProduct` degrades the unknown
    // ref to null, and `powered_by_product_id` is CLEARED on a promote whose
    // whole purpose was to leave the blocked product alone — silently, with
    // nothing in skipped[] to show for it.
    await t.db.insert(integrations).values({
      id: uuid(90),
      sourceProductId: P_FREE,
      targetProductId: P_OTHER,
      poweredByProductId: P_OWNED,
    });

    const res = await promote({
      product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
      integrations: [
        {
          ref: 'i1',
          supabaseId: uuid(90),
          sourceProduct: { supabaseId: P_FREE },
          targetProduct: { supabaseId: P_OTHER },
          poweredByProduct: { ref: 'p1' },
        },
      ],
    });
    const body = (await res.json()) as PromoteResponse;

    expect(body.integrations).toEqual([]);
    expect(body.skipped).toContainEqual(
      expect.objectContaining({ ref: 'i1', kind: 'integration' }),
    );

    const [row] = await t.db
      .select()
      .from(integrations)
      .where(eq(integrations.id, uuid(90)));
    expect(row?.poweredByProductId).toBe(P_OWNED); // link intact
  });

  it('treats only role=vendor_admin WITH a vendor_id as a claim', async () => {
    // A reviewer pointed at the vendor, and a vendor_admin with no vendor_id:
    // neither claims anything. Over-blocking would freeze curation.
    await seedSeat(uuid(71), V_FREE, 'reviewer');
    await seedSeat(uuid(72), null, 'vendor_admin');

    const res = await promote({
      vendors: [
        { ref: 'v2', supabaseId: V_FREE, companyName: 'Bentley', website: 'https://b.new' },
      ],
    });
    const body = (await res.json()) as PromoteResponse;
    expect(body.vendors.map((v) => v.ref)).toEqual(['v2']);
    expect(body.skipped).toEqual([]);

    const [row] = await t.db.select().from(vendors).where(eq(vendors.id, V_FREE));
    expect(row?.website).toBe('https://b.new');
  });

  it('does not schedule the home-stats refresh for a fully blocked promote', async () => {
    // A blocked promote writes only `promote.blocked` audit rows. The refresh
    // gate must count catalog writes, not statement count, or it fires for a
    // promote that changed nothing.
    const refreshHomeStats = vi.fn<PromoteHomeStatsRefresh>(async () => {});
    const execCtx = fakeExecutionContext();
    const res = await buildApp({ refreshHomeStats }).request(
      '/api/promote',
      post({
        vendors: [{ ref: 'v1', supabaseId: V_CLAIMED, companyName: 'Autodesk' }],
        product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' },
      }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(refreshHomeStats).not.toHaveBeenCalled();
    expect(await auditActions()).toEqual(['promote.blocked', 'promote.blocked']);
  });

  it('enqueues no cache purge for a fully blocked promote', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const env: Env = {
      ...baseEnv,
      CACHE_PURGE_QUEUE: { send } as unknown as Env['CACHE_PURGE_QUEUE'],
    };
    const execCtx = fakeExecutionContext();
    await buildApp().request(
      '/api/promote',
      post({ product: { ref: 'p1', supabaseId: P_OWNED, name: 'Revit' } }),
      env,
      execCtx,
    );
    await Promise.all(vi.mocked(execCtx.waitUntil).mock.calls.map((c) => c[0]));
    expect(send).not.toHaveBeenCalled();
  });
});

// ─── `verified` is grant-only (AECI-520) ──────────────────────────────────────

describe('createPromoteHandler — verified is not review-app writable', () => {
  it('ignores `verified` on an update instead of flipping the entitlement bit', async () => {
    // The regression this guards: a routine promote push carrying
    // `verified: false` used to silently un-verify a paying vendor.
    await t.db
      .insert(vendors)
      .values({ id: uuid(80), slug: 'autodesk', companyName: 'Autodesk', verified: true });

    const res = await promote({
      vendors: [{ ref: 'v1', supabaseId: uuid(80), companyName: 'Autodesk', verified: false }],
    });
    expect(res.status).toBe(200);

    const [row] = await t.db
      .select()
      .from(vendors)
      .where(eq(vendors.id, uuid(80)));
    expect(row?.verified).toBe(true);
  });

  it('ignores `verified` on a create — the grant flow is the only way in', async () => {
    const res = await promote({
      vendors: [{ ref: 'v1', companyName: 'Newco', verified: true }],
    });
    const body = (await res.json()) as PromoteResponse;
    const [row] = await t.db
      .select()
      .from(vendors)
      .where(eq(vendors.id, body.vendors[0]?.id as string));
    expect(row?.verified).toBe(false);
  });
});

describe('AECI-955 promote logo ownership', () => {
  it.each(['vendor', 'admin'] as const)(
    'preserves %s replacements and intentional clears',
    async (source) => {
      const vendorId = uuid(800);
      const productId = uuid(801);
      await seedVendor(vendorId, 'logo-vendor', 'Logo vendor');
      await seedProduct(productId, 'logo-product', 'Logo product');
      for (const logoUrl of ['https://local.example/logo.png', null]) {
        await t.db
          .update(vendors)
          .set({ logoUrl, logoSource: source })
          .where(eq(vendors.id, vendorId));
        await t.db
          .update(products)
          .set({ logoUrl, logoSource: source })
          .where(eq(products.id, productId));
        const response = await promote({
          vendors: [
            {
              ref: 'v',
              supabaseId: vendorId,
              companyName: 'Logo vendor',
              logoUrl: 'https://upstream.example/vendor.png',
            },
          ],
          product: {
            ref: 'p',
            supabaseId: productId,
            name: 'Logo product',
            logoUrl: 'https://upstream.example/product.png',
          },
        });
        expect(response.status).toBe(200);
        expect(
          await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) }),
        ).toMatchObject({ logoUrl, logoSource: source });
        expect(
          await t.db.query.products.findFirst({ where: eq(products.id, productId) }),
        ).toMatchObject({ logoUrl, logoSource: source });
      }
    },
  );
  it('updates upstream-owned logos and leaves provenance null', async () => {
    const vendorId = uuid(800);
    const productId = uuid(801);
    await seedVendor(vendorId, 'logo-vendor', 'Logo vendor');
    await seedProduct(productId, 'logo-product', 'Logo product');
    const logoUrl = 'https://upstream.example/logo.png';
    expect(
      (
        await promote({
          vendors: [{ ref: 'v', supabaseId: vendorId, companyName: 'Logo vendor', logoUrl }],
          product: { ref: 'p', supabaseId: productId, name: 'Logo product', logoUrl },
        })
      ).status,
    ).toBe(200);
    expect(await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) })).toMatchObject({
      logoUrl,
      logoSource: null,
    });
    expect(
      await t.db.query.products.findFirst({ where: eq(products.id, productId) }),
    ).toMatchObject({ logoUrl, logoSource: null });
  });
  it('preserves a local save made after planning but before the batch commits', async () => {
    const vendorId = uuid(800);
    const productId = uuid(801);
    await seedVendor(vendorId, 'logo-vendor', 'Logo vendor');
    await seedProduct(productId, 'logo-product', 'Logo product');
    // The planner sees null ownership; only SQL-time checks can preserve this save.
    const original = t.db.batch.bind(t.db);
    vi.spyOn(t.db, 'batch').mockImplementationOnce(async (queries) => {
      t.raw
        .prepare("UPDATE vendors SET logo_url = ?, logo_source = 'admin' WHERE id = ?")
        .run('https://local.example/vendor.png', vendorId);
      t.raw
        .prepare("UPDATE products SET logo_url = NULL, logo_source = 'vendor' WHERE id = ?")
        .run(productId);
      return original(queries);
    });
    const response = await promote({
      vendors: [
        {
          ref: 'v',
          supabaseId: vendorId,
          companyName: 'Logo vendor',
          logoUrl: 'https://upstream.example/vendor.png',
        },
      ],
      product: {
        ref: 'p',
        supabaseId: productId,
        name: 'Logo product',
        logoUrl: 'https://upstream.example/product.png',
      },
    });
    expect(response.status).toBe(200);
    expect(await t.db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) })).toMatchObject({
      logoUrl: 'https://local.example/vendor.png',
      logoSource: 'admin',
    });
    expect(
      await t.db.query.products.findFirst({ where: eq(products.id, productId) }),
    ).toMatchObject({ logoUrl: null, logoSource: 'vendor' });
  });
});
