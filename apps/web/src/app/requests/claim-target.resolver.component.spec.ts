/**
 * Resolver test for `claimProductResolver` / `claimVendorResolver` (AECI-1364).
 * Named `.component.spec.ts` so it runs under `ng test`: it needs `inject()` and
 * `TestBed` for the resolver's DI surface.
 *
 * The shared fetch/hydration plumbing is covered by
 * `create-detail-resolver.component.spec.ts`. This spec asserts what the claim
 * routes add on top: a real 404 still sets the status, and any other failure
 * resolves `null` with NO 404 on both platforms, so the form renders as
 * "Claim your company" instead of breaking SSR or cancelling the navigation.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, VendorDetail } from '@aeci/shared';

import { ServerApiError } from '../../server-api-client';
import { createRequestContext } from '../../server/request-context';
import type { MetaService } from '../core/meta.service';
import { buildClient, createSetup } from '../core/testing/detail-resolver.harness';

import { claimProductResolver, claimVendorResolver } from './claim-target.resolver';

const PRODUCT = {
  id: '00000000-0000-4000-8000-000000020001',
  slug: 'procore',
  name: 'Procore',
  vendor: { name: 'Procore Technologies' },
} as unknown as ProductDetail;

describe('claimProductResolver (AECI-1364)', () => {
  const setup = createSetup<ProductDetail>(claimProductResolver, 'slug', 'procore');
  const request = () => new Request('https://aecintegrations.com/products/procore/claim');
  beforeEach(() => TestBed.resetTestingModule());

  it('resolves the product with no page-view', async () => {
    const ctx = createRequestContext(buildClient(async () => PRODUCT));
    const responseInit = { status: 200 };
    const { run } = setup({ platform: 'server', ctx, responseInit, request: request() });

    expect(await run()).toEqual(PRODUCT);
    expect(responseInit.status).toBe(200);
    expect(ctx.pageView).toBeNull();
  });

  it('keeps the real 404 when the product is missing', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw new ServerApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
      }),
    );
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();
    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: request(),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(setNotFoundMeta).toHaveBeenCalled();
  });

  it('resolves null with NO 404 when the server read fails with a 5xx', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw new ServerApiError({ status: 503, code: 'INTERNAL', message: 'down' });
      }),
    );
    const responseInit = { status: 200 };
    const setNotFoundMeta = vi.fn();
    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: request(),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    expect(await run()).toBeNull();
    expect(responseInit.status).toBe(200);
    expect(setNotFoundMeta).not.toHaveBeenCalled();
    // Nothing stored, so hydration retries the read from the browser.
    expect(JSON.parse(transferState.toJson())['aeci.claim-product:procore']).toBeUndefined();
  });

  it('resolves null when the browser read fails with a 5xx', async () => {
    const setNotFoundMeta = vi.fn();
    const { run, httpMock } = setup({
      platform: 'browser',
      request: request(),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const promise = run();
    httpMock
      .expectOne('/api/products/procore')
      .flush(
        { error: { code: 'INTERNAL', message: 'down' } },
        { status: 500, statusText: 'Server Error' },
      );

    expect(await promise).toBeNull();
    expect(setNotFoundMeta).not.toHaveBeenCalled();
  });
});

describe('claimVendorResolver (AECI-1364)', () => {
  const setup = createSetup<VendorDetail>(claimVendorResolver, 'slug', 'acme');
  beforeEach(() => TestBed.resetTestingModule());

  it('resolves null with NO 404 when the server read fails', async () => {
    const ctx = createRequestContext(
      buildClient(async () => {
        throw new Error('timeout');
      }),
    );
    const responseInit = { status: 200 };
    const { run } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/vendors/acme/claim'),
    });

    expect(await run()).toBeNull();
    expect(responseInit.status).toBe(200);
  });

  it('resolves null when the browser read errors at the network layer', async () => {
    const { run, httpMock } = setup({
      platform: 'browser',
      request: new Request('https://aecintegrations.com/vendors/acme/claim'),
    });

    const promise = run();
    httpMock.expectOne('/api/vendors/acme').error(new ProgressEvent('error'));

    expect(await promise).toBeNull();
  });
});
