/**
 * GET /api/integrations (list + detail) on the Drizzle/D1 path (ADR 0016 /
 * AECI-253), against the in-memory D1 harness. Replaces the retired Prisma-mock
 * suite. Visibility filtering is added in Phase 3 (AECI-254).
 */

import { IntegrationDetailSchema, IntegrationsListResponseSchema } from '@aeci/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connectorEvidencedPairs, integrations, products, vendors } from '../db/schema';
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

describe('GET /api/integrations — connector-evidenced pairs (AECI-721)', () => {
  async function seedConnectorAndPair(direction: 'a_to_b' | 'b_to_a' | 'both' | null = 'a_to_b') {
    await seedProducts();
    await t.db.insert(products).values({
      id: u(3),
      slug: 'agave-erp-sync',
      name: 'Agave ERP Sync',
      productRole: 'connector',
      promotionStatus: 'promoted',
    });
    const [a, b] = [u(1), u(2)].sort();
    await t.db.insert(connectorEvidencedPairs).values({
      id: u(60),
      connectorProductId: u(3),
      productAId: a!,
      productBId: b!,
      direction,
      mechanismName: 'Agave ERP Sync',
    });
    return { a: a!, b: b! };
  }

  it('publishes evidenced pairs alongside integrations, paged and counted as one set', async () => {
    // Not an optimisation to skip: `apps/web/src/server/sitemap.ts` paginates THIS
    // endpoint to emit pair-page URLs, so an omitted arm drops 19 real pages out of
    // the sitemap as a side effect of an internal storage move.
    await seedConnectorAndPair();
    await t.db
      .insert(integrations)
      .values({ id: u(11), sourceProductId: u(1), targetProductId: u(2), mechanismKind: 'native' });

    const parsed = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations')).json(),
    );
    expect(parsed.total).toBe(2);
    expect(parsed.data.map((i) => i.id).sort()).toEqual([u(11), u(60)].sort());
    const evidenced = parsed.data.find((i) => i.id === u(60));
    expect(evidenced?.via?.slug).toBe('agave-erp-sync');
    expect(evidenced?.mechanism_kind).toBeNull();
    expect(parsed.data.find((i) => i.id === u(11))?.via).toBeNull();
  });

  it('paginates ACROSS both tables rather than per table', async () => {
    // The reason this is a UNION and not two page reads merged in memory: `limit`
    // and `offset` have to apply to the COMBINED set. Paginating each table and
    // concatenating yields a page that is neither correctly ordered nor sized.
    await seedConnectorAndPair();
    await t.db.insert(integrations).values({
      id: u(11),
      name: 'Zeta bridge',
      sourceProductId: u(1),
      targetProductId: u(2),
    });

    const page1 = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations?perPage=1&page=1&sort=name')).json(),
    );
    const page2 = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations?perPage=1&page=2&sort=name')).json(),
    );
    expect(page1.total).toBe(2);
    expect(page1.data).toHaveLength(1);
    expect(page2.data).toHaveLength(1);
    // Two distinct rows, one from each table — a per-table page would repeat one.
    expect(page1.data[0]?.id).not.toBe(page2.data[0]?.id);
    expect([page1.data[0]?.id, page2.data[0]?.id].sort()).toEqual([u(11), u(60)].sort());
  });

  it('re-orients `b_to_a` back to source/target, and synthesises the name from it', async () => {
    const { a, b } = await seedConnectorAndPair('b_to_a');
    const parsed = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations')).json(),
    );
    const row = parsed.data[0];
    // `b_to_a` is the only direction that swaps the canonical endpoints — exactly
    // the information canonicalisation would otherwise lose.
    expect(row?.source.id).toBe(b);
    expect(row?.target.id).toBe(a);
    expect(row?.direction).toBe('one-way');
    expect(row?.name).toBe(`${row?.source.name} → ${row?.target.name}`);
  });

  it('excludes evidenced pairs from a ?mechanism_kind= query rather than matching them', async () => {
    await seedConnectorAndPair();
    await t.db
      .insert(integrations)
      .values({ id: u(11), sourceProductId: u(1), targetProductId: u(2), mechanismKind: 'native' });

    const parsed = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), '/api/integrations?mechanism_kind=native')).json(),
    );
    // An evidenced pair carries NO kind, so it matches no value of this filter.
    // Returning null-kind rows to a caller who asked for `native` would be the
    // quiet inconsistency; narrowing to `integrations` is the honest answer.
    expect(parsed.total).toBe(1);
    expect(parsed.data.map((i) => i.id)).toEqual([u(11)]);
  });

  it('applies the ?sourceProductId= filter in the ORIENTED frame, not the canonical slot', async () => {
    const { a, b } = await seedConnectorAndPair('b_to_a');
    // Oriented source is B; asking for the canonical slot A must NOT match.
    const bySource = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), `/api/integrations?sourceProductId=${b}`)).json(),
    );
    expect(bySource.data.map((i) => i.id)).toEqual([u(60)]);
    const byWrongSlot = IntegrationsListResponseSchema.parse(
      await (await get(listApp(), `/api/integrations?sourceProductId=${a}`)).json(),
    );
    expect(byWrongSlot.total).toBe(0);
  });
});

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
