/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` / `TestBed`
 * to exercise the resolver's DI surface.
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

import type { ProductListItem } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import type { TaxonomyTermDetail } from '../core/api/taxonomy';
import { MetaService } from '../core/meta.service';

import { categoryBrowseResolver, audienceBrowseResolver } from './taxonomy-browse.resolver';

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
}): { run: () => Promise<TaxonomyTermDetail | null>; transferState: TransferState } {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: opts.request ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
    ],
  });

  const resolver = opts.resolver ?? categoryBrowseResolver;
  return {
    transferState: TestBed.inject(TransferState),
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

describe('categoryBrowseResolver — client (hydration) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState and does not call the API or mutate meta', async () => {
    const term = buildTerm();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: { setEntityMeta } as Partial<MetaService>,
    });
    transferState.set(
      makeStateKey<TaxonomyTermDetail | null>('aeci.taxonomy-browse:category:project-management'),
      term,
    );

    const result = await run();

    expect(result).toEqual(term);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(setEntityMeta).not.toHaveBeenCalled();
  });

  it('returns null on TransferState miss', async () => {
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
