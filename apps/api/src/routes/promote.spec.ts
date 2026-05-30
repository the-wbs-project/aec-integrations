import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';
import { requireReviewAppAuth } from '../lib/review-auth';
import type { AcceleratedPrisma } from '../prisma';
import { createPromoteHandler } from './promote';

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
