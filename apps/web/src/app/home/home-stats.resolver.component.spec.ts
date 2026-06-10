/**
 * Resolver test for `homeStatsResolver` (AECI-186). Named `.component.spec.ts`
 * so it runs under `ng test` — the resolver's `inject()` surface needs Angular's
 * `TestBed`. Mirrors `home-browse.resolver.component.spec.ts` (the stats sibling
 * resolver), minus any meta wiring (home meta is set by the component, not here).
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, makeStateKey } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { HomeStatsResponse } from '@aeci/shared';

import { type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';

import { homeStatsResolver } from './home-stats.resolver';

const STATE_KEY = 'aeci.home-stats';
const API_PATH = '/api/stats/home';

function buildStats(): HomeStatsResponse {
  return {
    total_integrations: 42,
    integrations_added_30d: 7,
    most_integrated_product: {
      product: { id: 'p1', slug: 'procore', name: 'Procore', logo_url: null },
      integration_count: 12,
    },
    most_active_category: {
      category: { id: 'c1', slug: 'bim-authoring', name: 'BIM Authoring' },
      integration_count: 9,
    },
    recent_integrations: [],
    trending_products: [],
    recently_added_products: [],
  };
}

function buildClient(request: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = {} as RouterStateSnapshot;

function setup(opts: { platform: 'server' | 'browser'; ctx?: AeciRequestContext | null }): {
  run: () => Promise<HomeStatsResponse | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  return {
    transferState: TestBed.inject(TransferState),
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(() =>
        homeStatsResolver(ROUTE, STATE),
      ) as Promise<HomeStatsResponse | null>,
  };
}

describe('homeStatsResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches /api/stats/home via the service binding and stores it in TransferState', async () => {
    const stats = buildStats();
    const ctx = createRequestContext(buildClient(async () => stats));

    const { run, transferState } = setup({ platform: 'server', ctx });
    const result = await run();

    expect(result).toEqual(stats);
    expect(ctx.api.request).toHaveBeenCalledWith(API_PATH);
    const stored = JSON.parse(transferState.toJson());
    expect(stored[STATE_KEY]).toEqual(stats);
  });

  it('falls back to null when REQUEST_CONTEXT is missing', async () => {
    const { run, transferState } = setup({ platform: 'server', ctx: null });
    const result = await run();

    expect(result).toBeNull();
    const stored = JSON.parse(transferState.toJson());
    expect(stored[STATE_KEY]).toBeNull();
  });
});

describe('homeStatsResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState on hydration without an HTTP call', async () => {
    const stats = buildStats();
    const apiRequest = vi.fn();

    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
    });
    transferState.set(makeStateKey<HomeStatsResponse | null>(STATE_KEY), stats);

    const result = await run();

    expect(result).toEqual(stats);
    expect(apiRequest).not.toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('fetches via the browser /api/* passthrough on a TransferState miss', async () => {
    const stats = buildStats();
    const apiRequest = vi.fn();

    const { run, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
    });

    const promise = run();
    const req = httpMock.expectOne(API_PATH);
    expect(req.request.method).toBe('GET');
    req.flush(stats);
    const result = await promise;

    expect(result).toEqual(stats);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
