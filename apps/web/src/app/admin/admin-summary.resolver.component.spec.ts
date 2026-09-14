/**
 * Resolver test for `adminSummaryResolver` (AECI-203 / Phase 5.12). Named
 * `.component.spec.ts` so it runs under `ng test` — the resolver's `inject()`
 * surface needs Angular's `TestBed`. Mirrors `create-detail-resolver.component.
 * spec.ts`: a fake `ServerApiClient` drives the server path, `HttpTesting
 * Controller` the client path, and `MetaService` / `RESPONSE_INIT` are stubs.
 *
 * The load-bearing contract: a 403 from `GET /api/admin/summary` becomes a 404
 * render (don't reveal the admin surface), a 200 yields the summary + a
 * TransferState handoff, and a 5xx rethrows (never a fake 404).
 *
 * AECI-954 splits 401 out of that first branch. It is not an authorization
 * answer — it means nobody is signed in — so it redirects to
 * `/auth/login?return=<url>` instead of dead-ending an operator whose access
 * token aged out. The client branch refreshes the cookie before deciding, which
 * is also what keeps a permanently-401 identity from looping through login; the
 * "AECI-954" block below pins all four outcomes.
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
import {
  ActivatedRouteSnapshot,
  RedirectCommand,
  Router,
  RouterStateSnapshot,
  provideRouter,
} from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSummaryResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { AuthService } from '../auth/auth.service';
import { MetaService } from '../core/meta.service';

import { adminSummaryResolver } from './admin-summary.resolver';

const API_PATH = '/api/admin/summary';
const STATE_KEY = 'aeci.admin-summary';
const SUMMARY: AdminSummaryResponse = {
  pending_reviews: 5,
  pending_requests: 2,
  pending_claims: 1,
  pending_reindex: 2,
};

const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = { url: '/admin/reviews' } as RouterStateSnapshot;

/**
 * The `AuthService` seam the 401 branch probes. `signedIn` models what
 * `getSession()` reports AFTER it has tried to refresh the cookie: `true` = the
 * session was recoverable, `false` = it is genuinely gone.
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

/** The login URL a redirect carries, for assertion against the router. */
function redirectPath(result: unknown): string {
  expect(result).toBeInstanceOf(RedirectCommand);
  return TestBed.inject(Router).serializeUrl((result as RedirectCommand).redirectTo);
}

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
  /** Whether the post-401 session probe finds a session. Default: it does not. */
  signedIn?: boolean;
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
      { provide: AuthService, useValue: authStub(opts.signedIn ?? false) },
      provideRouter([]),
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

  // AECI-954 — a 401 is "nobody is signed in", not "you are not an admin", and
  // gets the login page rather than the 404 render. The status stays untouched:
  // `@angular/ssr` feeds `RESPONSE_INIT.status` into its redirect-response
  // builder, which rejects anything outside 301/302/303/307/308.
  it('redirects a 401 (expired/no session) to login, carrying the return path', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw apiError(401, 'UNAUTHENTICATED');
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

    expect(redirectPath(await run())).toBe('/auth/login?return=%2Fadmin%2Freviews');
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
    // Nothing hands off either: this response is a 302 and renders no page.
    expect(JSON.parse(transferState.toJson())[STATE_KEY]).toBeUndefined();
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

/**
 * AECI-954 — the client 401 branch. The browser is the only place that can trade
 * an expired access token for a fresh one (`@supabase/ssr` does it inside
 * `getSession()`), so a 401 is probed before it is acted on. Three outcomes:
 * a session that comes back earns one retry; a session that does not goes to
 * login; a retry that 401s again is authenticated-but-unauthorizable and renders
 * not-found, which is what keeps the bounce from looping.
 */
/** Macrotask boundary — drains the session probe so the retry request is in
 *  flight before the next `expectOne`. */
function settleProbe(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('adminSummaryResolver — the AECI-954 401 branch (client)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const flush401 = (httpMock: HttpTestingController): void =>
    httpMock
      .expectOne(API_PATH)
      .flush(
        { error: { code: 'UNAUTHENTICATED', message: 'no' } },
        { status: 401, statusText: 'Unauthorized' },
      );

  it('retries once and succeeds when the session refresh lands', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      signedIn: true,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    flush401(httpMock);
    await settleProbe();
    httpMock.expectOne(API_PATH).flush(SUMMARY);

    expect(await promise).toEqual(SUMMARY);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });

  it('redirects to login when the refresh finds no session', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      signedIn: false,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    flush401(httpMock);

    expect(redirectPath(await promise)).toBe('/auth/login?return=%2Fadmin%2Freviews');
    expect(setNotFoundMeta).not.toHaveBeenCalled();
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

    expect(await promise).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalled();
  });
});
