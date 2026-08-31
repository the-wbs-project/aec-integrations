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

import { gateHistoricalDepth, productsPairResolver } from './products-pair.resolver';

const STATE = {} as RouterStateSnapshot;

/**
 * `verified` is the mirror AECI-304's gate reads: historical diff depth is open when
 * EITHER endpoint vendor holds `'integration.version_diff'`. The default fixture is
 * entitled on the context side, so every pre-existing case still describes an open
 * pair; the gate cases below pass `verified: false` on both.
 */
const productListItem = (slug: string, name: string, verified = slug === 'procore') => ({
  id: `00000000-0000-4000-8000-${slug.padEnd(12, '0')}`,
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: { id: `v-${slug}`, name: `${name} Inc`, slug: `${slug}-inc`, logo_url: null, verified },
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
        via: null,
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
  return {
    setEntityMeta: vi.fn(),
    setNotFoundMeta: vi.fn(),
    setPairJsonLd: vi.fn(),
  } as unknown as MetaService & {
    setEntityMeta: ReturnType<typeof vi.fn>;
    setNotFoundMeta: ReturnType<typeof vi.fn>;
    setPairJsonLd: ReturnType<typeof vi.fn>;
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
    // AECI-518 — both branches call the same `applyResolvedMeta`, so the LD is
    // re-applied on hydration and on every in-app navigation onto a pair page.
    // That matters twice over: a JS-rendering crawler sees the client head, and
    // it is what keeps a stale block from a prior route off this page.
    expect(meta.setPairJsonLd).toHaveBeenCalled();
  });

  it('suppresses JSON-LD client-side for an empty pair', async () => {
    const meta = metaStub();
    const { run, transferState } = setup({
      platform: 'browser',
      contextSlug: 'procore',
      otherSlug: 'revit',
      meta,
    });
    transferState.set(key('procore', 'revit'), pairFixture({ mechanisms: [] }));

    await run();

    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(meta.setPairJsonLd).not.toHaveBeenCalled();
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

  // ─── AECI-518: JSON-LD rides the SAME noindex decision ────────────────────
  // Structured data must never describe a page we are telling crawlers to skip.
  // Both suppression reasons are exercised, because they are OR'd and a
  // regression could easily restore one while breaking the other.

  it('emits JSON-LD for an indexable pair', async () => {
    const meta = await runWith({ version_diff: diff(true) });
    expect(meta.setPairJsonLd).toHaveBeenCalledWith(
      expect.objectContaining({
        canonical: 'https://example.test/products/procore/integrations/revit',
        name: 'Procore and Revit integrations',
        context: expect.objectContaining({ slug: 'procore' }),
        other: expect.objectContaining({ slug: 'revit' }),
      }),
    );
  });

  it('suppresses JSON-LD on an empty pair (thin content)', async () => {
    const meta = await runWith({ mechanisms: [] });
    expect(meta.setEntityMeta).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(meta.setPairJsonLd).not.toHaveBeenCalled();
  });

  it('suppresses JSON-LD on a non-default version selection', async () => {
    const meta = await runWith({ version_diff: diff(false) }, { context_version: '2026.1' });
    expect(meta.setPairJsonLd).not.toHaveBeenCalled();
  });

  // The LD's `name`/`description` are the same values `setEntityMeta` receives,
  // which is what makes structured-data-vs-`<title>` drift structurally
  // impossible rather than test-enforced.
  it('passes the SAME name and description it gave setEntityMeta', async () => {
    const meta = await runWith({ version_diff: diff(true) });
    const entity = meta.setEntityMeta.mock.calls[0]![0];
    const ld = meta.setPairJsonLd.mock.calls[0]![0];
    expect(ld.name).toBe(entity.name);
    expect(ld.description).toBe(entity.description);
    expect(ld.canonical).toBe(entity.canonical);
  });
});

// ─── AECI-304 §9.3: the gate is on the PAIR'S VENDORS, never the reader ──────

describe('gateHistoricalDepth — the seam’s second consult site', () => {
  const claim = (versionStatus?: 'added' | 'removed' | 'unchanged') => ({
    id: '00000000-0000-4000-8000-0000000000c1',
    data_object_slug: 'rfis',
    data_object_name: 'RFIs',
    direction: 'outbound' as const,
    agreement: 'conflict' as const,
    attestations: [],
    ...(versionStatus ? { version_status: versionStatus } : {}),
  });

  /** An API answer carrying real historical depth. */
  const openDiff = {
    context_versions: [{ label: '2026.1', released_at: null }],
    other_versions: [{ label: 'v5', released_at: null }],
    selected: { context: '2026.1', other: 'v5' },
    previous: { context: null, other: 'v4' },
    is_default: false,
    counts: { added: 1, removed: 0 },
    diff_access: 'full' as const,
  };

  /** A pair whose two endpoint vendors carry the given `verified` mirrors. */
  function pair(contextVerified: boolean, otherVerified: boolean): ProductPairResponse {
    return pairFixture({
      context_product: productListItem('procore', 'Procore', contextVerified),
      other_product: productListItem('revit', 'Revit', otherVerified),
      version_diff: openDiff,
      mechanisms: [{ ...pairFixture().mechanisms[0]!, claims: [claim('added')] }],
    });
  }

  it('leaves the LATEST view untouched however unentitled the pair is', () => {
    // THE reader invariant (§8.1(4) / §11): the latest-version view is always free
    // and full-fidelity, decided before any entitlement is consulted.
    const latest = pair(false, false);
    expect(gateHistoricalDepth(latest, false)).toBe(latest);
  });

  it('leaves historical depth intact when EITHER endpoint vendor is entitled', () => {
    expect(gateHistoricalDepth(pair(true, false), true).version_diff).toEqual(openDiff);
    expect(gateHistoricalDepth(pair(false, true), true).version_diff).toEqual(openDiff);
    expect(gateHistoricalDepth(pair(true, true), true).version_diff).toEqual(openDiff);
  });

  it('strips depth an unentitled pair should never have been served', () => {
    // Only reachable against an API Worker that predates AECI-304 — the current one
    // clamps server-side. This resolver is the last thing between that answer and a
    // shared, URL-keyed, publicly cached SSR document.
    const gated = gateHistoricalDepth(pair(false, false), true);
    expect(gated.version_diff).toBeNull();
    expect(gated.mechanisms[0]!.claims[0]!.version_status).toBeUndefined();
    // The dispute is NOT paywalled — agreement survives untouched.
    expect(gated.mechanisms[0]!.claims[0]!.agreement).toBe('conflict');
  });

  it('leaves an already-clamped payload alone so `diff_access` survives', () => {
    const clamped = pairFixture({
      context_product: productListItem('procore', 'Procore', false),
      other_product: productListItem('revit', 'Revit', false),
      version_diff: { ...openDiff, is_default: true, diff_access: 'latest_only' },
    });
    expect(gateHistoricalDepth(clamped, true)).toBe(clamped);
  });

  it('tolerates a `version_diff` that is genuinely absent (an older API Worker)', () => {
    // The web never Zod-parses this response, so the key can be missing entirely.
    const legacy = pairFixture({
      context_product: productListItem('procore', 'Procore', false),
      other_product: productListItem('revit', 'Revit', false),
      version_diff: undefined,
    } as Partial<ProductPairResponse>);
    expect(() => gateHistoricalDepth(legacy, true)).not.toThrow();
    expect(gateHistoricalDepth(legacy, true)).toBe(legacy);
  });

  it('treats an endpoint with no vendor as unentitled — fail closed', () => {
    const vendorless = pairFixture({
      context_product: { ...productListItem('procore', 'Procore'), vendor: null },
      other_product: { ...productListItem('revit', 'Revit'), vendor: null },
      version_diff: openDiff,
    });
    expect(gateHistoricalDepth(vendorless, true).version_diff).toBeNull();
  });

  it('never gates the SSR document on the reader — no cookie or header is consulted', async () => {
    // What keeps the page in the shared, URL-keyed edge cache: the resolver's answer
    // is a function of the payload's own vendor mirrors and the URL, nothing else.
    const meta = metaStub();
    const ctx = createRequestContext(
      apiClient(async () =>
        pairFixture({
          context_product: productListItem('procore', 'Procore', false),
          other_product: productListItem('revit', 'Revit', false),
          version_diff: openDiff,
        }),
      ),
    );
    const { run, transferState } = setup({
      platform: 'server',
      contextSlug: 'procore',
      otherSlug: 'revit',
      ctx,
      responseInit: { status: 200 },
      meta,
      request: new Request('https://example.test/products/procore/integrations/revit', {
        headers: { cookie: 'sb-access-token=whatever' },
      }),
      queryParams: { context_version: '2026.1' },
    });

    const resolved = await run();
    expect(resolved?.version_diff).toBeNull();
    // …and the TransferState block — which is serialised INTO the cached document —
    // carries the stripped payload, not the API's.
    const transferred = transferState.get(
      makeStateKey<ProductPairResponse | null>('aeci.product-pair:procore|revit|2026.1|'),
      null,
    );
    expect(transferred?.version_diff).toBeNull();
  });
});
