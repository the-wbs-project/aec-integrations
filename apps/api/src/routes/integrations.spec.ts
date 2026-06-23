/**
 * GET /api/integrations (list + detail) on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness. Replaces the retired Prisma-mock
 * suite. Visibility filtering is added in Phase 3 (AECI-254).
 */

import { IntegrationDetailSchema, IntegrationsListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { integrations, products, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createIntegrationDetailHandler, createIntegrationsListHandler } from './integrations';

const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const listApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/integrations',
    handler: createIntegrationsListHandler(t.factory),
  });
const detailApp = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/integrations/:id',
    handler: createIntegrationDetailHandler(t.factory),
  });
const get = (app: ReturnType<typeof listApp>, url: string) =>
  app.request(url, {}, TEST_ENV, fakeExecutionContext());

async function seedProducts() {
  await t.db.insert(products).values([
    { id: u(1), slug: 'procore', name: 'Procore', promotionStatus: 'promoted' },
    { id: u(2), slug: 'revizto', name: 'Revizto', promotionStatus: 'promoted' },
  ]);
}

describe('GET /api/integrations', () => {
  it('lists with a synthesised name when the row name is null', async () => {
    await seedProducts();
    await t.db
      .insert(integrations)
      .values({ id: u(11), sourceProductId: u(1), targetProductId: u(2), mechanismKind: 'native' });

    const parsed = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations')).json(),
    );
    expect(parsed.total).toBe(1);
    // null name → "Source → Target"
    expect(parsed.data[0]?.name).toBe('Procore → Revizto');
  });

  it('search matches the explicit name OR either product name', async () => {
    await seedProducts();
    await t.db.insert(integrations).values([
      { id: u(11), sourceProductId: u(1), targetProductId: u(2) }, // null name → "Procore → Revizto"
      { id: u(12), name: 'Acme Bridge', sourceProductId: u(2), targetProductId: u(1) },
    ]);

    const byProduct = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations?search=revizto')).json(),
    );
    expect(byProduct.total).toBe(2); // both touch Revizto

    const byName = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations?search=acme')).json(),
    );
    expect(byName.data.map((i) => i.id)).toEqual([u(12)]);
  });

  it('filters by mechanism_kind and source product', async () => {
    await seedProducts();
    await t.db.insert(integrations).values([
      { id: u(11), sourceProductId: u(1), targetProductId: u(2), mechanismKind: 'native' },
      { id: u(12), sourceProductId: u(2), targetProductId: u(1), mechanismKind: 'api' },
    ]);

    const byKind = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations?mechanism_kind=api')).json(),
    );
    expect(byKind.data.map((i) => i.id)).toEqual([u(12)]);

    const bySource = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), `/api/integrations?sourceProductId=${u(1)}`)).json(),
    );
    expect(bySource.data.map((i) => i.id)).toEqual([u(11)]);
  });
});

describe('GET /api/integrations/:id', () => {
  it('hydrates detail with built_by_vendor', async () => {
    await seedProducts();
    await t.db
      .insert(vendors)
      .values({ id: u(31), slug: 'acme', companyName: 'Acme', promotionStatus: 'promoted' });
    await t.db.insert(integrations).values({
      id: u(11),
      sourceProductId: u(1),
      targetProductId: u(2),
      mechanismKind: 'native',
      builtByVendorId: u(31),
    });

    const detail = IntegrationDetailSchema.parse(
      await (await get(detailApp(), `/api/integrations/${u(11)}`)).json(),
    );
    expect(detail.built_by_vendor?.slug).toBe('acme');
    expect(detail.source.slug).toBe('procore');
  });

  it('404s a malformed (non-UUID) id without 500ing', async () => {
    expect((await get(detailApp(), '/api/integrations/not-a-uuid')).status).toBe(404);
  });
});
