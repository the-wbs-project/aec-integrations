/**
 * Resolver test. Named `.component.spec.ts` so it runs under `ng test` — needs
 * Angular's `inject()` / `TestBed` for the resolver's DI surface.
 */
import { PLATFORM_ID, REQUEST, REQUEST_CONTEXT, TransferState, makeStateKey } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CategoriesListResponse } from '@aeci/shared';

import { type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { categoriesIndexResolver } from './categories-index.resolver';

function buildList(): CategoriesListResponse {
  return {
    data: [
      {
        id: '00000000-0000-4000-8000-000000030001',
        slug: 'project-management',
        name: 'Project Management',
        description: 'Coordinate construction projects.',
        display_order: 1,
        product_count: 12,
      },
    ],
  };
}

function buildClient(request: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(request) as ServerApiClient['request'] };
}

const ROUTE = {} as ActivatedRouteSnapshot;
const STATE = {} as RouterStateSnapshot;

function setup(opts: {
  platform: 'server' | 'browser';
  ctx?: AeciRequestContext | null;
  meta?: Partial<MetaService>;
}): { run: () => Promise<CategoriesListResponse | null>; transferState: TransferState } {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      // canonicalUrl() reads REQUEST to build the self-referential canonical (ADR 0011);
      // an apex-origin request keeps the canonical assertion below at the apex.
      { provide: REQUEST, useValue: new Request('https://aecintegrations.com/categories') },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
    ],
  });

  return {
    transferState: TestBed.inject(TransferState),
    run: () =>
      TestBed.runInInjectionContext(() =>
        categoriesIndexResolver(ROUTE, STATE),
      ) as Promise<CategoriesListResponse | null>,
  };
}

describe('categoriesIndexResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('fetches the list, sets index meta, and stores in TransferState', async () => {
    const list = buildList();
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => list));

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      meta: { setEntityMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toEqual(list);
    expect(ctx.api.request).toHaveBeenCalledWith('/api/categories');
    expect(setEntityMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: 'index',
        name: 'Categories',
        canonical: 'https://aecintegrations.com/categories',
      }),
    );
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.categories-index']).toEqual(list);
  });

  it('falls back to null when REQUEST_CONTEXT is missing', async () => {
    const { run, transferState } = setup({
      platform: 'server',
      ctx: null,
      meta: {} as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.categories-index']).toBeNull();
  });
});

describe('categoriesIndexResolver — client (hydration) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads from TransferState without calling the API or mutating meta', async () => {
    const list = buildList();
    const apiRequest = vi.fn();
    const setEntityMeta = vi.fn();

    const { run, transferState } = setup({
      platform: 'browser',
      ctx: createRequestContext({ request: apiRequest } as unknown as ServerApiClient),
      meta: { setEntityMeta } as Partial<MetaService>,
    });
    transferState.set(makeStateKey<CategoriesListResponse | null>('aeci.categories-index'), list);

    const result = await run();

    expect(result).toEqual(list);
    expect(apiRequest).not.toHaveBeenCalled();
    expect(setEntityMeta).not.toHaveBeenCalled();
  });
});
