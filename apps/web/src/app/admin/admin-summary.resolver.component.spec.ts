/**
 * Resolver test for `adminSummaryResolver` (AECI-203 / Phase 5.12). Named
 * `.component.spec.ts` so it runs under `ng test` — the resolver's `inject()`
 * surface needs Angular's `TestBed`. Mirrors `create-detail-resolver.component.
 * spec.ts`: a fake `ServerApiClient` drives the server path, `HttpTesting
 * Controller` the client path, and `MetaService` / `RESPONSE_INIT` are stubs.
 *
 * The load-bearing contract: a 401/403 from `GET /api/admin/summary` becomes a
 * 404 render (don't reveal the admin surface), a 200 yields the summary + a
 * TransferState handoff, and a 5xx rethrows (never a fake 404).
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

import type { AdminSummaryResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { adminSummaryResolver } from './admin-summary.resolver';

const API_PATH = '/api/admin/summary';
const STATE_KEY = 'aeci.admin-summary';
const SUMMARY: AdminSummaryResponse = { pending_reviews: 5 };

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
  run: () => Promise<AdminSummaryResponse | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: new Request('https://example.test/admin') },
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
        adminSummaryResolver(ROUTE, STATE),
      ) as Promise<AdminSummaryResponse | null>,
  };
}

describe('adminSummaryResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('returns the summary and stores it in TransferState for an admin (200)', async () => {
    const ctx = createRequestContext(buildClient(async () => SUMMARY));
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });
    const result = await run();

    expect(result).toEqual(SUMMARY);
    expect(ctx.api.request).toHaveBeenCalledWith(API_PATH);
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
    expect(JSON.parse(transferState.toJson())[STATE_KEY]).toEqual(SUMMARY);
  });

  it('maps a 403 to a 404 render (null + status 404 + noindex meta + TransferState null)', async () => {
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
    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://example.test/admin',
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

  it('falls back to null when REQUEST_CONTEXT is missing (defensive)', async () => {
    const { run, transferState } = setup({ platform: 'server', ctx: null });
    expect(await run()).toBeNull();
    expect(JSON.parse(transferState.toJson())[STATE_KEY]).toBeNull();
  });
});

describe('adminSummaryResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads the summary from TransferState on hydration without an HTTP call', async () => {
    const apiRequest = vi.fn();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
    });
    transferState.set(makeStateKey<AdminSummaryResponse | null>(STATE_KEY), SUMMARY);

    expect(await run()).toEqual(SUMMARY);
    expect(apiRequest).not.toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('renders not-found from a null TransferState handoff (non-admin SSR) without a fetch', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });
    transferState.set(makeStateKey<AdminSummaryResponse | null>(STATE_KEY), null);

    expect(await run()).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('fetches via the /api/* passthrough on a TransferState miss', async () => {
    const { run, httpMock } = setup({ platform: 'browser' });

    const promise = run();
    const req = httpMock.expectOne(API_PATH);
    expect(req.request.method).toBe('GET');
    req.flush(SUMMARY);

    expect(await promise).toEqual(SUMMARY);
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
