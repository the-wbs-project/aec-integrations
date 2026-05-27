import { IntegrationDetailSchema, IntegrationsListResponseSchema } from '@aeci/shared';
import { describe, expect, it } from 'vitest';

import {
  NULL_NAME_INTEGRATION_ID,
  PROCORE_REVIZTO_INTEGRATION_ID,
  allIntegrationRows,
  nullNameIntegrationRow,
  procoreReviztoIntegrationDetailRow,
  procoreReviztoIntegrationRow,
} from '../test/fixtures/integrations';
import {
  buildAppWithHandler,
  fakeExecutionContext,
  makeMockAcceleratedPrisma,
  TEST_ENV,
  type MockAcceleratedPrisma,
} from '../test/helpers';
import { createIntegrationDetailHandler, createIntegrationsListHandler } from './integrations';

function listApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/integrations',
    handler: createIntegrationsListHandler(() => prisma as never),
  });
}

function detailApp(prisma: MockAcceleratedPrisma) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/integrations/:id',
    handler: createIntegrationDetailHandler(() => prisma as never),
  });
}

describe('GET /api/integrations', () => {
  it('default sort is `name ASC` per §7.4', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findMany: allIntegrationRows, count: allIntegrationRows.length },
    });
    await listApp(prisma).request('/api/integrations', {}, TEST_ENV, fakeExecutionContext());

    const call = prisma.integration.findMany.mock.calls[0][0] as { orderBy: unknown };
    expect(call.orderBy).toEqual({ name: 'asc' });
  });

  it('synthesizes `Source → Target` for rows with null `name`', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findMany: [nullNameIntegrationRow], count: 1 },
    });
    const res = await listApp(prisma).request(
      '/api/integrations',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = await res.json();
    const parsed = IntegrationsListResponseSchema.parse(body);
    expect(parsed.data[0].name).toBe('Procore → Revizto');
    // Null mechanism_kind in the row should be coalesced to 'native' so the
    // schema's non-null enum is satisfied.
    expect(parsed.data[0].mechanism_kind).toBe('native');
  });

  it('expands `search` into an OR across name, sourceProduct.name, targetProduct.name', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findMany: [], count: 0 },
    });
    await listApp(prisma).request(
      '/api/integrations?search=Procore',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const call = prisma.integration.findMany.mock.calls[0][0] as {
      where: {
        OR?: Array<{
          name?: { contains: string; mode: string };
          sourceProduct?: { name: { contains: string; mode: string } };
          targetProduct?: { name: { contains: string; mode: string } };
        }>;
      };
    };
    expect(call.where.OR).toEqual([
      { name: { contains: 'Procore', mode: 'insensitive' } },
      { sourceProduct: { name: { contains: 'Procore', mode: 'insensitive' } } },
      { targetProduct: { name: { contains: 'Procore', mode: 'insensitive' } } },
    ]);
    // Plain `name` filter must NOT be present — it would silently miss null-name rows.
    expect(call.where).not.toHaveProperty('name');
  });

  it('combines `search` OR clause with other filters (AND semantics)', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findMany: [], count: 0 },
    });
    const sourceProductId = '00000000-0000-4000-8000-000000020001';
    await listApp(prisma).request(
      `/api/integrations?search=Revizto&sourceProductId=${sourceProductId}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const call = prisma.integration.findMany.mock.calls[0][0] as {
      where: { sourceProductId?: string; OR?: unknown };
    };
    // Both conditions must be present so Prisma generates:
    // WHERE sourceProductId = ? AND (name ILIKE ? OR …)
    expect(call.where.sourceProductId).toBe(sourceProductId);
    expect(call.where.OR).toHaveLength(3);
  });

  it('applies `sourceProductId` and `mechanism_kind` filters', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findMany: [], count: 0 },
    });
    const sourceProductId = '00000000-0000-4000-8000-000000020001';
    await listApp(prisma).request(
      `/api/integrations?sourceProductId=${sourceProductId}&mechanism_kind=api`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const call = prisma.integration.findMany.mock.calls[0][0] as {
      where: { sourceProductId?: string; mechanismKind?: string };
    };
    expect(call.where).toMatchObject({
      sourceProductId,
      mechanismKind: 'api',
    });
  });
});

describe('GET /api/integrations/:id', () => {
  it('returns the full detail with built_by_vendor + powered_by_product as null when absent', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findUnique: procoreReviztoIntegrationDetailRow },
    });
    const res = await detailApp(prisma).request(
      `/api/integrations/${PROCORE_REVIZTO_INTEGRATION_ID}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = IntegrationDetailSchema.parse(body);
    expect(parsed.built_by_vendor).toBeNull();
    expect(parsed.powered_by_product).toBeNull();
    expect(parsed.pricing_model).toBe('free');
  });

  it('returns 404 with `details: { resource: "integration", id }` when no row matches', async () => {
    const prisma = makeMockAcceleratedPrisma({ integration: { findUnique: null } });
    const res = await detailApp(prisma).request(
      `/api/integrations/${NULL_NAME_INTEGRATION_ID}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: { code: string; details?: { resource?: string; id?: string } };
    };
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.details).toEqual({ resource: 'integration', id: NULL_NAME_INTEGRATION_ID });
  });

  it('returns 404 for a malformed UUID without hitting Prisma', async () => {
    const prisma = makeMockAcceleratedPrisma();
    const res = await detailApp(prisma).request(
      '/api/integrations/not-a-uuid',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );

    expect(res.status).toBe(404);
    expect(prisma.integration.findUnique).not.toHaveBeenCalled();
  });

  it('synthesizes Source → Target name on detail responses too', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: {
        findUnique: {
          ...procoreReviztoIntegrationDetailRow,
          ...nullNameIntegrationRow,
          description: 'desc',
          listingUrl: null,
          docsUrl: null,
          mechanismUrl: null,
          pricingModel: null,
          maturity: null,
          builtByVendor: null,
          poweredByProduct: null,
        },
      },
    });
    const res = await detailApp(prisma).request(
      `/api/integrations/${NULL_NAME_INTEGRATION_ID}`,
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    const body = await res.json();
    const parsed = IntegrationDetailSchema.parse(body);
    expect(parsed.name).toBe('Procore → Revizto');
  });

  // List row is unchanged through the helper — `procoreReviztoIntegrationRow`
  // is used in the synthesizes test above when we needed an alternate name.
  it('list endpoint still emits Cache-Control on success', async () => {
    const prisma = makeMockAcceleratedPrisma({
      integration: { findMany: [procoreReviztoIntegrationRow], count: 1 },
    });
    const res = await listApp(prisma).request(
      '/api/integrations',
      {},
      TEST_ENV,
      fakeExecutionContext(),
    );
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
