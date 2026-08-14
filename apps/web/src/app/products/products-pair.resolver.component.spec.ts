/**
 * Tests for `productsPairResolver` (AECI-294). Named `.component.spec.ts` so it
 * runs under `ng test` — the resolver reads Angular DI tokens (`PLATFORM_ID`,
 * `REQUEST`, `REQUEST_CONTEXT`, `RESPONSE_INIT`, `TransferState`, `HttpClient`).
 *
 * Covers the pair-specific rules on top of the shared detail scaffold:
 *   - canonical is ALWAYS the alphabetically-first orientation;
 *   - an empty pair (no mechanisms) sets `noindex`;
 *   - NOT_FOUND → `RESPONSE_INIT.status = 404` + `setNotFoundMeta`;
 *   - hydration reuses the TransferState value without an HTTP fetch;
 *   - per-mechanism vendor / connector cache tags are pushed onto `ctx.embedded`.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
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

import type { ProductPairResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { productsPairResolver } from './products-pair.resolver';

const STATE = {} as RouterStateSnapshot;

const productListItem = (slug: string, name: string) => ({
  id: `00000000-0000-4000-8000-${slug.padEnd(12, '0')}`,
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: null,
  primary_category: null,
  integration_count: 1,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

function pairFixture(overrides: Partial<ProductPairResponse> = {}): ProductPairResponse {
  return {
    context_product: productListItem('procore', 'Procore'),
    other_product: productListItem('revit', 'Revit'),
    mechanisms: [
      {
        id: '00000000-0000-4000-8000-0000000000aa',
        mechanism_kind: 'native',
        mechanism_name: 'Procore ⇄ Revit',
        direction: 'outbound',
        description: null,
        listing_url: null,
        docs_url: null,
        built_by_vendor: {
          id: 'v1',
          name: 'Autodesk',
          slug: 'autodesk',
          logo_url: null,
          verified: false,
        },
        powered_by_product: { id: 'p9', name: 'Connector', slug: 'connector', logo_url: null },
        claims: [],
      },
    ],
    sync_headline: { total: 0, confirmed: 0, single_source: 0 },
    ...overrides,
  };
}

function metaStub() {
  return { setEntityMeta: vi.fn(), setNotFoundMeta: vi.fn() } as unknown as MetaService & {
    setEntityMeta: ReturnType<typeof vi.fn>;
    setNotFoundMeta: ReturnType<typeof vi.fn>;
  };
}

function setup(opts: {
  platform: 'server' | 'browser';
  contextSlug: string;
  otherSlug: string;
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  request?: Request | null;
  meta: MetaService;
}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      {
        provide: REQUEST,
        useValue:
          opts.request ??
          new Request(
            `https://example.test/products/${opts.contextSlug}/integrations/${opts.otherSlug}`,
          ),
      },
      { provide: MetaService, useValue: opts.meta },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  const route = {
    paramMap: convertToParamMap({ contextSlug: opts.contextSlug, otherSlug: opts.otherSlug }),
  } as unknown as ActivatedRouteSnapshot;

  return {
    transferState: TestBed.inject(TransferState),
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(
        () => productsPairResolver(route, STATE) as Promise<ProductPairResponse | null>,
      ),
  };
}

function apiClient(impl: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(impl) as unknown as ServerApiClient['request'] };
}

describe('productsPairResolver — server path', () => {
  it('canonicalises to the alphabetically-first orientation even when viewed from the other side', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture()));
    // Viewed from Revit (the non-default orientation): revit > procore.
    const { run } = setup({
      platform: 'server',
      contextSlug: 'revit',
      otherSlug: 'procore',
      ctx,
      responseInit: { status: 200 },
      meta,
    });

    await run();

    expect(meta.setEntityMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical: 'https://example.test/products/procore/integrations/revit',
        noindex: false,
      }),
    );
  });

  it('sets noindex when the pair has no mechanisms', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture({ mechanisms: [] })));
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'revit',
      ctx,
      responseInit: { status: 200 },
      meta,
    });

    const result = await run();

    expect(result?.mechanisms).toEqual([]);
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });

  it('pushes per-mechanism vendor + connector cache tags and records a route page view', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture()));
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'revit',
      ctx,
      responseInit: { status: 200 },
      meta,
    });

    await run();

    expect(ctx.embedded).toEqual(
      expect.arrayContaining([
        { type: 'vendor', slug: 'autodesk' },
        { type: 'product', slug: 'connector' },
      ]),
    );
    expect(ctx.pageView).toEqual({ route: '/products/:contextSlug/integrations/:otherSlug' });
  });

  it('returns null, sets 404, and applies not-found meta on NOT_FOUND', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(
      apiClient(async () => {
        throw new ServerApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
      }),
    );
    const responseInit = { status: 200 };
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'nope',
      ctx,
      responseInit,
      meta,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(meta.setNotFoundMeta).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'integration' }),
    );
    expect(meta.setEntityMeta).not.toHaveBeenCalled();
  });
});

describe('productsPairResolver — client path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reuses the TransferState value on hydration without an HTTP fetch', async () => {
    const meta = metaStub();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
    });
    const fixture = pairFixture();
    // Key is orientation-independent: `{min}__{max}`.
    transferState.set(
      makeStateKey<ProductPairResponse | null>('aeci.product-pair:procore__revit'),
      fixture,
    );

    const result = await run();

    expect(result).toEqual(fixture);
    httpMock.verify(); // no outstanding HTTP requests
    expect(meta.setEntityMeta).toHaveBeenCalled();
  });
});
