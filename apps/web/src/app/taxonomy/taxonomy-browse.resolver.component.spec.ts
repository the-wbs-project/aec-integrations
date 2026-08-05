/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` / `TestBed`
 * to exercise the resolver's DI surface.
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

import { TRADE_PUBLISH_MIN_PRODUCTS, type ProductListItem } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import type { TaxonomyTermDetail } from '../core/api/taxonomy';
import { MetaService } from '../core/meta.service';

import {
  categoryBrowseResolver,
  audienceBrowseResolver,
  phaseBrowseResolver,
  tradeBrowseResolver,
} from './taxonomy-browse.resolver';

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

function buildTerm(overrides: Partial<TaxonomyTermDetail> = {}): TaxonomyTermDetail {
  return {
    id: '00000000-0000-4000-8000-000000030001',
    slug: 'project-management',
    name: 'Project Management',
    description: 'Tools that coordinate construction projects.',
    display_order: 1,
    product_count: 2,
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
  slug?: string;
  resolver?: typeof categoryBrowseResolver;
}): {
  run: () => Promise<TaxonomyTermDetail | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: opts.request ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  const resolver = opts.resolver ?? categoryBrowseResolver;
  return {
    transferState: TestBed.inject(TransferState),
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(() =>
        resolver(buildRouteSnapshot(opts.slug ?? 'project-management'), STATE),
      ) as Promise<TaxonomyTermDetail | null>,
  };
}

describe('categoryBrowseResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches the term, sets browse meta, embeds product tags, queues pageView, stores in TransferState', async () => {
    const term = buildTerm({
      products: [
        buildProduct('procore-platform', '00000000-0000-4000-8000-000000020001'),
        buildProduct('autodesk-build', '00000000-0000-4000-8000-000000020002'),
      ],
    });
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => term));
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/categories/project-management'),
      meta: { setEntityMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toEqual(term);
    expect(ctx.api.request).toHaveBeenCalledWith('/api/categories/project-management');
    expect(responseInit.status).toBe(200);
    expect(setEntityMeta).toHaveBeenCalledWith({
      entity: 'category',
      name: 'Project Management',
      description: 'Tools that coordinate construction projects.',
      canonical: 'https://aecintegrations.com/categories/project-management',
      // Every browse page now carries an explicit indexability decision
      // (AECI-546); only trades can ever resolve it to `true`.
      noindex: false,
    });
    expect(ctx.embedded).toEqual([
      { type: 'product', slug: 'procore-platform' },
      { type: 'product', slug: 'autodesk-build' },
    ]);
    expect(ctx.pageView).toEqual({
      route: '/categories/:slug',
      entity_type: 'category',
      entity_id: '00000000-0000-4000-8000-000000030001',
    });

    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.taxonomy-browse:category:project-management']).toEqual(term);
  });

  it('returns null on NOT_FOUND, sets status 404 + noindex meta, no pageView/embedded', async () => {
    const setNotFoundMeta = vi.fn();
    const setEntityMeta = vi.fn();
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
      request: new Request('https://aecintegrations.com/categories/missing'),
      meta: { setNotFoundMeta, setEntityMeta } as Partial<MetaService>,
      slug: 'missing',
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'category',
      slug: 'missing',
      canonical: 'https://aecintegrations.com/categories/missing',
    });
    expect(setEntityMeta).not.toHaveBeenCalled();
    expect(ctx.pageView).toBeNull();
    expect(ctx.embedded).toEqual([]);
  });

  it('rethrows non-404 errors', async () => {
    const err = new ServerApiError({ status: 500, code: 'INTERNAL_ERROR', message: 'down' });
    const ctx = createRequestContext(
      buildClient(async () => {
        throw err;
      }),
    );

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/categories/project-management'),
      meta: {} as Partial<MetaService>,
    });

    await expect(run()).rejects.toBe(err);
  });

  it('falls back gracefully when REQUEST_CONTEXT is null', async () => {
    const { run, transferState } = setup({
      platform: 'server',
      ctx: null,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/categories/project-management'),
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.taxonomy-browse:category:project-management']).toBeNull();
  });
});

describe('audienceBrowseResolver — kind wiring', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('hits the audiences endpoint and tags the pageView/meta with the audience kind', async () => {
    const term = buildTerm({ slug: 'structural', name: 'Structural' });
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => term));

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/audiences/structural'),
      meta: { setEntityMeta } as Partial<MetaService>,
      slug: 'structural',
      resolver: audienceBrowseResolver,
    });

    await run();

    expect(ctx.api.request).toHaveBeenCalledWith('/api/audiences/structural');
    expect(setEntityMeta).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'audience', name: 'Structural' }),
    );
    expect(ctx.pageView).toEqual({
      route: '/audiences/:slug',
      entity_type: 'audience',
      entity_id: term.id,
    });
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.taxonomy-browse:audience:structural']).toEqual(term);
  });
});

describe('tradeBrowseResolver — kind wiring (AECI-544)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('hits the trades endpoint and tags the pageView/meta with the trade kind', async () => {
    const term = buildTerm({ slug: 'electrical', name: 'Electrical' });
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => term));

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://aecintegrations.com/trades/electrical'),
      meta: { setEntityMeta } as Partial<MetaService>,
      slug: 'electrical',
      resolver: tradeBrowseResolver,
    });

    await run();

    expect(ctx.api.request).toHaveBeenCalledWith('/api/trades/electrical');
    expect(setEntityMeta).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'trade', name: 'Electrical' }),
    );
    expect(ctx.pageView).toEqual({
      route: '/trades/:slug',
      entity_type: 'trade',
      entity_id: term.id,
    });
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.taxonomy-browse:trade:electrical']).toEqual(term);
  });

  it('resolves a sub-floor trade normally — the publication gate is not a 404', async () => {
    // TRADES_VOCABULARY.md §6: URLs are stable across the gate, so a term with
    // fewer than TRADE_PUBLISH_MIN_PRODUCTS products still returns 200 and only
    // loses its listing. Crossing the floor therefore needs no redirect.
    const term = { ...buildTerm({ slug: 'roofing', name: 'Roofing' }), product_count: 0 };
    const ctx = createRequestContext(buildClient(async () => term));
    const responseInit = { status: 200 };
    const setEntityMeta = vi.fn();

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/trades/roofing'),
      meta: { setEntityMeta } as Partial<MetaService>,
      slug: 'roofing',
      resolver: tradeBrowseResolver,
    });

    await expect(run()).resolves.toEqual(term);
    expect(responseInit.status).toBe(200);
    // …but it is not indexed — the other half of the gate (AECI-546).
    expect(setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });
});

// ── The publication gate's indexability half (AECI-546) ──────────────────────
// The gate lives in `applyBrowseMeta`, shared by the server and client branches,
// so SSR and a client navigation can't disagree about whether a page is indexed.
describe('browse resolvers — trade publication gate → noindex', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /**
   * Resolve `resolver` server-side for a term with `product_count`; returns the
   * meta input. Resets the TestBed itself so one `it` can compare several facets.
   */
  async function metaFor(
    resolver: typeof categoryBrowseResolver,
    segment: string,
    slug: string,
    product_count: number,
  ) {
    TestBed.resetTestingModule();
    const term = { ...buildTerm({ slug, name: slug }), product_count };
    const setEntityMeta = vi.fn();
    const { run } = setup({
      platform: 'server',
      ctx: createRequestContext(buildClient(async () => term)),
      responseInit: { status: 200 },
      request: new Request(`https://aecintegrations.com/${segment}/${slug}`),
      meta: { setEntityMeta } as Partial<MetaService>,
      slug,
      resolver,
    });
    await run();
    return setEntityMeta.mock.calls[0]![0] as { noindex?: boolean };
  }

  it('noindexes a trade below the floor', async () => {
    expect(
      (await metaFor(tradeBrowseResolver, 'trades', 'roofing', TRADE_PUBLISH_MIN_PRODUCTS - 1))
        .noindex,
    ).toBe(true);
  });

  it('noindexes a trade with no products at all', async () => {
    expect((await metaFor(tradeBrowseResolver, 'trades', 'rail', 0)).noindex).toBe(true);
  });

  // The floor is inclusive: exactly N publishes.
  it('leaves a trade at the floor indexable', async () => {
    expect(
      (await metaFor(tradeBrowseResolver, 'trades', 'electrical', TRADE_PUBLISH_MIN_PRODUCTS))
        .noindex,
    ).toBe(false);
  });

  // Trades are the ONLY count-gated facet. An empty category or phase is a data
  // problem to fix, not a page to hide — those vocabularies are curated against
  // the catalog rather than seeded closed.
  it('never noindexes the three sibling facets, even at zero products', async () => {
    expect((await metaFor(categoryBrowseResolver, 'categories', 'cost', 0)).noindex).toBe(false);
    expect((await metaFor(audienceBrowseResolver, 'audiences', 'structural', 0)).noindex).toBe(
      false,
    );
    expect((await metaFor(phaseBrowseResolver, 'phases', 'design', 0)).noindex).toBe(false);
  });

  // A client-side navigation to a sub-floor trade must apply the same gate — the
  // SSR HTML is only half the story once the app is hydrated, and `setEntityMeta`
  // clears the robots tag when it isn't told to set one.
  it('applies the gate on the client branch too', async () => {
    const term = {
      ...buildTerm({ slug: 'roofing', name: 'Roofing' }),
      product_count: TRADE_PUBLISH_MIN_PRODUCTS - 1,
    };
    const setEntityMeta = vi.fn();

    const { run, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: vi.fn() } as unknown as ServerApiClient),
      request: new Request('https://aecintegrations.com/trades/roofing'),
      meta: { setEntityMeta } as Partial<MetaService>,
      slug: 'roofing',
      resolver: tradeBrowseResolver,
    });

    const promise = run();
    httpMock.expectOne('/api/trades/roofing').flush(term);
    await promise;

    expect(setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });
});

describe('categoryBrowseResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const expectedMeta = {
    entity: 'category',
    name: 'Project Management',
    description: 'Tools that coordinate construction projects.',
    canonical: 'https://aecintegrations.com/categories/project-management',
    noindex: false,
  };

  it('reads from TransferState on hydration (no fetch) and re-applies browse meta', async () => {
    const term = buildTerm();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      request: new Request('https://aecintegrations.com/categories/project-management'),
      meta: { setEntityMeta } as Partial<MetaService>,
    });
    transferState.set(
      makeStateKey<TaxonomyTermDetail | null>('aeci.taxonomy-browse:category:project-management'),
      term,
    );

    const result = await run();

    expect(result).toEqual(term);
    expect(apiRequest).not.toHaveBeenCalled();
    httpMock.expectNone('/api/categories/project-management');
    expect(setEntityMeta).toHaveBeenCalledWith(expectedMeta);
  });

  it('fetches via the browser /api/* passthrough on a TransferState miss and sets meta', async () => {
    const term = buildTerm();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      request: new Request('https://aecintegrations.com/categories/project-management'),
      meta: { setEntityMeta } as Partial<MetaService>,
    });

    const promise = run();
    const req = httpMock.expectOne('/api/categories/project-management');
    expect(req.request.method).toBe('GET');
    req.flush(term);
    const result = await promise;

    expect(result).toEqual(term);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(setEntityMeta).toHaveBeenCalledWith(expectedMeta);
  });

  it('renders not-found (setNotFoundMeta, null) on a NOT_FOUND client fetch', async () => {
    const setEntityMeta = vi.fn();
    const setNotFoundMeta = vi.fn();

    const { run, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: vi.fn() } as unknown as ServerApiClient),
      request: new Request('https://aecintegrations.com/categories/missing'),
      meta: { setEntityMeta, setNotFoundMeta } as Partial<MetaService>,
      slug: 'missing',
    });

    const promise = run();
    httpMock
      .expectOne('/api/categories/missing')
      .flush(
        { error: { code: 'NOT_FOUND', message: 'missing' } },
        { status: 404, statusText: 'Not Found' },
      );
    const result = await promise;

    expect(result).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'category',
      slug: 'missing',
      canonical: 'https://aecintegrations.com/categories/missing',
    });
    expect(setEntityMeta).not.toHaveBeenCalled();
  });
});
