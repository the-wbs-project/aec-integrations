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

import type { ProductListItem, VendorDetail } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { vendorDetailResolver } from './vendor-detail.resolver';

function buildProduct(slug: string, id: string): ProductListItem {
  return {
    id,
    slug,
    name: slug,
    logo_url: null,
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: null,
    },
    primary_category: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
  };
}

function buildVendor(overrides: Partial<VendorDetail> = {}): VendorDetail {
  return {
    id: '00000000-0000-4000-8000-000000010001',
    slug: 'procore',
    company_name: 'Procore Technologies',
    logo_url: 'https://example.com/procore.png',
    verified: true,
    headquarters: 'Carpinteria, CA',
    founded_year: 2002,
    product_count: 1,
    integration_count: 2,
    review_count: 0,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management vendor.',
    website: 'https://www.procore.com',
    products: [],
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
}): { run: () => Promise<VendorDetail | null>; transferState: TransferState } {
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
        vendorDetailResolver(buildRouteSnapshot('procore'), STATE),
      ) as Promise<VendorDetail | null>,
  };
}

describe('vendorDetailResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches the vendor, sets meta + JSON-LD, populates ctx, and stores in TransferState on success', async () => {
    const vendor = buildVendor({
      products: [
        buildProduct('procore-platform', '00000000-0000-4000-8000-000000020001'),
        buildProduct('procore-revizto', '00000000-0000-4000-8000-000000020002'),
      ],
    });
    const setEntityMeta = vi.fn();
    const setVendorJsonLd = vi.fn();
    const ctx = createRequestContext(buildClient(async () => vendor));
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/vendors/procore'),
      meta: { setEntityMeta, setVendorJsonLd } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toEqual(vendor);
    expect(responseInit.status).toBe(200);
    expect(setEntityMeta).toHaveBeenCalledWith({
      entity: 'vendor',
      name: 'Procore Technologies',
      description: 'Construction management vendor.',
      canonical: 'https://aecintegrations.com/vendors/procore',
      ogImage: 'https://example.com/procore.png',
    });
    expect(setVendorJsonLd).toHaveBeenCalledWith(vendor);

    // Embedded tag for every product rendered on the page. The path matcher
    // already emits `vendor:procore` and `route:detail`; the resolver only
    // pushes the product tags so purges on those products cascade here.
    expect(ctx.embedded).toEqual([
      { type: 'product', slug: 'procore-platform' },
      { type: 'product', slug: 'procore-revizto' },
    ]);

    expect(ctx.pageView).toEqual({
      route: '/vendors/:slug',
      entity_type: 'vendor',
      entity_id: '00000000-0000-4000-8000-000000010001',
    });

    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.vendor-detail:procore']).toEqual(vendor);
  });

  it('returns null on NOT_FOUND, sets RESPONSE_INIT.status=404, sets noindex meta, no pageView', async () => {
    const setNotFoundMeta = vi.fn();
    const setEntityMeta = vi.fn();
    const setVendorJsonLd = vi.fn();
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
      request: new Request('https://aecintegrations.com/vendors/procore'),
      meta: { setNotFoundMeta, setEntityMeta, setVendorJsonLd } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'vendor',
      slug: 'procore',
      canonical: 'https://aecintegrations.com/vendors/procore',
    });
    expect(setEntityMeta).not.toHaveBeenCalled();
    expect(setVendorJsonLd).not.toHaveBeenCalled();
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
      request: new Request('https://aecintegrations.com/vendors/procore'),
      meta: {} as Partial<MetaService>,
    });

    await expect(run()).rejects.toBe(err);
  });

  it('falls back gracefully when REQUEST_CONTEXT is null (defensive — non-Server render mode)', async () => {
    const { run, transferState } = setup({
      platform: 'server',
      ctx: null,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/vendors/procore'),
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.vendor-detail:procore']).toBeNull();
  });
});

describe('vendorDetailResolver — client (hydration) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState and does not call the API or mutate meta/ctx', async () => {
    const vendor = buildVendor();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: { setEntityMeta } as Partial<MetaService>,
    });
    transferState.set(makeStateKey<VendorDetail | null>('aeci.vendor-detail:procore'), vendor);

    const result = await run();

    expect(result).toEqual(vendor);
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
