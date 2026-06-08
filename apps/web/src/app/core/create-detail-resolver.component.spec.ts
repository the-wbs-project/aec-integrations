/**
 * Factory test for `createDetailResolver`. Named `.component.spec.ts` so it
 * runs under `ng test` (Angular's vitest unit-test runner) — needs Angular's
 * `inject()` / `TestBed` to exercise the resolver's DI surface. Plain
 * `*.spec.ts` is Vitest-only and excludes Angular per `apps/web/vitest.config.ts`.
 *
 * These tests cover the SHARED scaffold (hydration read, client-fetch on a
 * TransferState miss, null-ctx bail, NOT_FOUND→404, success → applyMeta +
 * pushEmbedded + pageView, origin fallback, param wiring, non-404 rethrow) with
 * a synthetic entity + stub config. The entity-specific behavior of each real
 * resolver is covered by `product-detail.resolver.component.spec.ts`,
 * `vendor-detail.resolver.component.spec.ts`, and
 * `integration-detail.resolver.component.spec.ts`, which drive the composed
 * resolvers end-to-end via `detail-resolver.harness.ts`.
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
import { ActivatedRouteSnapshot, RouterStateSnapshot, convertToParamMap } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';

import { createDetailResolver, type DetailResolverConfig } from './create-detail-resolver';
import { MetaService } from './meta.service';

interface TestEntity {
  id: string;
  label: string;
}

const ENTITY: TestEntity = { id: 'entity-1', label: 'Widget' };
const API_PATH = '/api/tests/widget';

function buildConfig(
  overrides: Partial<DetailResolverConfig<TestEntity>> = {},
): DetailResolverConfig<TestEntity> {
  return {
    statePrefix: 'aeci.test-detail:',
    paramName: 'slug',
    pathSegment: 'tests',
    entityKind: 'product',
    fetch: vi.fn(async () => ENTITY),
    applyMeta: vi.fn(),
    pushEmbedded: vi.fn(),
    ...overrides,
  };
}

function buildClient(): ServerApiClient {
  return { request: vi.fn() as ServerApiClient['request'] };
}

const STATE = {} as RouterStateSnapshot;

function setup(opts: {
  platform: 'server' | 'browser';
  config: DetailResolverConfig<TestEntity>;
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  request?: Request | null;
  meta?: Partial<MetaService>;
  param?: string;
}): {
  run: () => Promise<TestEntity | null>;
  transferState: TransferState;
  httpMock: HttpTestingController;
} {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: opts.request ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  const resolver = createDetailResolver(opts.config);
  const route = {
    paramMap: convertToParamMap({ [opts.config.paramName]: opts.param ?? 'widget' }),
  } as unknown as ActivatedRouteSnapshot;

  return {
    transferState: TestBed.inject(TransferState),
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(() => resolver(route, STATE)) as Promise<TestEntity | null>,
  };
}

describe('createDetailResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches the entity, runs applyMeta + pushEmbedded, sets pageView, and stores in TransferState on success', async () => {
    const meta = {} as Partial<MetaService>;
    const config = buildConfig();
    const ctx = createRequestContext(buildClient());
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      config,
      ctx,
      responseInit,
      request: new Request('https://example.test/tests/widget'),
      meta,
    });

    const result = await run();

    expect(result).toEqual(ENTITY);
    expect(responseInit.status).toBe(200); // unchanged
    // fetch receives the request client and the raw (un-encoded) param.
    expect(config.fetch).toHaveBeenCalledWith(ctx.api, 'widget');
    // applyMeta receives the injected MetaService, the entity, and the computed
    // canonical; pushEmbedded receives the ctx + entity.
    expect(config.applyMeta).toHaveBeenCalledWith(
      meta,
      ENTITY,
      'https://example.test/tests/widget',
    );
    expect(config.pushEmbedded).toHaveBeenCalledWith(ctx, ENTITY);
    expect(ctx.pageView).toEqual({
      route: '/tests/:slug',
      entity_type: 'product',
      entity_id: 'entity-1',
    });
    // TransferState carries the entity so hydration skips the fetch.
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.test-detail:widget']).toEqual(ENTITY);
  });

  it('falls back to the serving origin (DOM location) when REQUEST is absent', async () => {
    const config = buildConfig();
    const ctx = createRequestContext(buildClient());

    const { run } = setup({
      platform: 'server',
      config,
      ctx,
      responseInit: { status: 200 },
      request: null,
      meta: {},
    });

    await run();

    // No REQUEST → `canonicalUrl()` uses the DOM `location.origin` so a canonical rebuilt
    // without a request still self-references the serving host (ADR 0011).
    expect(config.applyMeta).toHaveBeenCalledWith(
      expect.anything(),
      ENTITY,
      `${document.location.origin}/tests/widget`,
    );
  });

  it('reads the configured param name and composes the state key / route from it', async () => {
    const config = buildConfig({ paramName: 'id' });
    const ctx = createRequestContext(buildClient());

    const { run, transferState } = setup({
      platform: 'server',
      config,
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://example.test/tests/abc-123'),
      meta: {},
      param: 'abc-123',
    });

    await run();

    expect(config.fetch).toHaveBeenCalledWith(ctx.api, 'abc-123');
    expect(ctx.pageView).toEqual({
      route: '/tests/:id',
      entity_type: 'product',
      entity_id: 'entity-1',
    });
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.test-detail:abc-123']).toEqual(ENTITY);
  });

  it('returns null on NOT_FOUND, sets status 404 + noindex meta, skips applyMeta/pushEmbedded and pageView', async () => {
    const setNotFoundMeta = vi.fn();
    const config = buildConfig({ fetch: vi.fn(async () => null) });
    const ctx = createRequestContext(buildClient());
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      config,
      ctx,
      responseInit,
      request: new Request('https://example.test/tests/widget'),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'product',
      slug: 'widget',
      canonical: 'https://example.test/tests/widget',
    });
    expect(config.applyMeta).not.toHaveBeenCalled();
    expect(config.pushEmbedded).not.toHaveBeenCalled();
    expect(ctx.pageView).toBeNull();
    expect(ctx.embedded).toEqual([]);
    // TransferState carries null so hydration is consistent.
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.test-detail:widget']).toBeNull();
  });

  it('rethrows non-404 errors (does not swallow a thrown fetch)', async () => {
    const err = new Error('database unreachable');
    const config = buildConfig({
      fetch: vi.fn(async () => {
        throw err;
      }),
    });
    const ctx = createRequestContext(buildClient());

    const { run } = setup({
      platform: 'server',
      config,
      ctx,
      responseInit: { status: 200 },
      request: new Request('https://example.test/tests/widget'),
      meta: {},
    });

    await expect(run()).rejects.toBe(err);
    expect(config.applyMeta).not.toHaveBeenCalled();
    expect(config.pushEmbedded).not.toHaveBeenCalled();
  });

  it('falls back gracefully when REQUEST_CONTEXT is null (defensive — non-Server render mode)', async () => {
    const config = buildConfig();

    const { run, transferState } = setup({
      platform: 'server',
      config,
      ctx: null,
      responseInit: { status: 200 },
      request: new Request('https://example.test/tests/widget'),
      meta: {},
    });

    const result = await run();

    expect(result).toBeNull();
    // No fetch, no side-effects — the scaffold bails before touching the API.
    expect(config.fetch).not.toHaveBeenCalled();
    expect(config.applyMeta).not.toHaveBeenCalled();
    expect(config.pushEmbedded).not.toHaveBeenCalled();
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.test-detail:widget']).toBeNull();
  });
});

describe('createDetailResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState on hydration (no fetch) and re-applies meta', async () => {
    const config = buildConfig();
    const meta = {} as Partial<MetaService>;

    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      config,
      // Browser context: REQUEST_CONTEXT is normally absent. We still pass one so
      // a leaked service-binding fetch would surface on the spy.
      ctx: createRequestContext(buildClient()),
      request: new Request('https://example.test/tests/widget'),
      meta,
    });
    transferState.set(makeStateKey<TestEntity | null>('aeci.test-detail:widget'), ENTITY);

    const result = await run();

    expect(result).toEqual(ENTITY);
    expect(config.fetch).not.toHaveBeenCalled();
    httpMock.expectNone(API_PATH);
    expect(config.applyMeta).toHaveBeenCalledWith(
      meta,
      ENTITY,
      'https://example.test/tests/widget',
    );
  });

  it('fetches via the browser /api/* passthrough on a TransferState miss and applies meta', async () => {
    const config = buildConfig();
    const meta = {} as Partial<MetaService>;

    const { run, httpMock } = setup({
      platform: 'browser',
      config,
      ctx: createRequestContext(buildClient()),
      request: new Request('https://example.test/tests/widget'),
      meta,
    });

    const promise = run();
    const req = httpMock.expectOne(API_PATH);
    expect(req.request.method).toBe('GET');
    req.flush(ENTITY);
    const result = await promise;

    expect(result).toEqual(ENTITY);
    // The browser path must NOT use the server-only service-binding fetch.
    expect(config.fetch).not.toHaveBeenCalled();
    expect(config.applyMeta).toHaveBeenCalledWith(
      meta,
      ENTITY,
      'https://example.test/tests/widget',
    );
  });

  it('renders not-found (setNotFoundMeta, null) on a NOT_FOUND client fetch', async () => {
    const setNotFoundMeta = vi.fn();
    const config = buildConfig();

    const { run, httpMock } = setup({
      platform: 'browser',
      config,
      ctx: createRequestContext(buildClient()),
      request: new Request('https://example.test/tests/widget'),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    httpMock
      .expectOne(API_PATH)
      .flush(
        { error: { code: 'NOT_FOUND', message: 'missing' } },
        { status: 404, statusText: 'Not Found' },
      );
    const result = await promise;

    expect(result).toBeNull();
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'product',
      slug: 'widget',
      canonical: 'https://example.test/tests/widget',
    });
    expect(config.applyMeta).not.toHaveBeenCalled();
  });

  it('rethrows a non-404 error from the client fetch', async () => {
    const config = buildConfig();

    const { run, httpMock } = setup({
      platform: 'browser',
      config,
      ctx: createRequestContext(buildClient()),
      request: new Request('https://example.test/tests/widget'),
      meta: {},
    });

    const promise = run();
    httpMock
      .expectOne(API_PATH)
      .flush(
        { error: { code: 'INTERNAL_ERROR', message: 'down' } },
        { status: 500, statusText: 'Server Error' },
      );

    await expect(promise).rejects.toBeTruthy();
    expect(config.applyMeta).not.toHaveBeenCalled();
  });
});
