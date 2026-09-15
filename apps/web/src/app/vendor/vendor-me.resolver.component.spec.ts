/**
 * Resolver test for `vendorMeResolver` (AECI-522). Named `.component.spec.ts` so
 * it runs under `ng test` — the resolver's `inject()` surface needs Angular's
 * `TestBed`. Mirrors `admin-summary.resolver.component.spec.ts`: a fake
 * `ServerApiClient` drives the server path, `HttpTestingController` the client
 * path, and `MetaService` / `RESPONSE_INIT` are stubs.
 *
 * The load-bearing contract (the vendor-portal gate): a 403/404 from
 * `GET /api/vendor/me` becomes a 404 render (don't reveal the surface), a 200
 * yields the payload + a TransferState handoff, and a 5xx rethrows (never a fake
 * 404 on an outage).
 *
 * Since the portal moved to `/vendor/:vendorSlug/...`, a fourth branch joins
 * them: a 200 whose `vendor.slug` is not the slug in the URL takes the same
 * not-found path — see the ":vendorSlug check" block below.
 *
 * AECI-954 adds the fifth. A 401 is NOT an authorization answer — it means nobody
 * is signed in — so it bounces to `/auth/login?return=<url>` rather than
 * dead-ending an expired seat on "Page not found". On the client that decision is
 * taken only after a session-refresh probe, which is also the loop breaker; the
 * "AECI-954" block below pins every outcome.
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
  convertToParamMap,
  ActivatedRouteSnapshot,
  RedirectCommand,
  Router,
  RouterStateSnapshot,
  provideRouter,
} from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { AuthService } from '../auth/auth.service';
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
  // AECI-611 — required on the payload, and paired with `verified: true` above
  // because `vendors.verified` mirrors an ACTIVE entitlement.
  entitlement: {
    tier: 'verified',
    status: 'active',
    period_end: null,
    capabilities: ['profile.edit'],
  },
};

/** The route snapshot the resolver reads `:vendorSlug` off. `null` models the
 *  pre-AECI-522-routing shape (and any future slug-less mount): no slug in the
 *  URL means nothing to check the payload against. */
function routeFor(vendorSlug: string | null): ActivatedRouteSnapshot {
  return {
    paramMap: convertToParamMap(vendorSlug === null ? {} : { vendorSlug }),
  } as ActivatedRouteSnapshot;
}
/** The router state the login bounce reads its `?return=` path off. */
const STATE = { url: '/vendor/summit-bim/products/revit' } as RouterStateSnapshot;

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
  /** The `:vendorSlug` the URL names. Omitted = slug-less route. */
  vendorSlug?: string | null;
  /** Whether the post-401 session probe finds a session. Default: it does not. */
  signedIn?: boolean;
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
        vendorMeResolver(routeFor(opts.vendorSlug ?? null), STATE),
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

  // AECI-954 — a 401 is "nobody is signed in", not "you are not this vendor", and
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

    expect(redirectPath(await run())).toBe(
      '/auth/login?return=%2Fvendor%2Fsummit-bim%2Fproducts%2Frevit',
    );
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
});

/**
 * The `:vendorSlug` check. The URL names a vendor; the session owns exactly one.
 * When those disagree the resolver takes the SAME not-found path as an
 * unauthorized caller — rendering the session's dashboard under a URL that names
 * a different vendor is how someone edits (or cites) the wrong listing, and it is
 * the branch a future multi-vendor seat needs.
 */
describe('vendorMeResolver — the :vendorSlug check', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('returns the payload when the URL names the session\u2019s own vendor', async () => {
    const ctx = createRequestContext(buildClient(async () => ME));
    const setNotFoundMeta = vi.fn();
    const { run } = setup({
      platform: 'server',
      ctx,
      vendorSlug: ME.vendor.slug,
      responseInit: { status: 200 },
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toEqual(ME);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });

  it('404s a slug that is not the session\u2019s vendor, even on a 200 payload', async () => {
    const ctx = createRequestContext(buildClient(async () => ME));
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();
    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      vendorSlug: 'someone-else',
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toBeNull();
    expect(responseInit.status).toBe(404);
    // The 404's canonical names the path that was asked for, not a bare /vendor.
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://example.test/vendor/someone-else',
    });
    // And the payload must not ride along in TransferState — the client branch
    // would otherwise hydrate the very dashboard the server refused to render.
    expect(JSON.parse(transferState.toJson())[STATE_KEY]).toBeNull();
  });

  it('re-checks the slug against a TransferState payload on hydration', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      vendorSlug: 'someone-else',
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });
    transferState.set(makeStateKey<VendorMeResponse | null>(STATE_KEY), ME);

    expect(await run()).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
  });

  it('404s a mismatched slug on the client fetch path too', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      vendorSlug: 'someone-else',
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    httpMock.expectOne(API_PATH).flush(ME);

    expect(await promise).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalled();
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

describe('vendorMeResolver — the AECI-954 401 branch (client)', () => {
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
      vendorSlug: ME.vendor.slug,
      signedIn: true,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    flush401(httpMock);
    await settleProbe();
    httpMock.expectOne(API_PATH).flush(ME);

    expect(await promise).toEqual(ME);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });

  it('redirects to login when the refresh finds no session', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      vendorSlug: ME.vendor.slug,
      signedIn: false,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    flush401(httpMock);

    expect(redirectPath(await promise)).toBe(
      '/auth/login?return=%2Fvendor%2Fsummit-bim%2Fproducts%2Frevit',
    );
    expect(setNotFoundMeta).not.toHaveBeenCalled();
    httpMock.verify();
  });

  it('renders not-found (never a second bounce) when the retry 401s again', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      vendorSlug: ME.vendor.slug,
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

  it('never probes the session for a 403 \u2014 that caller IS signed in', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      vendorSlug: ME.vendor.slug,
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
    expect(TestBed.inject(AuthService).sessionSnapshot).not.toHaveBeenCalled();
    expect(setNotFoundMeta).toHaveBeenCalled();
  });
});
