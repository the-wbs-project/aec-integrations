import type { PromoteResponse } from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireReviewAppAuth } from '../lib/review-auth';
import type { AcceleratedPrisma } from '../prisma';
import { createPromoteHandler } from './promote';
import { cacheTagsForPromote } from './promote-cache-tags';

// ─── In-memory Prisma fake ────────────────────────────────────────────────────
// Models share one instance set so writes inside `$transaction` are visible to
// the outer slug-preload reads (the real accelerated client behaves the same).
type Rec = Record<string, unknown>;

function matchWhere(row: Rec, where: Rec | undefined): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(v as Rec[]).some((cond) => matchWhere(row, cond))) return false;
      continue;
    }
    if (row[k] !== v) return false;
  }
  return true;
}

function makeFake() {
  const counter = { n: 0 };
  const audit: Rec[] = [];
  // Captures the options arg passed to `$transaction` so tests can assert it
  // stays within Prisma Accelerate's interactive-transaction limits.
  const txOptions: (Rec | undefined)[] = [];

  const model = (name: string) => {
    const rows = new Map<string, Rec>();
    return {
      rows,
      async create({ data }: { data: Rec }) {
        const id = (data.id as string) ?? `${name}_${(counter.n += 1)}`;
        const row = { ...data, id };
        rows.set(id, row);
        return row;
      },
      async update({ where, data }: { where: Rec; data: Rec }) {
        const prev = rows.get(where.id as string) ?? { id: where.id };
        const row = { ...prev, ...data, id: where.id as string };
        rows.set(where.id as string, row);
        return row;
      },
      async createMany({ data }: { data: Rec[] }) {
        for (const d of data) {
          const id = (d.id as string) ?? `${name}_${(counter.n += 1)}`;
          rows.set(id, { ...d, id });
        }
        return { count: data.length };
      },
      async deleteMany({ where }: { where: Rec }) {
        let count = 0;
        for (const [k, v] of [...rows]) {
          if (matchWhere(v, where)) {
            rows.delete(k);
            count += 1;
          }
        }
        return { count };
      },
      async findUnique({ where }: { where: Rec }) {
        return rows.get(where.id as string) ?? null;
      },
      async findMany() {
        return [...rows.values()];
      },
      async count({ where }: { where?: Rec } = {}) {
        let count = 0;
        for (const v of rows.values()) if (matchWhere(v, where)) count += 1;
        return count;
      },
      // Mirrors the real `_avg` aggregate over the matched rows; returns null per
      // field when nothing matches (the recompute path's zero-review behaviour).
      async aggregate({ where, _avg }: { where?: Rec; _avg: Record<string, true> }) {
        const matched = [...rows.values()].filter((r) => matchWhere(r, where));
        const out: Record<string, number | null> = {};
        for (const field of Object.keys(_avg)) {
          out[field] =
            matched.length === 0
              ? null
              : matched.reduce((a, r) => a + Number(r[field]), 0) / matched.length;
        }
        return { _avg: out };
      },
    };
  };

  const models = {
    vendor: model('vendor'),
    product: model('product'),
    integration: model('integration'),
    review: model('review'),
    productVendor: model('productVendor'),
    productCategory: model('productCategory'),
    productAudience: model('productAudience'),
    productPhase: model('productPhase'),
    productExtension: model('productExtension'),
    taxonomyCategory: model('taxonomyCategory'),
    taxonomyAudience: model('taxonomyAudience'),
    taxonomyPhase: model('taxonomyPhase'),
    auditLog: {
      async create({ data }: { data: Rec }) {
        audit.push(data);
        return data;
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>, options?: Rec): Promise<T> {
      txOptions.push(options);
      return fn(models);
    },
  };

  return { models, audit, txOptions };
}

type Fake = ReturnType<typeof makeFake>;

/** Deterministic UUID for seeded rows referenced via `supabaseId`. */
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

const baseEnv: Env = {
  DATABASE_URL: 'prisma://test',
  ENV: 'preview',
  REVIEW_APP_TOKEN: 'secret-token',
};

function fakeExecutionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} };
}

function buildApp(fake: Fake, { withAuth = false }: { withAuth?: boolean } = {}) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  const factory = () => models(fake);
  if (withAuth) {
    app.post('/api/promote', requireReviewAppAuth(), createPromoteHandler(factory));
  } else {
    app.post('/api/promote', createPromoteHandler(factory));
  }
  return app;
}

function models(fake: Fake): AcceleratedPrisma {
  return fake.models as unknown as AcceleratedPrisma;
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  } satisfies RequestInit;
}

async function promote(fake: Fake, body: unknown) {
  const res = await buildApp(fake).request(
    '/api/promote',
    post(body),
    baseEnv,
    fakeExecutionContext(),
  );
  return res;
}

const auditActions = (fake: Fake) => fake.audit.map((e) => e.action as string);

/**
 * Duck-typed Prisma `PrismaClientKnownRequestError` for a `P2002` unique-
 * constraint violation. The handler detects these structurally (by `code` +
 * `meta.target`), so the test doesn't need the real edge-client error class.
 * `target` is an array of columns (`['slug']`) — the shape Prisma emits for a
 * `@unique` field.
 */
function uniqueConstraintError(target: string[]) {
  const e = new Error(
    `Unique constraint failed on the fields: (${target.map((t) => `\`${t}\``).join(',')})`,
  ) as Error & { code: string; meta?: { target: string[] } };
  e.name = 'PrismaClientKnownRequestError';
  e.code = 'P2002';
  e.meta = { target };
  return e;
}

describe('createPromoteHandler', () => {
  it('creates a product with vendor and taxonomy', async () => {
    const fake = makeFake();
    // Seed the already-promoted "other endpoint" product.
    const existingProd = uuid(1);
    fake.models.product.rows.set(existingProd, {
      id: existingProd,
      slug: 'navisworks',
      name: 'Navisworks',
    });

    const res = await promote(fake, {
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
    const body = (await res.json()) as Record<string, never>;
    const b = body as unknown as {
      vendors: { ref: string; id: string; slug: string; operation: string }[];
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

    // Join rows reflect the bundle.
    expect(fake.models.productVendor.rows.size).toBe(1);
    expect(fake.models.productCategory.rows.size).toBe(2);

    // AECI-86: integration seeding is enabled. i1 links the new product (p1) to
    // the already-promoted target, so one integration row is created and both
    // endpoints' integration_count is recomputed.
    expect(b.integrations).toHaveLength(1);
    expect(b.integrations[0]).toMatchObject({ ref: 'i1', operation: 'created' });
    expect(fake.models.integration.rows.size).toBe(1);
    expect(fake.models.product.rows.get(b.product.id)).toMatchObject({ integrationCount: 1 });
    expect(fake.models.product.rows.get(existingProd)).toMatchObject({ integrationCount: 1 });

    // Audit: one row per create.
    expect(auditActions(fake)).toEqual(
      expect.arrayContaining([
        'vendor.created',
        'category.created',
        'product.created',
        'integration.created',
      ]),
    );
    // Every audit row tagged with the source.
    expect(
      fake.audit.every((e) => (e.metadata as { source?: string }).source === 'review-app-promote'),
    ).toBe(true);
  });

  // Prisma Accelerate rejects an interactive-transaction `timeout` above 15_000ms
  // at parameter validation (P6005) before the transaction runs, so the whole
  // promote 500s. The fake `$transaction` ignores options, so without this guard
  // an out-of-range value passes every other test silently. See promote.ts.
  it('runs the transaction within Accelerate interactive-transaction limits', async () => {
    const fake = makeFake();
    const res = await promote(fake, {
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit', categories: ['BIM'], audiences: ['Architecture'] },
    });

    expect(res.status).toBe(200);
    expect(fake.txOptions).toHaveLength(1);
    const opts = fake.txOptions[0] as { maxWait?: number; timeout?: number };
    expect(opts.timeout).toBeLessThanOrEqual(15_000);
    // maxWait should not exceed timeout (waiting longer than the tx can run is
    // pointless) and stays within Accelerate's bounds.
    expect(opts.maxWait ?? 0).toBeLessThanOrEqual(opts.timeout ?? 0);
  });

  it('updates by supabaseId and keeps the slug stable', async () => {
    const fake = makeFake();
    const vendX = uuid(2);
    const prodX = uuid(3);
    fake.models.vendor.rows.set(vendX, { id: vendX, slug: 'autodesk', companyName: 'Autodesk' });
    fake.models.product.rows.set(prodX, { id: prodX, slug: 'revit', name: 'Revit' });

    const res = await promote(fake, {
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
    // Name change persisted; slug untouched.
    expect(fake.models.product.rows.get(prodX)).toMatchObject({
      name: 'Revit 2025',
      slug: 'revit',
    });
    expect(auditActions(fake)).toEqual(
      expect.arrayContaining(['vendor.updated', 'product.updated']),
    );
  });

  it('promotes a vendor on its own (no product)', async () => {
    const fake = makeFake();
    const vendX = uuid(2);
    fake.models.vendor.rows.set(vendX, { id: vendX, slug: 'autodesk', companyName: 'Autodesk' });

    const res = await promote(fake, {
      vendors: [
        { ref: 'v1', supabaseId: vendX, companyName: 'Autodesk', website: 'https://new.example' },
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
    // The vendor edit persisted; no product row was created.
    expect(fake.models.vendor.rows.get(vendX)).toMatchObject({ website: 'https://new.example' });
    expect(fake.models.product.rows.size).toBe(0);
    expect(auditActions(fake)).toEqual(['vendor.updated']);
  });

  it('disambiguates a colliding product slug using the primary vendor slug', async () => {
    const fake = makeFake();
    fake.models.product.rows.set('other', { id: 'other', slug: 'revit', name: 'Revit' });

    const res = await promote(fake, {
      vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
      product: { ref: 'p1', name: 'Revit' },
    });

    const b = (await res.json()) as { product: { slug: string } };
    expect(b.product.slug).toBe('revit-autodesk');
  });

  it('reuses existing taxonomy rather than duplicating', async () => {
    const fake = makeFake();
    fake.models.taxonomyCategory.rows.set('cat-bim', { id: 'cat-bim', slug: 'bim', name: 'BIM' });

    const res = await promote(fake, {
      product: { ref: 'p1', name: 'Revit', categories: ['BIM'] },
    });

    const b = (await res.json()) as {
      taxonomy: { categories: { id: string; operation: string }[] };
    };
    expect(b.taxonomy.categories[0]).toMatchObject({ id: 'cat-bim', operation: 'reused' });
    // No new category row, no category.created audit.
    expect(fake.models.taxonomyCategory.rows.size).toBe(1);
    expect(auditActions(fake)).not.toContain('category.created');
  });

  it('skips an integration whose other endpoint is not promoted', async () => {
    const fake = makeFake();
    const res = await promote(fake, {
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
    expect(fake.models.integration.rows.size).toBe(0);
  });

  it('skips a self-referential integration', async () => {
    const fake = makeFake();
    const res = await promote(fake, {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [{ ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { ref: 'p1' } }],
    });

    const b = (await res.json()) as { skipped: { ref: string; reason: string }[] };
    expect(b.skipped[0].ref).toBe('i1');
    expect(b.skipped[0].reason).toMatch(/self-link/i);
  });

  it('recomputes product.integrationCount after creating an integration', async () => {
    const fake = makeFake();
    const target = uuid(1);
    fake.models.product.rows.set(target, { id: target, slug: 'navisworks', name: 'Navisworks' });

    const res = await promote(fake, {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [
        { ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { supabaseId: target } },
      ],
    });

    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      product: { id: string };
      integrations: { ref: string; operation: string }[];
    };
    expect(b.integrations[0]).toMatchObject({ ref: 'i1', operation: 'created' });
    // Both endpoints recomputed to 1 from the single integration row.
    expect(fake.models.product.rows.get(b.product.id)).toMatchObject({ integrationCount: 1 });
    expect(fake.models.product.rows.get(target)).toMatchObject({ integrationCount: 1 });
  });

  it('recomputes the OLD endpoint count when an integration update moves an endpoint', async () => {
    const fake = makeFake();
    const prodA = uuid(1);
    const prodB = uuid(2);
    const prodC = uuid(3);
    const intgId = uuid(4);
    fake.models.product.rows.set(prodA, { id: prodA, slug: 'a', name: 'A', integrationCount: 1 });
    fake.models.product.rows.set(prodB, { id: prodB, slug: 'b', name: 'B', integrationCount: 1 });
    fake.models.product.rows.set(prodC, { id: prodC, slug: 'c', name: 'C', integrationCount: 0 });
    // Existing integration A → B.
    fake.models.integration.rows.set(intgId, {
      id: intgId,
      sourceProductId: prodA,
      targetProductId: prodB,
    });

    // Integration-only update push moving the target B → C.
    const res = await promote(fake, {
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
    // The row's endpoint moved B → C.
    expect(fake.models.integration.rows.get(intgId)).toMatchObject({
      sourceProductId: prodA,
      targetProductId: prodC,
    });
    // New endpoints stay at 1; the OLD endpoint (B) recomputes to 0 — without the
    // drift fix B would keep its stale count of 1.
    expect(fake.models.product.rows.get(prodA)).toMatchObject({ integrationCount: 1 });
    expect(fake.models.product.rows.get(prodC)).toMatchObject({ integrationCount: 1 });
    expect(fake.models.product.rows.get(prodB)).toMatchObject({ integrationCount: 0 });
  });

  it('returns 400 for a payload missing the product', async () => {
    const fake = makeFake();
    const res = await promote(fake, { vendors: [] });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string }; trace_id: string };
    expect(b.error.code).toBe('VALIDATION_FAILED');
    expect(b.trace_id).toBeTruthy();
  });

  it('returns 400 for duplicate refs', async () => {
    const fake = makeFake();
    const res = await promote(fake, {
      vendors: [{ ref: 'dup', companyName: 'A' }],
      product: { ref: 'dup', name: 'Revit' },
    });
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe('VALIDATION_FAILED');
  });

  it('returns 400 for malformed JSON', async () => {
    const fake = makeFake();
    const res = await buildApp(fake).request(
      '/api/promote',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' },
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(400);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe('MALFORMED_REQUEST');
  });

  // AECI-98: slugs are preloaded before the transaction, so two concurrent
  // first-time promotes can generate the same slug and the second `tx.create`
  // trips a `*_slug_key` unique constraint. A single-threaded test can't race a
  // real DB, so we inject the `P2002` the DB would raise and assert the handler
  // translates it to the documented 409 SLUG_CONFLICT rather than a generic 500.
  it('returns 409 SLUG_CONFLICT when a create trips a slug unique constraint', async () => {
    const fake = makeFake();
    fake.models.product.create = () => Promise.reject(uniqueConstraintError(['slug']));

    const res = await promote(fake, { product: { ref: 'p1', name: 'Revit' } });

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
    const fake = makeFake();
    // A P2002 on an unrelated constraint must NOT be reported as SLUG_CONFLICT.
    fake.models.product.create = () =>
      Promise.reject(uniqueConstraintError(['product_id', 'vendor_id']));

    const res = await promote(fake, { product: { ref: 'p1', name: 'Revit' } });

    expect(res.status).toBe(500);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe('INTERNAL_ERROR');
  });
});

describe('cache purge after promote (AECI-105)', () => {
  // Option B: promote purges the edge cache by calling Cloudflare's purge-by-tag
  // API directly (no web↔api binding). The handler uses the global `fetch`, so
  // tests stub it.
  const CF_PURGE_URL = 'https://api.cloudflare.com/client/v4/zones/zone-1/purge_cache';

  /** Env with CF purge credentials present, so the purge path runs. */
  const purgeEnv: Env = {
    ...baseEnv,
    CF_PURGE_API_TOKEN: 'cf-token',
    CF_ZONE_ID: 'zone-1',
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Run a promote with a stubbed global fetch (the CF purge) + capturable ctx. */
  async function promoteWithPurge(fake: Fake, body: unknown, fetchMock: ReturnType<typeof vi.fn>) {
    vi.stubGlobal('fetch', fetchMock);
    const execCtx = fakeExecutionContext();
    const res = await buildApp(fake).request('/api/promote', post(body), purgeEnv, execCtx);
    // The purge is scheduled via `waitUntil`; await the scheduled promise so the
    // fetch settles before assertions (the fake ctx's waitUntil doesn't itself).
    const waitUntil = vi.mocked(execCtx.waitUntil);
    if (waitUntil.mock.calls.length > 0) {
      await waitUntil.mock.calls[0]![0];
    }
    return { res, execCtx };
  }

  it('purges the expected tag set for a representative create', async () => {
    const fake = makeFake();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));

    const { res, execCtx } = await promoteWithPurge(
      fake,
      {
        vendors: [{ ref: 'v1', companyName: 'Autodesk' }],
        product: {
          ref: 'p1',
          name: 'Revit',
          categories: ['BIM'],
          audiences: ['Architecture'],
        },
      },
      fetchMock,
    );

    expect(res.status).toBe(200);
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CF_PURGE_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cf-token');

    const sent = JSON.parse(init.body as string) as { tags: string[] };
    // AECI-165 — no `index:vendors`: the `/vendors` index page was removed.
    expect(new Set(sent.tags)).toEqual(
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
    // Routine writes never carry the coarse route-class tags (CACHE_STRATEGY §3.3).
    expect(sent.tags.some((t) => t.startsWith('route:'))).toBe(false);
  });

  it('does not purge when CF credentials are absent (graceful no-op)', async () => {
    const fake = makeFake();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const execCtx = fakeExecutionContext();
    // `baseEnv` has no CF_PURGE_API_TOKEN / CF_ZONE_ID.
    const res = await buildApp(fake).request(
      '/api/promote',
      post({ product: { ref: 'p1', name: 'Revit' } }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(execCtx.waitUntil).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still returns 200 when the purge call fails (never fails the promote)', async () => {
    const fake = makeFake();
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"errors":[{"message":"x"}]}', { status: 502 }));

    const { res } = await promoteWithPurge(
      fake,
      { product: { ref: 'p1', name: 'Revit' } },
      fetchMock,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still returns 200 when the purge fetch throws', async () => {
    const fake = makeFake();
    const fetchMock = vi.fn().mockRejectedValue(new Error('cf unreachable'));

    const { res } = await promoteWithPurge(
      fake,
      { product: { ref: 'p1', name: 'Revit' } },
      fetchMock,
    );

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
  const emptyTaxonomy = { categories: [], audiences: [], phases: [] };

  it('created product + vendor + mixed taxonomy → entity, index, taxonomy, sitemap tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        audiences: [tax('architecture', 'created')],
        phases: [],
      },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'category:bim',
        'audience:architecture',
        'taxonomy', // an audience was newly created
        'sitemap', // product + vendor were created
      ]),
    );
  });

  it('updated entities + all-reused taxonomy → no sitemap, no taxonomy tag', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'reused')], audiences: [], phases: [] },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['product:revit', 'index:products', 'vendor:autodesk', 'category:bim']),
    );
  });

  it('vendor-only update → vendor tag only (no index:vendors/product/taxonomy/sitemap)', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    // AECI-165 — `index:vendors` is no longer emitted (the index page was removed).
    expect(cacheTagsForPromote(response).sort()).toEqual(['vendor:autodesk']);
  });

  it('created vendor (no product) → vendor + sitemap (no index:vendors)', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(new Set(['vendor:autodesk', 'sitemap']));
  });

  it('a newly created phase → phase tag + taxonomy', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [], audiences: [], phases: [tax('design', 'created')] },
      skipped: [],
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
    };
    expect(cacheTagsForPromote(response)).toEqual([]);
  });

  it('never emits coarse route-class tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'created')], audiences: [], phases: [] },
      skipped: [],
    };
    expect(cacheTagsForPromote(response).some((t) => t.startsWith('route:'))).toBe(false);
  });
});

describe('requireReviewAppAuth (on /api/promote)', () => {
  const validBody = { product: { ref: 'p1', name: 'Revit' } };

  it('rejects a request with no Authorization header', async () => {
    const fake = makeFake();
    const res = await buildApp(fake, { withAuth: true }).request(
      '/api/promote',
      post(validBody),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
    const b = (await res.json()) as { error: { code: string } };
    expect(b.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects a wrong token', async () => {
    const fake = makeFake();
    const res = await buildApp(fake, { withAuth: true }).request(
      '/api/promote',
      post(validBody, { Authorization: 'Bearer wrong' }),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });

  it('accepts the correct token', async () => {
    const fake = makeFake();
    const res = await buildApp(fake, { withAuth: true }).request(
      '/api/promote',
      post(validBody, { Authorization: 'Bearer secret-token' }),
      baseEnv,
      fakeExecutionContext(),
    );
    expect(res.status).toBe(200);
  });

  it('fails closed when REVIEW_APP_TOKEN is unset', async () => {
    const fake = makeFake();
    const res = await buildApp(fake, { withAuth: true }).request(
      '/api/promote',
      post(validBody, { Authorization: 'Bearer anything' }),
      { ...baseEnv, REVIEW_APP_TOKEN: undefined },
      fakeExecutionContext(),
    );
    expect(res.status).toBe(401);
  });
});
