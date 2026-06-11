/**
 * Resolver test for `reviewProductResolver` (AECI-200). Named
 * `.component.spec.ts` so it runs under `ng test` (Angular's vitest runner) —
 * it needs `inject()` / `TestBed` for the resolver's DI surface.
 *
 * `reviewProductResolver` is the shared detail-resolver scaffold with the
 * product-detail side effects stripped, so this spec asserts the OPT-OUTS that
 * distinguish it from `productDetailResolver`: a successful server resolve
 * returns the product but records NO page-view (the load-bearing fix — a review
 * landing must not be counted as a product view), emits no entity meta, and
 * pushes no `Cache-Tag`; a NOT_FOUND still yields a 404. The shared
 * fetch/hydration plumbing is covered by `create-detail-resolver.component.spec.ts`.
 */
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail } from '@aeci/shared';

import { ServerApiError } from '../../server-api-client';
import { createRequestContext } from '../../server/request-context';
import type { MetaService } from '../core/meta.service';
import { buildClient, createSetup } from '../core/testing/detail-resolver.harness';

import { reviewProductResolver } from './review-product.resolver';

/** Minimal product — the resolver only reads `id` (and stores the whole row). */
function buildProduct(): ProductDetail {
  return {
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
  } as unknown as ProductDetail;
}

describe('reviewProductResolver (AECI-200)', () => {
  const setup = createSetup<ProductDetail>(reviewProductResolver, 'slug', 'procore');
  beforeEach(() => TestBed.resetTestingModule());

  it('resolves the product but records NO page-view, meta, or cache tag', async () => {
    const product = buildProduct();
    const setEntityMeta = vi.fn();
    const ctx = createRequestContext(buildClient(async () => product));
    const responseInit = { status: 200 };

    const { run, transferState } = setup({
      platform: 'server',
      ctx,
      responseInit,
      request: new Request('https://aecintegrations.com/products/procore/review'),
      meta: { setEntityMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toEqual(product);
    expect(responseInit.status).toBe(200);
    // The fix: a review-form landing must NOT be counted as a product view.
    expect(ctx.pageView).toBeNull();
    // No product-detail head/SEO leakage onto this noindex form page.
    expect(setEntityMeta).not.toHaveBeenCalled();
    // Non-cacheable route → no Cache-Tag contribution.
    expect(ctx.embedded).toEqual([]);
    // Hydration still works, under a key distinct from the detail page's.
    const stateKeys = JSON.parse(transferState.toJson());
    expect(stateKeys['aeci.review-product:procore']).toEqual(product);
  });

  it('returns null and sets a 404 when the product is missing', async () => {
    const setNotFoundMeta = vi.fn();
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
      request: new Request('https://aecintegrations.com/products/procore/review'),
      meta: { setNotFoundMeta } as Partial<MetaService>,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(ctx.pageView).toBeNull();
  });
});
