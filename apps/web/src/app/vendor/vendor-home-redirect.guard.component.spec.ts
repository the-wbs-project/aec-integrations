/**
 * Guard test for `vendorHomeRedirectGuard` — the bare `/vendor` entry point.
 * Named `.component.spec.ts` so it runs under `ng test`: the guard's `inject()`
 * surface needs Angular's `TestBed`. Same harness shape as
 * `vendor-me.resolver.component.spec.ts`.
 *
 * Written with AECI-954, which is also the first spec this guard has had. Four
 * contracts, and the first two predate this issue:
 *
 *   - 200 → a `UrlTree` to `/vendor/:vendorSlug/overview`. Under SSR that becomes
 *     a real 302, which is the whole reason this is a guard and not a
 *     `redirectTo`.
 *   - 403/404 → `true`, so the URL the visitor typed stays intact and the route's
 *     own `NotFound` renders (the AECI-62 "no pinned-404 trap" rule), with the
 *     404 status + noindex head the guard sets.
 *   - 401 → `/auth/login?return=/vendor`. NOT the not-found branch: the caller is
 *     not authenticated, and `RESPONSE_INIT.status` must stay untouched because
 *     `@angular/ssr` feeds it into a redirect-response builder that rejects any
 *     non-3xx code.
 *   - 5xx → rethrow. An outage must never launder into a not-found.
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID, REQUEST, REQUEST_CONTEXT, RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRouteSnapshot,
  Router,
  RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { AuthService } from '../auth/auth.service';
import { MetaService } from '../core/meta.service';

import { vendorHomeRedirectGuard } from './vendor-home-redirect.guard';

const API_PATH = '/api/vendor/me';
const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = { url: '/vendor' } as RouterStateSnapshot;

/** Only `vendor.slug` is read, so the rest of the payload stays out of the way. */
const ME = { vendor: { slug: 'summit-bim' } } as VendorMeResponse;

/** Macrotask boundary — drains the session probe so the retry request is in
 *  flight before the next `expectOne`. */
function settleProbe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function buildClient(request: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

function apiError(status: number, code = 'FORBIDDEN'): ServerApiError {
  return new ServerApiError({ status, code, message: `${status}` });
}

/**
 * The `AuthService` seam the 401 branch probes. `signedIn` models what
 * `getSession()` reports AFTER it has tried to refresh the cookie.
 */
function authStub(signedIn: boolean): Partial<AuthService> {
  return {
    sessionSnapshot: vi.fn(async () => ({
      signedIn,
      email: null,
      userId: null,
      avatarUrl: null,
      fullName: null,
    })),
  };
}

function setup(opts: {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  meta?: Partial<MetaService>;
  signedIn?: boolean;
}): {
  run: () => Promise<UrlTree | true>;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: new Request('https://example.test/vendor') },
      { provide: MetaService, useValue: opts.meta ?? { setNotFoundMeta: vi.fn() } },
      { provide: AuthService, useValue: authStub(opts.signedIn ?? false) },
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  return {
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(() => vendorHomeRedirectGuard(ROUTE, STATE)) as Promise<
        UrlTree | true
      >,
  };
}

/** Serialize a returned `UrlTree` for assertion. */
function urlOf(result: UrlTree | true): string {
  expect(result).toBeInstanceOf(UrlTree);
  return TestBed.inject(Router).serializeUrl(result as UrlTree);
}

describe('vendorHomeRedirectGuard — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('redirects a vendor to its own slugged overview (200)', async () => {
    const ctx = createRequestContext(buildClient(async () => ME));
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(urlOf(await run())).toBe('/vendor/summit-bim/overview');
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });

  it('leaves the URL intact and marks 404 for a 403 (reviewer / banned / admin)', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw apiError(403);
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

    expect(await run()).toBe(true);
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://example.test/vendor',
    });
  });

  // AECI-954 — the branch this issue split off from the one above.
  it('redirects a 401 to login instead of marking 404', async () => {
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

    expect(urlOf(await run())).toBe('/auth/login?return=%2Fvendor');
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });

  it('rethrows a 5xx (never fakes a 404 on an outage)', async () => {
    const err = apiError(500, 'INTERNAL_ERROR');
    const ctx = createRequestContext(
      buildClient(async () => {
        throw err;
      }),
    );
    const responseInit = { status: 200 };
    const { run } = setup({ platform: 'server', ctx, responseInit });

    await expect(run()).rejects.toBe(err);
    expect(responseInit.status).toBe(200);
  });

  it('marks 404 when REQUEST_CONTEXT is missing (nothing to authorize with)', async () => {
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();
    const { run } = setup({
      platform: 'server',
      ctx: null,
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toBe(true);
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalled();
  });
});

/**
 * The client branch. Same three answers, but a 401 is probed first: only the
 * browser can trade an expired access token for a fresh one, and a session that
 * survives the trade earns one retry. A retry that 401s again is
 * authenticated-but-unauthorizable, so it takes the not-found branch — which is
 * what stops the login bounce looping.
 */
describe('vendorHomeRedirectGuard — client path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const flush401 = (httpMock: HttpTestingController): void =>
    httpMock
      .expectOne(API_PATH)
      .flush(
        { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        { status: 401, statusText: 'Unauthorized' },
      );

  it('redirects a vendor to its own slugged overview (200)', async () => {
    const { run, httpMock } = setup({ platform: 'browser' });

    const promise = run();
    httpMock.expectOne(API_PATH).flush(ME);

    expect(urlOf(await promise)).toBe('/vendor/summit-bim/overview');
  });

  it('renders not-found for a 403 without probing the session', async () => {
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

    expect(await promise).toBe(true);
    expect(TestBed.inject(AuthService).sessionSnapshot).not.toHaveBeenCalled();
    expect(setNotFoundMeta).toHaveBeenCalled();
  });

  it('retries once and succeeds when the session refresh lands', async () => {
    const { run, httpMock } = setup({ platform: 'browser', signedIn: true });

    const promise = run();
    flush401(httpMock);
    await settleProbe();
    httpMock.expectOne(API_PATH).flush(ME);

    expect(urlOf(await promise)).toBe('/vendor/summit-bim/overview');
  });

  it('redirects to login when the refresh finds no session', async () => {
    const { run, httpMock } = setup({ platform: 'browser', signedIn: false });

    const promise = run();
    flush401(httpMock);

    expect(urlOf(await promise)).toBe('/auth/login?return=%2Fvendor');
    httpMock.verify();
  });

  it('renders not-found (never a second bounce) when the retry 401s again', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      signedIn: true,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    flush401(httpMock);
    await settleProbe();
    flush401(httpMock);

    expect(await promise).toBe(true);
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
