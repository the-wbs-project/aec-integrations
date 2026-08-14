/**
 * Resolver test for `vendorMeResolver` (AECI-522). Named `.component.spec.ts` so
 * it runs under `ng test` — the resolver's `inject()` surface needs Angular's
 * `TestBed`. Mirrors `admin-summary.resolver.component.spec.ts`: a fake
 * `ServerApiClient` drives the server path, `HttpTestingController` the client
 * path, and `MetaService` / `RESPONSE_INIT` are stubs.
 *
 * The load-bearing contract (the vendor-portal gate): a 401/403/404 from
 * `GET /api/vendor/me` becomes a 404 render (don't reveal the surface), a 200
 * yields the payload + a TransferState handoff, and a 5xx rethrows (never a fake
 * 404 on an outage).
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
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { vendorMeResolver } from './vendor-me.resolver';

const API_PATH = '/api/vendor/me';
const STATE_KEY = 'aeci.vendor-me';
const ME: VendorMeResponse = {
  vendor: {
    id: '00000000-0000-4000-8000-000000005200',
    slug: 'summit-bim',
    company_name: 'Summit BIM',
    verified: true,
    description: null,
    website: null,
    headquarters: null,
    founded_year: null,
    public_private: null,
    parent_company: null,
    contact_email: null,
    phone_number: null,
    logo_url: null,
    linkedin_url: null,
    x_url: null,
    facebook_url: null,
    instagram_url: null,
    youtube_url: null,
    crunchbase_url: null,
    wiki_url: null,
    github_org: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  products: [],
  requests: [],
  seat_count: 1,
};

const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = {} as RouterStateSnapshot;

function buildClient(request: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

function apiError(status: number, code = 'FORBIDDEN'): ServerApiError {
  return new ServerApiError({ status, code, message: `${status}` });
}

function setup(opts: {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  meta?: Partial<MetaService>;
}): {
  run: () => Promise<VendorMeResponse | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: new Request('https://example.test/vendor') },
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
        vendorMeResolver(ROUTE, STATE),
      ) as Promise<VendorMeResponse | null>,
  };
}

describe('vendorMeResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('returns the payload and stores it in TransferState for a vendor (200)', async () => {
    const ctx = createRequestContext(buildClient(async () => ME));
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });
    const result = await run();

    expect(result).toEqual(ME);
    expect(ctx.api.request).toHaveBeenCalledWith(API_PATH);
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
    expect(JSON.parse(transferState.toJson())[STATE_KEY]).toEqual(ME);
  });

  it('maps a 403 (reviewer / banned / admin) to a 404 render', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw apiError(403);
      }),
    );
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://example.test/vendor',
    });
    expect(JSON.parse(transferState.toJson())[STATE_KEY]).toBeNull();
  });

  it('maps a 401 (expired/no session) to the same 404 render', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw apiError(401, 'UNAUTHENTICATED');
      }),
    );
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalled();
  });

  it('rethrows a 5xx (never fakes a 404 on an outage)', async () => {
    const err = apiError(500, 'INTERNAL_ERROR');
    const ctx = createRequestContext(
      buildClient(async () => {
        throw err;
      }),
    );
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    await expect(run()).rejects.toBe(err);
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });
});

describe('vendorMeResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads the payload from TransferState on hydration without an HTTP call', async () => {
    const apiRequest = vi.fn();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
    });
    transferState.set(makeStateKey<VendorMeResponse | null>(STATE_KEY), ME);

    expect(await run()).toEqual(ME);
    expect(apiRequest).not.toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('renders not-found from a null TransferState handoff (non-vendor SSR)', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });
    transferState.set(makeStateKey<VendorMeResponse | null>(STATE_KEY), null);

    expect(await run()).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('fetches via the /api/* passthrough on a TransferState miss', async () => {
    const { run, httpMock } = setup({ platform: 'browser' });

    const promise = run();
    const req = httpMock.expectOne(API_PATH);
    expect(req.request.method).toBe('GET');
    req.flush(ME);

    expect(await promise).toEqual(ME);
  });

  it('maps a 403 client fetch to the not-found render', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    httpMock
      .expectOne(API_PATH)
      .flush(
        { error: { code: 'FORBIDDEN', message: 'no' } },
        { status: 403, statusText: 'Forbidden' },
      );

    expect(await promise).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalled();
  });

  it('rethrows a 5xx client fetch', async () => {
    const { run, httpMock } = setup({ platform: 'browser' });

    const promise = run();
    httpMock
      .expectOne(API_PATH)
      .flush(
        { error: { code: 'INTERNAL_ERROR', message: 'down' } },
        { status: 500, statusText: 'Server Error' },
      );

    await expect(promise).rejects.toBeTruthy();
  });
});
