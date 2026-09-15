/**
 * Shared table-driven harness for the product / vendor / integration
 * detail-resolver specs (AECI-113). The three resolvers share an identical
 * TestBed setup, a mock `ServerApiClient`, and the same six behavioural cases
 * (server success / 404 / 5xx / null-context, plus hydration read + miss);
 * they differ only by entity type, route param (`slug` vs `id`), JSON-LD
 * setter, embedded cache tags, and meta payload. That variation is captured by
 * a `DetailResolverScenario` literal in each thin spec file; the shared cases
 * live here once.
 *
 * This file is a test helper, not a spec — it is named `*.harness.ts` so no
 * runner collects it directly (it executes only when a `*.component.spec.ts`
 * imports it) and so the app build excludes it (see `tsconfig.app.json`).
 * Entity-specific cases (e.g. product's "no vendor" tag, integration's absent
 * built-by/powered-by) stay in their thin spec, using the exported
 * `createSetup` + `buildClient`.
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
  type ResolveFn,
  Router,
  RouterStateSnapshot,
  convertToParamMap,
} from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PageViewPayload } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../../server-api-client';
import type { CacheTagEntity } from '../../../server/cache-tags';
import { createRequestContext, type AeciRequestContext } from '../../../server/request-context';
import { MetaService } from '../meta.service';
import type { EntityKind, SetEntityMetaInput } from '../meta.service';

/** Mock `ServerApiClient` whose `request` is a spy over the supplied impl. */
export function buildClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

function buildRouteSnapshot(paramKey: 'slug' | 'id', paramValue: string): ActivatedRouteSnapshot {
  return {
    paramMap: convertToParamMap({ [paramKey]: paramValue }),
  } as unknown as ActivatedRouteSnapshot;
}

const STATE = {} as RouterStateSnapshot;

/** Drain the microtask queue so a resolver's NEXT await-chained request is issued.
 *  `await Promise.resolve()` is not enough: `httpGetOrNull` awaits `firstValueFrom`
 *  inside a try/catch, which is several microtasks deep. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export interface DetailResolverSetupOpts {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number; headers?: HeadersInit };
  request?: Request | null;
  meta?: Partial<MetaService>;
  /**
   * Stub `Router`, for the AECI-978 client-side retired-slug redirect. Omitted by
   * default ON PURPOSE: the resolver injects `Router` as `optional` and skips the
   * redirect without one, so every pre-existing case keeps exercising the plain
   * not-found path with no router in the TestBed.
   */
  router?: Pick<Router, 'navigateByUrl'>;
}

export interface DetailResolverHarness<T> {
  run: () => Promise<T | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
}

/**
 * Builds the per-test `setup()` bound to one resolver + route param. Exported
 * so a thin spec's entity-specific cases can drive the same plumbing.
 */
export function createSetup<T>(
  resolver: ResolveFn<T | null>,
  paramKey: 'slug' | 'id',
  paramValue: string,
): (opts: DetailResolverSetupOpts) => DetailResolverHarness<T> {
  return (opts) => {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
        { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
        { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
        { provide: REQUEST, useValue: opts.request ?? null },
        { provide: MetaService, useValue: opts.meta ?? {} },
        ...(opts.router ? [{ provide: Router, useValue: opts.router }] : []),
        // The client (in-app navigation) branch fetches via HttpClient against
        // the same-origin `/api/*` passthrough (AECI-151); mock it.
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });

    return {
      transferState: TestBed.inject(TransferState),
      httpMock: TestBed.inject(HttpTestingController),
      run: () =>
        TestBed.runInInjectionContext(() =>
          resolver(buildRouteSnapshot(paramKey, paramValue), STATE),
        ) as Promise<T | null>,
    };
  };
}

export interface DetailResolverScenario<T> {
  /** Resolver describe-block name, e.g. `productDetailResolver`. */
  name: string;
  resolver: ResolveFn<T | null>;
  paramKey: 'slug' | 'id';
  paramValue: string;
  /** Full request URL the resolver reads for canonical/og construction. */
  url: string;
  /** Same-origin path the client (in-app nav) branch fetches on a TransferState
   *  miss, e.g. `/api/products/procore`. */
  apiPath: string;
  /** TransferState key the resolver writes, e.g. `aeci.product-detail:procore`. */
  stateKey: string;
  /** Hydrated success fixture (with the relations the resolver tags as embedded). */
  buildFixture: () => T;
  /** Expected argument to `setEntityMeta` on the success path. */
  expectedMeta: SetEntityMetaInput;
  /** JSON-LD setter the resolver calls on success, or `null` (integration). */
  jsonLdMethod: 'setProductJsonLd' | 'setVendorJsonLd' | null;
  expectedEmbedded: CacheTagEntity[];
  expectedPageView: PageViewPayload;
  /** Expected argument to `setNotFoundMeta` on the 404 path. */
  notFound: { kind: EntityKind; slug: string; canonical: string };
  /**
   * Set when the resolver opts in to the retired-slug 301 (AECI-978). Absent for a
   * route that reuses this scaffold without being the entity's canonical page.
   */
  slugRedirect?: {
    /** The `slug_redirects` entity kind the resolver looks the param up under. */
    entity: 'product' | 'vendor';
    /** URL/API path segment, e.g. `products` — what the `Location` is built on. */
    pathSegment: string;
  };
}

/** Assign a `vi.fn()` jsonLd spy onto a meta stub by method name, if any. */
function withJsonLd(
  meta: Partial<MetaService>,
  method: DetailResolverScenario<unknown>['jsonLdMethod'],
): ReturnType<typeof vi.fn> | undefined {
  if (!method) return undefined;
  const spy = vi.fn();
  (meta as Record<string, unknown>)[method] = spy;
  return spy;
}

/**
 * Registers the six behavioural cases shared by every detail resolver. Call
 * once per entity from its thin spec; add entity-specific cases separately.
 */
export function registerDetailResolverSuite<T>(scenario: DetailResolverScenario<T>): void {
  const setup = createSetup<T>(scenario.resolver, scenario.paramKey, scenario.paramValue);

  describe(`${scenario.name}: server path`, () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('fetches the entity, sets meta, populates ctx, and stores in TransferState on success', async () => {
      const fixture = scenario.buildFixture();
      const setEntityMeta = vi.fn();
      const meta: Partial<MetaService> = { setEntityMeta };
      const jsonLd = withJsonLd(meta, scenario.jsonLdMethod);
      const ctx = createRequestContext(buildClient(async () => fixture));
      const responseInit = { status: 200 };

      const { run, transferState } = setup({
        platform: 'server',
        ctx,
        responseInit,
        request: new Request(scenario.url),
        meta,
      });

      const result = await run();

      expect(result).toEqual(fixture);
      expect(responseInit.status).toBe(200); // unchanged
      expect(setEntityMeta).toHaveBeenCalledWith(scenario.expectedMeta);
      // First argument only: the setters have entity-specific arities
      // (`setProductJsonLd` also takes the canonical, for its `@id` — AECI-518),
      // and the shared suite's claim is just "this resolver publishes LD for the
      // entity it fetched". Arity-specific assertions live in the entity spec.
      if (jsonLd) expect(jsonLd.mock.calls[0]?.[0]).toEqual(fixture);
      expect(ctx.embedded).toEqual(scenario.expectedEmbedded);
      expect(ctx.pageView).toEqual(scenario.expectedPageView);

      const stateKeys = JSON.parse(transferState.toJson());
      expect(stateKeys[scenario.stateKey]).toEqual(fixture);
    });

    it('returns null on NOT_FOUND, sets RESPONSE_INIT.status=404, sets noindex meta, no pageView', async () => {
      const setNotFoundMeta = vi.fn();
      const setEntityMeta = vi.fn();
      const meta: Partial<MetaService> = { setNotFoundMeta, setEntityMeta };
      const jsonLd = withJsonLd(meta, scenario.jsonLdMethod);
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
        request: new Request(scenario.url),
        meta,
      });

      const result = await run();

      expect(result).toBeNull();
      expect(responseInit.status).toBe(404);
      expect(setNotFoundMeta).toHaveBeenCalledWith(scenario.notFound);
      // Detail meta + JSON-LD must NOT run on the 404 path.
      expect(setEntityMeta).not.toHaveBeenCalled();
      if (jsonLd) expect(jsonLd).not.toHaveBeenCalled();
      // Page-view must NOT fire for 404s; embedded tags stay empty.
      expect(ctx.pageView).toBeNull();
      expect(ctx.embedded).toEqual([]);
    });

    it('rethrows non-404 errors (resolver does not swallow 5xx)', async () => {
      const err = new ServerApiError({
        status: 500,
        code: 'INTERNAL_ERROR',
        message: 'database unreachable',
      });
      const ctx = createRequestContext(
        buildClient(async () => {
          throw err;
        }),
      );

      const { run } = setup({
        platform: 'server',
        ctx,
        responseInit: { status: 200 },
        request: new Request(scenario.url),
        meta: {},
      });

      await expect(run()).rejects.toBe(err);
    });

    it('falls back gracefully when REQUEST_CONTEXT is null (defensive: non-Server render mode)', async () => {
      const { run, transferState } = setup({
        platform: 'server',
        ctx: null,
        responseInit: { status: 200 },
        request: new Request(scenario.url),
        meta: {},
      });

      const result = await run();

      expect(result).toBeNull();
      // TransferState still carries null so hydration is consistent.
      const stateKeys = JSON.parse(transferState.toJson());
      expect(stateKeys[scenario.stateKey]).toBeNull();
    });
  });

  describe(`${scenario.name}: client (in-app navigation) path`, () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('reads from TransferState on hydration (no fetch) and re-applies meta idempotently', async () => {
      const fixture = scenario.buildFixture();
      const apiRequest = vi.fn();
      const setEntityMeta = vi.fn();
      const meta: Partial<MetaService> = { setEntityMeta };
      const jsonLd = withJsonLd(meta, scenario.jsonLdMethod);

      const { run, transferState, httpMock } = setup({
        platform: 'browser',
        // Browser context: REQUEST_CONTEXT is normally absent. We pass one with a
        // stub `ServerApiClient` so any leaked service-binding call surfaces as an
        // `apiRequest` we can assert was NOT made (the client uses HttpClient).
        ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
        request: new Request(scenario.url),
        meta,
      });
      transferState.set(makeStateKey<T | null>(scenario.stateKey), fixture);

      const result = await run();

      expect(result).toEqual(fixture);
      expect(apiRequest).not.toHaveBeenCalled();
      httpMock.expectNone(scenario.apiPath); // a hydration HIT never refetches
      // Meta IS re-applied client-side now (idempotent over the SSR-rendered head).
      expect(setEntityMeta).toHaveBeenCalledWith(scenario.expectedMeta);
      // First argument only: the setters have entity-specific arities
      // (`setProductJsonLd` also takes the canonical, for its `@id` — AECI-518),
      // and the shared suite's claim is just "this resolver publishes LD for the
      // entity it fetched". Arity-specific assertions live in the entity spec.
      if (jsonLd) expect(jsonLd.mock.calls[0]?.[0]).toEqual(fixture);
    });

    it('fetches via the browser /api/* passthrough on a TransferState miss and applies meta', async () => {
      const fixture = scenario.buildFixture();
      const apiRequest = vi.fn();
      const setEntityMeta = vi.fn();
      const meta: Partial<MetaService> = { setEntityMeta };
      const jsonLd = withJsonLd(meta, scenario.jsonLdMethod);

      const { run, httpMock } = setup({
        platform: 'browser',
        ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
        request: new Request(scenario.url),
        meta,
      });

      const promise = run();
      const req = httpMock.expectOne(scenario.apiPath);
      expect(req.request.method).toBe('GET');
      req.flush(fixture as object);
      const result = await promise;

      expect(result).toEqual(fixture);
      expect(apiRequest).not.toHaveBeenCalled(); // browser path, not the service binding
      expect(setEntityMeta).toHaveBeenCalledWith(scenario.expectedMeta);
      // First argument only: the setters have entity-specific arities
      // (`setProductJsonLd` also takes the canonical, for its `@id` — AECI-518),
      // and the shared suite's claim is just "this resolver publishes LD for the
      // entity it fetched". Arity-specific assertions live in the entity spec.
      if (jsonLd) expect(jsonLd.mock.calls[0]?.[0]).toEqual(fixture);
    });

    it('renders not-found (setNotFoundMeta, null) on a NOT_FOUND client fetch', async () => {
      const setEntityMeta = vi.fn();
      const setNotFoundMeta = vi.fn();
      const meta: Partial<MetaService> = { setEntityMeta, setNotFoundMeta };
      withJsonLd(meta, scenario.jsonLdMethod);

      const { run, httpMock } = setup({
        platform: 'browser',
        ctx: createRequestContext({ request: vi.fn() } as unknown as ServerApiClient),
        request: new Request(scenario.url),
        meta,
      });

      const promise = run();
      httpMock
        .expectOne(scenario.apiPath)
        .flush(
          { error: { code: 'NOT_FOUND', message: 'missing' } },
          { status: 404, statusText: 'Not Found' },
        );
      // AECI-978 — an opted-in resolver asks the retired-slug map before it settles
      // on the not-found shell. Answer "no mapping", which is the ordinary case.
      // `Router` is `providedIn: 'root'`, so the optional inject always finds one in
      // a TestBed and this branch is never skipped.
      if (scenario.slugRedirect) {
        await settle();
        httpMock
          .expectOne(`/api/slug-redirects/${scenario.slugRedirect.entity}/${scenario.paramValue}`)
          .flush(
            { error: { code: 'NOT_FOUND', message: 'no redirect' } },
            { status: 404, statusText: 'Not Found' },
          );
      }
      const result = await promise;

      expect(result).toBeNull();
      expect(setNotFoundMeta).toHaveBeenCalledWith(scenario.notFound);
      expect(setEntityMeta).not.toHaveBeenCalled();
    });
  });

  if (scenario.slugRedirect) registerSlugRedirectSuite(scenario, setup);
}

/**
 * The AECI-978 retired-slug cases, for a resolver that opts in with
 * `followSlugRedirect` (`STAGE_3_SPEC.md` §2.6 option B).
 *
 * Split into its own function rather than folded into the six shared cases above,
 * because it is conditional: `/products/:slug/review` reuses the same scaffold and
 * deliberately does NOT opt in.
 */
function registerSlugRedirectSuite<T>(
  scenario: DetailResolverScenario<T>,
  setup: (opts: DetailResolverSetupOpts) => DetailResolverHarness<T>,
): void {
  const { entity, pathSegment } = scenario.slugRedirect!;
  const redirectPath = `/api/slug-redirects/${entity}/${scenario.paramValue}`;
  const TO_SLUG = 'the-survivor';
  const origin = new URL(scenario.url).origin;

  /** A client whose entity read 404s and whose redirect read answers `body`. */
  function clientWithRedirect(body: unknown | null): ServerApiClient {
    return buildClient(async (path: string) => {
      if (path === redirectPath) {
        if (body === null) {
          throw new ServerApiError({ status: 404, code: 'NOT_FOUND', message: 'no redirect' });
        }
        return body;
      }
      throw new ServerApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
    });
  }

  describe(`${scenario.name}: retired-slug 301 (AECI-978)`, () => {
    beforeEach(() => TestBed.resetTestingModule());

    it('301s to the surviving slug instead of 404ing, with its own Cache-Control and Cache-Tag', async () => {
      const setNotFoundMeta = vi.fn();
      const ctx = createRequestContext(
        clientWithRedirect({ entity, from_slug: scenario.paramValue, to_slug: TO_SLUG }),
      );
      const responseInit: { status: number; headers?: HeadersInit } = {
        status: 200,
        headers: new Headers(),
      };

      const { run } = setup({
        platform: 'server',
        ctx,
        responseInit,
        request: new Request(scenario.url),
        meta: { setNotFoundMeta },
      });

      expect(await run()).toBeNull();
      expect(responseInit.status).toBe(301);
      const headers = responseInit.headers as Headers;
      expect(headers.get('Location')).toBe(`${origin}/${pathSegment}/${TO_SLUG}`);
      // A mapping, not content — the same directive every other permanent redirect
      // in the app carries.
      expect(headers.get('Cache-Control')).toBe('public, max-age=3600, s-maxage=86400');
      // Tagged on the SURVIVOR: this map is mutable, so the survivor's own next
      // edit is what has to be able to purge the redirect (`CACHE_STRATEGY.md` §2).
      expect(headers.get('Cache-Tag')).toBe(`${entity}:${TO_SLUG}`);
      // Not a 404: no noindex meta, because the reader is not being shown a page.
      expect(setNotFoundMeta).not.toHaveBeenCalled();
    });

    it('still 404s an unmapped slug', async () => {
      const setNotFoundMeta = vi.fn();
      const ctx = createRequestContext(clientWithRedirect(null));
      const responseInit = { status: 200, headers: new Headers() };

      const { run } = setup({
        platform: 'server',
        ctx,
        responseInit,
        request: new Request(scenario.url),
        meta: { setNotFoundMeta },
      });

      expect(await run()).toBeNull();
      expect(responseInit.status).toBe(404);
      expect(responseInit.headers.get('Location')).toBeNull();
      expect(setNotFoundMeta).toHaveBeenCalledWith(scenario.notFound);
    });

    it('lets a LIVE row win over a mapping — the map is never consulted on a hit', async () => {
      // The property that makes a mapping safe to seed BEFORE the data op that
      // retires the row: while the row still resolves, its page renders and the
      // redirect is inert. If the lookup ever moved ahead of the entity read, this
      // is the test that fails.
      const fixture = scenario.buildFixture();
      const request = vi.fn(async (path: string) => {
        if (path === redirectPath) throw new Error('the map must not be consulted on a hit');
        return fixture;
      });
      const ctx = createRequestContext({ request } as unknown as ServerApiClient);
      const responseInit = { status: 200, headers: new Headers() };

      const { run } = setup({
        platform: 'server',
        ctx,
        responseInit,
        request: new Request(scenario.url),
        meta: {
          setEntityMeta: vi.fn(),
          ...(scenario.jsonLdMethod ? { [scenario.jsonLdMethod]: vi.fn() } : {}),
        },
      });

      expect(await run()).toEqual(fixture);
      expect(responseInit.status).toBe(200);
      expect(request).toHaveBeenCalledTimes(1);
    });

    it('replaces the URL rather than pushing it, on a client navigation', async () => {
      // A SPA nav has no HTTP status, so `replaceUrl` is the 301 equivalent: the
      // retired URL must not enter the history stack, or Back from the survivor
      // lands on it and bounces forward again.
      const navigateByUrl = vi.fn();
      const setNotFoundMeta = vi.fn();

      const { run, httpMock } = setup({
        platform: 'browser',
        ctx: createRequestContext({ request: vi.fn() } as unknown as ServerApiClient),
        request: new Request(scenario.url),
        meta: { setNotFoundMeta },
        router: { navigateByUrl } as unknown as Pick<Router, 'navigateByUrl'>,
      });

      const promise = run();
      httpMock
        .expectOne(scenario.apiPath)
        .flush(
          { error: { code: 'NOT_FOUND', message: 'missing' } },
          { status: 404, statusText: 'Not Found' },
        );
      await settle();
      httpMock
        .expectOne(redirectPath)
        .flush({ entity, from_slug: scenario.paramValue, to_slug: TO_SLUG });
      const result = await promise;

      expect(result).toBeNull();
      expect(navigateByUrl).toHaveBeenCalledWith(`/${pathSegment}/${TO_SLUG}`, {
        replaceUrl: true,
      });
      // The not-found shell must NOT also be announced — the reader is on their way
      // to a real page.
      expect(setNotFoundMeta).not.toHaveBeenCalled();
    });
  });
}
