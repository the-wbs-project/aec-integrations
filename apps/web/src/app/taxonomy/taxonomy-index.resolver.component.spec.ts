/**
 * Resolver test for the generalized taxonomy index factory (AECI-157). Named
 * `.component.spec.ts` so it runs under `ng test` — needs Angular's `inject()` /
 * `TestBed` for the resolver's DI surface. Covers all four facets.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID, REQUEST, REQUEST_CONTEXT, TransferState, makeStateKey } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, type ResolveFn, RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CategoriesListResponse } from '@aeci/shared';

import { type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import {
  audiencesIndexResolver,
  categoriesIndexResolver,
  phasesIndexResolver,
  tradesIndexResolver,
} from './taxonomy-index.resolver';

interface FacetCase {
  name: string;
  resolver: ResolveFn<CategoriesListResponse | null>;
  apiPath: string;
  metaName: string;
  stateKey: string;
  canonical: string;
}

const CASES: FacetCase[] = [
  {
    name: 'categories',
    resolver: categoriesIndexResolver,
    apiPath: '/api/categories',
    metaName: 'Categories',
    stateKey: 'aeci.categories-index',
    canonical: 'https://aecintegrations.com/categories',
  },
  {
    name: 'audiences',
    resolver: audiencesIndexResolver,
    apiPath: '/api/audiences',
    metaName: 'Audiences',
    stateKey: 'aeci.audiences-index',
    canonical: 'https://aecintegrations.com/audiences',
  },
  {
    name: 'phases',
    resolver: phasesIndexResolver,
    apiPath: '/api/phases',
    metaName: 'Phases',
    stateKey: 'aeci.phases-index',
    canonical: 'https://aecintegrations.com/phases',
  },
  {
    name: 'trades',
    resolver: tradesIndexResolver,
    apiPath: '/api/trades',
    metaName: 'Trades',
    stateKey: 'aeci.trades-index',
    canonical: 'https://aecintegrations.com/trades',
  },
];

function buildList(): CategoriesListResponse {
  return {
    data: [
      {
        id: '00000000-0000-4000-8000-000000030001',
        slug: 'project-management',
        name: 'Project Management',
        description: 'Coordinate construction projects.',
        display_order: 1,
        product_count: 12,
      },
    ],
  };
}

function buildClient(request: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = {} as RouterStateSnapshot;

function setup(
  resolver: ResolveFn<CategoriesListResponse | null>,
  opts: {
    platform: 'server' | 'browser';
    ctx?: AeciRequestContext | null;
    meta?: Partial<MetaService>;
  },
): {
  run: () => Promise<CategoriesListResponse | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST, useValue: new Request('https://aecintegrations.com/') },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  return {
    transferState: TestBed.inject(TransferState),
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(() =>
        resolver(ROUTE, STATE),
      ) as Promise<CategoriesListResponse | null>,
  };
}

describe('taxonomy index resolvers — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it.each(CASES)(
    '$name: fetches $apiPath, sets index meta, and stores in TransferState',
    async ({ resolver, apiPath, metaName, stateKey, canonical }) => {
      const list = buildList();
      const setEntityMeta = vi.fn();
      const ctx = createRequestContext(buildClient(async () => list));

      const { run, transferState } = setup(resolver, {
        platform: 'server',
        ctx,
        meta: { setEntityMeta } as Partial<MetaService>,
      });

      const result = await run();

      expect(result).toEqual(list);
      expect(ctx.api.request).toHaveBeenCalledWith(apiPath);
      expect(setEntityMeta).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'index', name: metaName, canonical }),
      );
      const stateKeys = JSON.parse(transferState.toJson());
      expect(stateKeys[stateKey]).toEqual(list);
    },
  );

  it('falls back to null when REQUEST_CONTEXT is missing', async () => {
    const { run, transferState } = setup(categoriesIndexResolver, {
      platform: 'server',
      ctx: null,
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.categories-index']).toBeNull();
  });
});

describe('taxonomy index resolvers — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it.each(CASES)(
    '$name: reads from TransferState on hydration (no fetch) and re-applies meta',
    async ({ resolver, apiPath, metaName, stateKey, canonical }) => {
      const list = buildList();
      const apiRequest = vi.fn();
      const setEntityMeta = vi.fn();

      const { run, transferState, httpMock } = setup(resolver, {
        platform: 'browser',
        ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
        meta: { setEntityMeta } as Partial<MetaService>,
      });
      transferState.set(makeStateKey<CategoriesListResponse | null>(stateKey), list);

      const result = await run();

      expect(result).toEqual(list);
      expect(apiRequest).not.toHaveBeenCalled();
      httpMock.expectNone(apiPath);
      expect(setEntityMeta).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'index', name: metaName, canonical }),
      );
    },
  );

  it.each(CASES)(
    '$name: fetches via the browser /api/* passthrough on a TransferState miss',
    async ({ resolver, apiPath, metaName }) => {
      const list = buildList();
      const apiRequest = vi.fn();
      const setEntityMeta = vi.fn();

      const { run, httpMock } = setup(resolver, {
        platform: 'browser',
        ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
        meta: { setEntityMeta } as Partial<MetaService>,
      });

      const promise = run();
      const req = httpMock.expectOne(apiPath);
      expect(req.request.method).toBe('GET');
      req.flush(list);
      const result = await promise;

      expect(result).toEqual(list);
      expect(apiRequest).not.toHaveBeenCalled();
      expect(setEntityMeta).toHaveBeenCalledWith(
        expect.objectContaining({ entity: 'index', name: metaName }),
      );
    },
  );
});
