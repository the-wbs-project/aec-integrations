/**
 * Resolver test for `homeBrowseResolver` (AECI-184). Named `.component.spec.ts`
 * so it runs under `ng test` — the resolver's `inject()` surface needs Angular's
 * `TestBed`. Mirrors `taxonomy/taxonomy-index.resolver.component.spec.ts`, minus
 * the meta wiring (the home resolver sets no page meta — that's 4.11).
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID, REQUEST_CONTEXT, TransferState, makeStateKey } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaxonomyResponse } from '@aeci/shared';

import { type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';

import { homeBrowseResolver } from './home-browse.resolver';

const STATE_KEY = 'aeci.home-taxonomy';
const API_PATH = '/api/taxonomy';

function buildTaxonomy(): TaxonomyResponse {
  const term = (slug: string, name: string, product_count: number) => ({
    id: slug,
    slug,
    name,
    description: null,
    display_order: 1,
    product_count,
  });
  return {
    categories: [term('bim-authoring', 'BIM Authoring', 12)],
    audiences: [term('architecture', 'Architecture', 8)],
    phases: [term('design', 'Design', 5)],
  };
}

function buildClient(request: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = {} as RouterStateSnapshot;

function setup(opts: { platform: 'server' | 'browser'; ctx?: AeciRequestContext | null }): {
  run: () => Promise<TaxonomyResponse | null>;
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
        homeBrowseResolver(ROUTE, STATE),
      ) as Promise<TaxonomyResponse | null>,
  };
}

describe('homeBrowseResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches /api/taxonomy via the service binding and stores it in TransferState', async () => {
    const taxonomy = buildTaxonomy();
    const ctx = createRequestContext(buildClient(async () => taxonomy));

    const { run, transferState } = setup({ platform: 'server', ctx });
    const result = await run();

    expect(result).toEqual(taxonomy);
    expect(ctx.api.request).toHaveBeenCalledWith(API_PATH);
    const stored = JSON.parse(transferState.toJson());
    expect(stored[STATE_KEY]).toEqual(taxonomy);
  });

  it('falls back to null when REQUEST_CONTEXT is missing', async () => {
    const { run, transferState } = setup({ platform: 'server', ctx: null });
    const result = await run();

    expect(result).toBeNull();
    const stored = JSON.parse(transferState.toJson());
    expect(stored[STATE_KEY]).toBeNull();
  });
});

describe('homeBrowseResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState on hydration without an HTTP call', async () => {
    const taxonomy = buildTaxonomy();
    const apiRequest = vi.fn();

    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
    });
    transferState.set(makeStateKey<TaxonomyResponse | null>(STATE_KEY), taxonomy);

    const result = await run();

    expect(result).toEqual(taxonomy);
    expect(apiRequest).not.toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('fetches via the browser /api/* passthrough on a TransferState miss', async () => {
    const taxonomy = buildTaxonomy();
    const apiRequest = vi.fn();

    const { run, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
    });

    const promise = run();
    const req = httpMock.expectOne(API_PATH);
    expect(req.request.method).toBe('GET');
    req.flush(taxonomy);
    const result = await promise;

    expect(result).toEqual(taxonomy);
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
