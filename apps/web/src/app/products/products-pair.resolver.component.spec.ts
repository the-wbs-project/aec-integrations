/**
 * Tests for `productsPairResolver` (AECI-294). Named `.component.spec.ts` so it
 * runs under `ng test` — the resolver reads Angular DI tokens (`PLATFORM_ID`,
 * `REQUEST`, `REQUEST_CONTEXT`, `RESPONSE_INIT`, `TransferState`, `HttpClient`).
 *
 * Covers the pair-specific rules on top of the shared detail scaffold:
 *   - canonical is ALWAYS the alphabetically-first orientation;
 *   - an empty pair (no mechanisms) sets `noindex`;
 *   - NOT_FOUND → `RESPONSE_INIT.status = 404` + `setNotFoundMeta`;
 *   - hydration reuses the TransferState value without an HTTP fetch;
 *   - per-mechanism vendor / connector cache tags are pushed onto `ctx.embedded`.
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

import type { ProductPairResponse } from '@aeci/shared';

import { ServerApiError, type ServerApiClient } from '../../server-api-client';
import { createRequestContext, type AeciRequestContext } from '../../server/request-context';
import { MetaService } from '../core/meta.service';

import { productsPairResolver } from './products-pair.resolver';

const STATE = {} as RouterStateSnapshot;

const productListItem = (slug: string, name: string) => ({
  id: `00000000-0000-4000-8000-${slug.padEnd(12, '0')}`,
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: null,
  primary_category: null,
  integration_count: 1,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
});

function pairFixture(overrides: Partial<ProductPairResponse> = {}): ProductPairResponse {
  return {
    context_product: productListItem('procore', 'Procore'),
    other_product: productListItem('revit', 'Revit'),
    mechanisms: [
      {
        id: '00000000-0000-4000-8000-0000000000aa',
        mechanism_kind: 'native',
        mechanism_name: 'Procore ⇄ Revit',
        direction: 'outbound',
        description: null,
        listing_url: null,
        docs_url: null,
        built_by_vendor: {
          id: 'v1',
          name: 'Autodesk',
          slug: 'autodesk',
          logo_url: null,
          verified: false,
        },
        powered_by_product: { id: 'p9', name: 'Connector', slug: 'connector', logo_url: null },
        claims: [],
      },
    ],
    sync_headline: { total: 0, confirmed: 0, single_source: 0 },
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    // AECI-303: the §9 diff does not apply — the ordinary case for the whole
    // catalog, and the shape the default pair page must keep rendering.
    version_diff: null,
    ...overrides,
  };
}

function metaStub() {
  return { setEntityMeta: vi.fn(), setNotFoundMeta: vi.fn() } as unknown as MetaService & {
    setEntityMeta: ReturnType<typeof vi.fn>;
    setNotFoundMeta: ReturnType<typeof vi.fn>;
  };
}

function setup(opts: {
  platform: 'server' | 'browser';
  contextSlug: string;
  otherSlug: string;
  ctx?: AeciRequestContext | null;
  responseInit?: { status: number };
  request?: Request | null;
  meta: MetaService;
  /** The §9 version selectors (AECI-303). Absent = the latest × latest default. */
  queryParams?: Record<string, string>;
}) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: opts.platform === 'server' ? 'server' : 'browser' },
      { provide: REQUEST_CONTEXT, useValue: opts.ctx ?? null },
      { provide: RESPONSE_INIT, useValue: opts.responseInit ?? null },
      {
        provide: REQUEST,
        useValue:
          opts.request ??
          new Request(
            `https://example.test/products/${opts.contextSlug}/integrations/${opts.otherSlug}`,
          ),
      },
      { provide: MetaService, useValue: opts.meta },
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });

  const route = {
    paramMap: convertToParamMap({ contextSlug: opts.contextSlug, otherSlug: opts.otherSlug }),
    // AECI-303: the resolver reads the version selectors off the snapshot. Every
    // case needs this present, not just the version ones — a missing
    // `queryParamMap` throws before the resolver reaches its own logic.
    queryParamMap: convertToParamMap(opts.queryParams ?? {}),
  } as unknown as ActivatedRouteSnapshot;

  return {
    transferState: TestBed.inject(TransferState),
    httpMock: TestBed.inject(HttpTestingController),
    run: () =>
      TestBed.runInInjectionContext(
        () => productsPairResolver(route, STATE) as Promise<ProductPairResponse | null>,
      ),
  };
}

function apiClient(impl: (path: string) => Promise<unknown>): ServerApiClient {
  return { request: vi.fn(impl) as unknown as ServerApiClient['request'] };
}

describe('productsPairResolver — server path', () => {
  it('canonicalises to the alphabetically-first orientation even when viewed from the other side', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture()));
    // Viewed from Revit (the non-default orientation): revit > procore.
    const { run } = setup({
      platform: 'server',
      contextSlug: 'revit',
      otherSlug: 'procore',
      ctx,
      responseInit: { status: 200 },
      meta,
    });

    await run();

    expect(meta.setEntityMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical: 'https://example.test/products/procore/integrations/revit',
        noindex: false,
      }),
    );
  });

  it('sets noindex when the pair has no mechanisms', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture({ mechanisms: [] })));
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'revit',
      ctx,
      responseInit: { status: 200 },
      meta,
    });

    const result = await run();

    expect(result?.mechanisms).toEqual([]);
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });

  it('pushes per-mechanism vendor + connector cache tags and records a route page view', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture()));
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'revit',
      ctx,
      responseInit: { status: 200 },
      meta,
    });

    await run();

    expect(ctx.embedded).toEqual(
      expect.arrayContaining([
        { type: 'vendor', slug: 'autodesk' },
        { type: 'product', slug: 'connector' },
      ]),
    );
    expect(ctx.pageView).toEqual({ route: '/products/:contextSlug/integrations/:otherSlug' });
  });

  it('returns null, sets 404, and applies not-found meta on NOT_FOUND', async () => {
    const meta = metaStub();
    const ctx = createRequestContext(
      apiClient(async () => {
        throw new ServerApiError({ status: 404, code: 'NOT_FOUND', message: 'missing' });
      }),
    );
    const responseInit = { status: 200 };
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'nope',
      ctx,
      responseInit,
      meta,
    });

    const result = await run();

    expect(result).toBeNull();
    expect(responseInit.status).toBe(404);
    expect(meta.setNotFoundMeta).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'integration' }),
    );
    expect(meta.setEntityMeta).not.toHaveBeenCalled();
  });
});

describe('productsPairResolver — client path', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /** The key carries slugs in URL ORDER plus the selection (AECI-303). */
  const key = (contextSlug: string, otherSlug: string, selection = '|') =>
    makeStateKey<ProductPairResponse | null>(
      `aeci.product-pair:${contextSlug}|${otherSlug}|${selection}`,
    );

  it('reuses the TransferState value on hydration without an HTTP fetch', async () => {
    const meta = metaStub();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
    });
    const fixture = pairFixture();
    transferState.set(key('procore', 'revit'), fixture);

    const result = await run();

    expect(result).toEqual(fixture);
    httpMock.verify(); // no outstanding HTTP requests
    expect(meta.setEntityMeta).toHaveBeenCalled();
  });

  it('does NOT consume the other orientation’s slot (the pre-AECI-303 bug)', async () => {
    // The old key was `orientation-independent` (`{min}__{max}`) while the payload
    // is orientation-DEPENDENT (context_product, direction, attestor). Only one of a
    // pair's two URLs is ever SSR'd per document, so the shared slot could only ever
    // produce a FALSE hit — reachable in two clicks: SSR from revit, rail-link to
    // /products/procore, then into the procore-context pair, which re-runs the
    // resolver and would have rendered the two products swapped.
    const meta = metaStub();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
    });
    transferState.set(key('revit', 'procore'), pairFixture());

    const pending = run();
    httpMock.expectOne('/api/products/procore/integrations/revit').flush(pairFixture());
    await pending;
    httpMock.verify();
  });

  it('does NOT consume the default slot for a version selection', async () => {
    // TransferState.get() never deletes and nothing clears the store after
    // hydration, so without the selection in the key a selector change would be
    // served the previous selection's payload — the controls would look dead.
    const meta = metaStub();
    const { run, transferState, httpMock } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
      queryParams: { context_version: '2026.1' },
    });
    transferState.set(key('procore', 'revit'), pairFixture());

    const pending = run();
    httpMock
      .expectOne('/api/products/procore/integrations/revit?context_version=2026.1')
      .flush(pairFixture());
    await pending;
    httpMock.verify();
  });

  it('fetches the BARE path for the default selection', async () => {
    // A default selection must produce no query string at all, so the default render
    // shares one API response, one TransferState slot and one cache key with an
    // unparameterised visit.
    const meta = metaStub();
    const { run, httpMock } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
    });

    const pending = run();
    httpMock.expectOne('/api/products/procore/integrations/revit').flush(pairFixture());
    await pending;
    httpMock.verify();
  });

  it('forwards both selectors when both are set', async () => {
    const meta = metaStub();
    const { run, httpMock } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
      queryParams: { context_version: '2026.9', other_version: 'v5' },
    });

    const pending = run();
    httpMock
      .expectOne('/api/products/procore/integrations/revit?context_version=2026.9&other_version=v5')
      .flush(pairFixture());
    await pending;
    httpMock.verify();
  });
});

// ─── AECI-303 §9.2: noindex follows the RESPONSE, not the request ────────────

describe('productsPairResolver — version-selection noindex', () => {
  const diff = (isDefault: boolean) => ({
    context_versions: [{ label: '2026.1', released_at: null }],
    other_versions: [{ label: 'v5', released_at: null }],
    selected: { context: '2026.1', other: 'v5' },
    previous: null,
    is_default: isDefault,
    counts: { added: 0, removed: 0 },
    diff_access: 'full' as const,
  });

  async function runWith(
    overrides: Partial<ProductPairResponse>,
    queryParams?: Record<string, string>,
  ) {
    const meta = metaStub();
    const ctx = createRequestContext(apiClient(async () => pairFixture(overrides)));
    const { run } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'revit',
      ctx,
      responseInit: { status: 200 },
      meta,
      queryParams,
    });
    await run();
    return meta;
  }

  it('sets noindex for a non-default version selection', async () => {
    // Otherwise every (vA × vB) combination is an indexable near-duplicate.
    const meta = await runWith({ version_diff: diff(false) }, { context_version: '2026.1' });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });

  it('leaves a DEGRADED selection indexable — it follows the response', async () => {
    // A stale or garbage label resolves to latest server-side, so the page serves
    // canonical content; marking it noindex would describe a page nobody is shown,
    // and the query-stripped canonical already dedupes the URL.
    const meta = await runWith({ version_diff: diff(true) }, { context_version: 'nope' });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: false }));
  });

  it('leaves the latest × latest default indexable', async () => {
    const meta = await runWith({ version_diff: diff(true) });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: false }));
  });

  it('stays indexable when version_diff is absent (an older API Worker)', async () => {
    // The web never Zod-parses this response, so `version_diff` can be genuinely
    // undefined at runtime; `undefined?.is_default === false` is false — indexable,
    // which is the correct degradation.
    const meta = await runWith({ version_diff: undefined } as Partial<ProductPairResponse>, {
      context_version: '2026.1',
    });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: false }));
  });

  it('ORs with the empty-pair condition', async () => {
    const meta = await runWith({ mechanisms: [], version_diff: diff(false) });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });

  it('never carries the version params on the canonical', async () => {
    const meta = await runWith({ version_diff: diff(false) }, { context_version: '2026.1' });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical: 'https://example.test/products/procore/integrations/revit',
      }),
    );
  });
});
