/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test`
 * (Angular's vitest unit-test runner) — needs Angular's `inject()` /
 * `TestBed` to exercise the resolver's DI surface.
 */
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

import type { IntegrationDetail } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { integrationDetailResolver } from './integration-detail.resolver';

const ID = '00000000-0000-4000-8000-000000030001';

function buildIntegration(overrides: Partial<IntegrationDetail> = {}): IntegrationDetail {
  return {
    id: ID,
    name: 'Revit → Navisworks',
    mechanism_kind: 'native',
    mechanism_name: 'Autodesk Desktop Connector',
    direction: 'bidirectional',
    source: {
      id: '00000000-0000-4000-8000-000000020001',
      slug: 'revit',
      name: 'Revit',
      logo_url: null,
    },
    target: {
      id: '00000000-0000-4000-8000-000000020002',
      slug: 'navisworks',
      name: 'Navisworks',
      logo_url: null,
    },
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Sync models between Revit and Navisworks.',
    listing_url: 'https://apps.autodesk.com/listing',
    docs_url: 'https://help.autodesk.com',
    mechanism_url: null,
    built_by_vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'autodesk',
      name: 'Autodesk',
      logo_url: null,
    },
    powered_by_product: {
      id: '00000000-0000-4000-8000-000000020003',
      slug: 'forge',
      name: 'Autodesk Platform Services',
      logo_url: null,
    },
    pricing_model: 'Included',
    maturity: 'GA',
    ...overrides,
  };
}

function buildClient(
  request: (path: string, init?: RequestInit) => Promise<unknown>,
): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

function buildRouteSnapshot(id: string): ActivatedRouteSnapshot {
  return { paramMap: convertToParamMap({ id }) } as unknown as ActivatedRouteSnapshot;
}

const STATE = {} as RouterStateSnapshot;

function setup(opts: {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  request?: Request | null;
  meta?: Partial<MetaService>;
}): { run: () => Promise<IntegrationDetail | null>; transferState: TransferState } {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: opts.request ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
    ],
  });

  return {
    transferState: TestBed.inject(TransferState),
    run: () =>
      TestBed.runInInjectionContext(() =>
        integrationDetailResolver(buildRouteSnapshot(ID), STATE),
      ) as Promise<IntegrationDetail | null>,
  };
}

describe('integrationDetailResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches the integration, sets meta (no JSON-LD), populates ctx, and stores in TransferState on success', async () => {
    const integration = buildIntegration();
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => integration));
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request(`https://aecintegrations.com/integrations/${ID}`),
      meta: { setEntityMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toEqual(integration);
    expect(responseInit.status).toBe(200);
    // Headline built from source/target names per Phase 2 Spec §6.5.
    expect(setEntityMeta).toHaveBeenCalledWith({
      entity: 'integration',
      name: 'Revit → Navisworks',
      description: 'Sync models between Revit and Navisworks.',
      canonical: `https://aecintegrations.com/integrations/${ID}`,
      ogImage: undefined,
    });

    // Embedded tags: both products, the built-by vendor, and the powered-by
    // connector product. (Path matcher emits integration:{id} + route:detail.)
    expect(ctx.embedded).toEqual([
      { type: 'product', slug: 'revit' },
      { type: 'product', slug: 'navisworks' },
      { type: 'vendor', slug: 'autodesk' },
      { type: 'product', slug: 'forge' },
    ]);

    expect(ctx.pageView).toEqual({
      route: '/integrations/:id',
      entity_type: 'integration',
      entity_id: ID,
    });

    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys[`aeci.integration-detail:${ID}`]).toEqual(integration);
  });

  it('omits absent built-by / powered-by from the embedded tags', async () => {
    const integration = buildIntegration({ built_by_vendor: null, powered_by_product: null });
    const ctx = createRequestContext(buildClient(async () => integration));

    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit: { status: 200 },
      request: new Request(`https://aecintegrations.com/integrations/${ID}`),
      meta: { setEntityMeta: vi.fn() } as Partial<MetaService>,
    });

    await run();

    expect(ctx.embedded).toEqual([
      { type: 'product', slug: 'revit' },
      { type: 'product', slug: 'navisworks' },
    ]);
  });

  it('returns null on NOT_FOUND, sets RESPONSE_INIT.status=404, sets noindex meta, no pageView', async () => {
    const setNotFoundMeta = vi.fn();
    const setEntityMeta = vi.fn();
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
      request: new Request(`https://aecintegrations.com/integrations/${ID}`),
      meta: { setNotFoundMeta, setEntityMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'integration',
      slug: ID,
      canonical: `https://aecintegrations.com/integrations/${ID}`,
    });
    expect(setEntityMeta).not.toHaveBeenCalled();
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
      request: new Request(`https://aecintegrations.com/integrations/${ID}`),
      meta: {} as Partial<MetaService>,
    });

    await expect(run()).rejects.toBe(err);
  });

  it('falls back gracefully when REQUEST_CONTEXT is null (defensive — non-Server render mode)', async () => {
    const { run, transferState } = setup({
      platform: 'server',
      ctx: null,
      responseInit: { status: 200 },
      request: new Request(`https://aecintegrations.com/integrations/${ID}`),
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys[`aeci.integration-detail:${ID}`]).toBeNull();
  });
});

describe('integrationDetailResolver — client (hydration) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState and does not call the API or mutate meta/ctx', async () => {
    const integration = buildIntegration();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: { setEntityMeta } as Partial<MetaService>,
    });
    transferState.set(
      makeStateKey<IntegrationDetail | null>(`aeci.integration-detail:${ID}`),
      integration,
    );

    const result = await run();

    expect(result).toEqual(integration);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(setEntityMeta).not.toHaveBeenCalled();
  });

  it('returns null on TransferState miss (no SSR snapshot for this id)', async () => {
    const apiRequest = vi.fn();
    const { run } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(apiRequest).not.toHaveBeenCalled();
  });
});
