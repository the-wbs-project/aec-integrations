/**
 * Tests for the `**` wildcard route resolver (AECI-62 / Phase 2.16).
 *
 * Same `*.component.spec.ts` naming convention as
 * `product-detail.resolver.component.spec.ts` so it runs under Angular's
 * vitest config (needs `inject()` / `TestBed`).
 */
import { PLATFORM_ID, REQUEST, RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot, convertToParamMap } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MetaService } from '../core/meta.service';

import { notFoundResolver } from './not-found.resolver';

function buildRoute(): ActivatedRouteSnapshot {
  return { paramMap: convertToParamMap({}) } as unknown as ActivatedRouteSnapshot;
}

const STATE = {} as RouterStateSnapshot;

function setup(opts: {
  platform: 'server' | 'browser';
  responseInit?: { status: number };
  request?: Request | null;
  meta?: Partial<MetaService>;
}) {
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      { provide: REQUEST, useValue: opts.request ?? null },
      { provide: MetaService, useValue: opts.meta ?? {} },
    ],
  });

  return () =>
    TestBed.runInInjectionContext(() => notFoundResolver(buildRoute(), STATE)) as Promise<null>;
}

describe('notFoundResolver — server path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('sets RESPONSE_INIT.status=404 and calls setNotFoundMeta with the request URL', async () => {
    const setNotFoundMeta = vi.fn();
    const responseInit = { status: 200 };
    const run = setup({
      platform: 'server',
      responseInit,
      request: new Request('https://aecintegrations.com/never-a-real-route'),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://aecintegrations.com/never-a-real-route',
    });
  });

  it('falls back to a sane canonical when REQUEST is unavailable', async () => {
    const setNotFoundMeta = vi.fn();
    const run = setup({
      platform: 'server',
      responseInit: { status: 200 },
      request: null,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    await run();

    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://aecintegrations.com/',
    });
  });
});

describe('notFoundResolver — client (hydration) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('returns null without touching meta or response init', async () => {
    const setNotFoundMeta = vi.fn();
    const responseInit = { status: 200 };
    const run = setup({
      platform: 'browser',
      responseInit,
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });
});
