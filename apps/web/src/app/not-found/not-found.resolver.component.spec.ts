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

// The client branch reads `state.url` to build the 404 canonical; the server
// branch ignores it (it uses the SSR `REQUEST`).
const STATE = { url: '/never-a-real-route' } as RouterStateSnapshot;

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
      canonical: 'https://www.aecintegrations.com/',
    });
  });
});

describe('notFoundResolver — client (in-app navigation) path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('sets the noindex 404 meta for the requested route without touching RESPONSE_INIT', async () => {
    const setNotFoundMeta = vi.fn();
    const responseInit = { status: 200 };
    const run = setup({
      platform: 'browser',
      responseInit,
      // canonicalUrl() reads REQUEST for the serving origin; the path comes from
      // `state.url`. Together they yield a deterministic self-referential canonical.
      request: new Request('https://aecintegrations.com/never-a-real-route'),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    // RESPONSE_INIT is server-only — a SPA nav has no HTTP status to set.
    expect(responseInit.status).toBe(200);
    // The noindex 404 meta IS now refreshed client-side (AECI-151).
    expect(setNotFoundMeta).toHaveBeenCalledWith({
      kind: 'index',
      slug: '',
      canonical: 'https://aecintegrations.com/never-a-real-route',
    });
  });
});
