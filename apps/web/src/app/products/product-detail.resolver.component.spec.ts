/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` /
 * `TestBed` to exercise the resolver's DI surface. Plain `*.spec.ts`
 * is Vitest-only and excludes Angular per `apps/web/vitest.config.ts`.
 */
import {
  PLATFORM_ID,
  REQUEST,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  TransferState,
  makeStateKey,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot, convertToParamMap } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { productDetailResolver } from './product-detail.resolver';

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: 'https://example.com/procore.png',
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: 'https://example.com/procore-logo.png',
    },
    integration_count: 2,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management platform.',
    website: 'https://www.procore.com',
    tool_integrations_url: null,
    api_docs_url: null,
    has_api_docs: false,
    categories: [],
    disciplines: [],
    phases: [],
    integrations_as_source: [],
    integrations_as_target: [],
    related_products: [],
    ...overrides,
  };
}

function buildClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

function buildRouteSnapshot(slug: string): ActivatedRouteSnapshot {
  return { paramMap: convertToParamMap({ slug }) } as unknown as ActivatedRouteSnapshot;
}

const STATE = {} as RouterStateSnapshot;

function setup(opts: {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  request?: Request | null;
  meta?: Partial<MetaService>;
}): { run: () => Promise<ProductDetail | null>; transferState: TransferState } {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: opts.request ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
    ],
  });

  return {
    transferState: TestBed.inject(TransferState),
    run: () =>
      TestBed.runInInjectionContext(() =>
        productDetailResolver(buildRouteSnapshot('procore'), STATE),
      ) as Promise<ProductDetail | null>,
  };
}

describe('productDetailResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches the product, sets meta, populates ctx, and stores in TransferState on success', async () => {
    const product = buildProduct({
      integrations_as_source: [
        // Minimal IntegrationListItem shape — only id is read by the resolver.
        {
          id: 'int-a',
          name: 'A → B',
          mechanism_kind: 'native',
          mechanism_name: null,
          direction: null,
          source: { id: 's1', name: 'A', slug: 'a', logo_url: null },
          target: { id: 't1', name: 'B', slug: 'b', logo_url: null },
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
      integrations_as_target: [
        {
          id: 'int-b',
          name: 'C → procore',
          mechanism_kind: 'native',
          mechanism_name: null,
          direction: null,
          source: { id: 's2', name: 'C', slug: 'c', logo_url: null },
          target: { id: 't2', name: 'Procore', slug: 'procore', logo_url: null },
          created_at: '2024-01-01T00:00:00.000Z',
          updated_at: '2024-01-01T00:00:00.000Z',
        },
      ],
    });
    const setEntityMeta = vi.fn();
    const setProductJsonLd = vi.fn();
    const ctx = createRequestContext(buildClient(async () => product));
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: { setEntityMeta, setProductJsonLd } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toEqual(product);
    expect(responseInit.status).toBe(200); // unchanged
    expect(setEntityMeta).toHaveBeenCalledWith({
      entity: 'product',
      name: 'Procore',
      description: 'Construction management platform.',
      canonical: 'https://aecintegrations.com/products/procore',
      ogImage: 'https://example.com/procore.png',
    });
    expect(setProductJsonLd).toHaveBeenCalledWith(product);

    // Vendor tag + integration tag + partner product tag for each shown
    // integration (both source and target lists). Partner product tags are
    // required per CACHE_STRATEGY.md §3 so edits to those products purge
    // this page.
    expect(ctx.embedded).toEqual([
      { type: 'vendor', slug: 'procore' },
      { type: 'integration', id: 'int-a' },
      { type: 'product', slug: 'b' }, // target of integrations_as_source[0]
      { type: 'integration', id: 'int-b' },
      { type: 'product', slug: 'c' }, // source of integrations_as_target[0]
    ]);

    // Page-view payload set with route + entity_id.
    expect(ctx.pageView).toEqual({
      route: '/products/:slug',
      entity_type: 'product',
      entity_id: '00000000-0000-4000-8000-000000020001',
    });

    // TransferState carries the full product so hydration skips the fetch.
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.product-detail:procore']).toEqual(product);
  });

  it('returns null on NOT_FOUND, sets RESPONSE_INIT.status=404, sets noindex meta, no pageView', async () => {
    const setNotFoundMeta = vi.fn();
    const setEntityMeta = vi.fn();
    const setProductJsonLd = vi.fn();
    const ctx = createRequestContext(
      buildClient(async () => {
        throw new ServerApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
      }),
    );
    const responseInit = { status: 200 };

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: { setNotFoundMeta, setEntityMeta, setProductJsonLd } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'product',
      slug: 'procore',
      canonical: 'https://aecintegrations.com/products/procore',
    });
    // Detail meta + JSON-LD must NOT run on the 404 path.
    expect(setEntityMeta).not.toHaveBeenCalled();
    expect(setProductJsonLd).not.toHaveBeenCalled();
    // Page-view must NOT fire for 404s (handled by runtime, but resolver
    // also leaves pageView null so even a future runtime change can't leak).
    expect(ctx.pageView).toBeNull();
    expect(ctx.embedded).toEqual([]);
  });

  it('rethrows non-404 errors (resolver does not swallow 5xx)', async () => {
    const err = new ServerApiError({
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'database unreachable',
    });
    const ctx = createRequestContext(
      buildClient(async () => {
        throw err;
      }),
    );

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: {} as Partial<MetaService>,
    });

    await expect(run()).rejects.toBe(err);
  });

  it('falls back gracefully when REQUEST_CONTEXT is null (defensive — non-Server render mode)', async () => {
    const { run, transferState } = setup({
      platform: 'server',
      ctx: null,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/products/procore'),
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    // TransferState still carries null so hydration is consistent.
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.product-detail:procore']).toBeNull();
  });
});

describe('productDetailResolver — client (hydration) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState and does not call the API or mutate meta/ctx', async () => {
    const product = buildProduct();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'browser',
      // Browser context: REQUEST_CONTEXT is normally not provided. We still
      // pass one in (with a stub client) so any leaked fetch attempt would
      // surface as a `apiRequest` call we can assert *was not* made.
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: { setEntityMeta } as Partial<MetaService>,
    });
    // Same key the resolver uses internally.
    transferState.set(makeStateKey<ProductDetail | null>('aeci.product-detail:procore'), product);

    const result = await run();

    expect(result).toEqual(product);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(setEntityMeta).not.toHaveBeenCalled();
  });

  it('returns null on TransferState miss (no SSR snapshot for this slug)', async () => {
    const apiRequest = vi.fn();
    const { run } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
