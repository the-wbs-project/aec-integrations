import type { PromoteResponse } from '@aeci/shared';
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

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
    };
  };

  const models = {
    vendor: model('vendor'),
    product: model('product'),
    integration: model('integration'),
    productVendor: model('productVendor'),
    productCategory: model('productCategory'),
    productDiscipline: model('productDiscipline'),
    productPhase: model('productPhase'),
    productExtension: model('productExtension'),
    taxonomyCategory: model('taxonomyCategory'),
    taxonomyDiscipline: model('taxonomyDiscipline'),
    taxonomyPhase: model('taxonomyPhase'),
    auditLog: {
      async create({ data }: { data: Rec }) {
        audit.push(data);
        return data;
      },
    },
    $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(models);
    },
  };

  return { models, audit };
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
        disciplines: ['Architecture'],
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
      taxonomy: { categories: unknown[]; disciplines: unknown[] };
      skipped: unknown[];
    };

    expect(b.vendors[0]).toMatchObject({ ref: 'v1', slug: 'autodesk', operation: 'created' });
    expect(b.product).toMatchObject({ ref: 'p1', slug: 'revit', operation: 'created' });
    expect(b.taxonomy.categories).toHaveLength(2);
    expect(b.taxonomy.disciplines).toHaveLength(1);
    expect(b.skipped).toHaveLength(0);

    // Join rows reflect the bundle.
    expect(fake.models.productVendor.rows.size).toBe(1);
    expect(fake.models.productCategory.rows.size).toBe(2);

    // TODO(AECI-86): integration seeding is temporarily disabled in promote.ts
    // while the vendor/product flow is validated on staging, so no integration
    // row is created and `b.integrations` stays empty. Re-enable alongside the
    // commented-out block in promote.ts.
    expect(b.integrations).toHaveLength(0);
    expect(fake.models.integration.rows.size).toBe(0);

    // Audit: one row per create.
    expect(auditActions(fake)).toEqual(
      expect.arrayContaining(['vendor.created', 'category.created', 'product.created']),
    );
    // Every audit row tagged with the source.
    expect(
      fake.audit.every((e) => (e.metadata as { source?: string }).source === 'review-app-promote'),
    ).toBe(true);
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

  // TODO(AECI-86): integration seeding is temporarily disabled in promote.ts, so
  // the skip/self-link resolution these two cases exercise does not run yet (every
  // pushed integration is silently a no-op). Un-skip alongside re-enabling the
  // commented-out integration block in promote.ts.
  it.skip('skips an integration whose other endpoint is not promoted', async () => {
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

  it.skip('skips a self-referential integration', async () => {
    const fake = makeFake();
    const res = await promote(fake, {
      product: { ref: 'p1', name: 'Revit' },
      integrations: [{ ref: 'i1', sourceProduct: { ref: 'p1' }, targetProduct: { ref: 'p1' } }],
    });

    const b = (await res.json()) as { skipped: { ref: string; reason: string }[] };
    expect(b.skipped[0].ref).toBe('i1');
    expect(b.skipped[0].reason).toMatch(/self-link/i);
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
});

describe('cache purge after promote (AECI-105)', () => {
  const PURGE_URL = 'https://internal/admin/purge?source=promote';

  /** Env with the `WEB` binding + token present, so the purge path runs. */
  function purgeEnv(fetchMock: ReturnType<typeof vi.fn>): Env {
    return {
      ...baseEnv,
      ADMIN_PURGE_TOKEN: 'purge-secret',
      WEB: { fetch: fetchMock } as unknown as Fetcher,
    };
  }

  /** Run a promote with a controllable WEB.fetch + a capturable execution ctx. */
  async function promoteWithPurge(fake: Fake, body: unknown, fetchMock: ReturnType<typeof vi.fn>) {
    const execCtx = fakeExecutionContext();
    const res = await buildApp(fake).request(
      '/api/promote',
      post(body),
      purgeEnv(fetchMock),
      execCtx,
    );
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
          disciplines: ['Architecture'],
        },
      },
      fetchMock,
    );

    expect(res.status).toBe(200);
    expect(execCtx.waitUntil).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(PURGE_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer purge-secret');

    const sent = JSON.parse(init.body as string) as { tags: string[] };
    expect(new Set(sent.tags)).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'index:vendors',
        'category:bim',
        'discipline:architecture',
        'taxonomy',
        'sitemap',
      ]),
    );
    // Routine writes never carry the coarse route-class tags (CACHE_STRATEGY §3.3).
    expect(sent.tags.some((t) => t.startsWith('route:'))).toBe(false);
  });

  it('does not purge when the WEB binding is absent (graceful no-op)', async () => {
    const fake = makeFake();
    const execCtx = fakeExecutionContext();
    // `baseEnv` has no WEB / ADMIN_PURGE_TOKEN.
    const res = await buildApp(fake).request(
      '/api/promote',
      post({ product: { ref: 'p1', name: 'Revit' } }),
      baseEnv,
      execCtx,
    );
    expect(res.status).toBe(200);
    expect(execCtx.waitUntil).not.toHaveBeenCalled();
  });

  it('still returns 200 when the purge call fails (never fails the promote)', async () => {
    const fake = makeFake();
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"x"}', { status: 502 }));

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
    const fetchMock = vi.fn().mockRejectedValue(new Error('binding unreachable'));

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
  const emptyTaxonomy = { categories: [], disciplines: [], phases: [] };

  it('created product + vendor + mixed taxonomy → entity, index, taxonomy, sitemap tags', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: entity('revit', 'created'),
      integrations: [],
      taxonomy: {
        categories: [tax('bim', 'reused')],
        disciplines: [tax('architecture', 'created')],
        phases: [],
      },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'index:vendors',
        'category:bim',
        'discipline:architecture',
        'taxonomy', // a discipline was newly created
        'sitemap', // product + vendor were created
      ]),
    );
  });

  it('updated entities + all-reused taxonomy → no sitemap, no taxonomy tag', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [tax('bim', 'reused')], disciplines: [], phases: [] },
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set([
        'product:revit',
        'index:products',
        'vendor:autodesk',
        'index:vendors',
        'category:bim',
      ]),
    );
  });

  it('vendor-only update → vendor + index:vendors only (no product/taxonomy/sitemap)', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'updated')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(cacheTagsForPromote(response).sort()).toEqual(['index:vendors', 'vendor:autodesk']);
  });

  it('created vendor (no product) → sitemap included', () => {
    const response: PromoteResponse = {
      vendors: [entity('autodesk', 'created')],
      product: null,
      integrations: [],
      taxonomy: emptyTaxonomy,
      skipped: [],
    };
    expect(new Set(cacheTagsForPromote(response))).toEqual(
      new Set(['vendor:autodesk', 'index:vendors', 'sitemap']),
    );
  });

  it('a newly created phase → phase tag + taxonomy', () => {
    const response: PromoteResponse = {
      vendors: [],
      product: entity('revit', 'updated'),
      integrations: [],
      taxonomy: { categories: [], disciplines: [], phases: [tax('design', 'created')] },
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
      taxonomy: { categories: [tax('bim', 'created')], disciplines: [], phases: [] },
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
