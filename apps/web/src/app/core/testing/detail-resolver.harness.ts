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

export interface DetailResolverSetupOpts {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  request?: Request | null;
  meta?: Partial<MetaService>;
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
      if (jsonLd) expect(jsonLd).toHaveBeenCalledWith(fixture);
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
      if (jsonLd) expect(jsonLd).toHaveBeenCalledWith(fixture);
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
      if (jsonLd) expect(jsonLd).toHaveBeenCalledWith(fixture);
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
      const result = await promise;

      expect(result).toBeNull();
      expect(setNotFoundMeta).toHaveBeenCalledWith(scenario.notFound);
      expect(setEntityMeta).not.toHaveBeenCalled();
    });
  });
}
