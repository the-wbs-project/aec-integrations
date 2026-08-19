/**
 * AECI-579 / Phase 8.3 P1.5 — `CatalogCoverage` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `request-queue.component.spec.ts`).
 * Here we assert the rendering decisions that carry meaning:
 *
 *   1. **The approximation banner on counts-over-time.** Named in the AC as *"the
 *      thing most likely to be quietly dropped in a later refactor"*. It is
 *      driven by the timeseries response's `catalog_series_is_additions_only`
 *      note, so the assertion is that the note reaches the screen — and that it
 *      is absent when the API stops sending it (which is what P2.1 will do).
 *   2. **The all-affected case is not an error state.** `logo_url IS NULL` at
 *      171 of 171 must render as an ordinary count with no `role="alert"`
 *      anywhere near it.
 *   3. **The degenerate funnel is explained**, not left as 171/0/0/0/0.
 *   4. The two requests fail **independently** — a timeseries outage must not
 *      blank the gap lists, which are the actionable half of the screen.
 *
 * Harness mirrors `request-queue.component.spec.ts`: zoneless + a macrotask
 * `settle()` to drain `afterNextRender`'s async load.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminCatalogCoverageResponse,
  AdminCoverageGap,
  AdminCoverageGapKey,
  AdminNote,
  AdminTimeseriesResponse,
} from '@aeci/shared';

import { AdminCatalogApi } from './admin-catalog-api';
import { CatalogCoverage } from './catalog-coverage';

const GAP_KEYS: readonly AdminCoverageGapKey[] = [
  'products_without_vendor',
  'products_without_logo',
  'products_without_description',
  'products_without_api_docs',
  'products_without_category',
  'products_without_audience',
  'products_without_phase',
  'products_without_trade',
];

const ADDITIONS_NOTE: AdminNote = {
  code: 'catalog_series_is_additions_only',
  severity: 'warn',
  message: 'WIRE FALLBACK — untranslated operator message',
  params: { metric: 'catalog.products_created' },
};

function makeGap(key: AdminCoverageGapKey, over: Partial<AdminCoverageGap> = {}): AdminCoverageGap {
  return {
    key,
    total: over.total ?? 0,
    universe: over.universe ?? 171,
    sample: over.sample ?? [],
    sample_truncated: over.sample_truncated ?? false,
  };
}

function makeCoverage(
  over: Partial<AdminCatalogCoverageResponse> = {},
): AdminCatalogCoverageResponse {
  return {
    generated_at: '2026-08-13T05:00:00.000Z',
    source: 'live',
    notes: over.notes ?? [],
    sample_limit: over.sample_limit ?? 10,
    totals: over.totals ?? {
      products: 171,
      integrations: 496,
      vendors: 126,
      claims: 915,
      attestations: 915,
    },
    funnel: over.funnel ?? {
      stages: [
        { status: 'pending', count: 0 },
        { status: 'ready', count: 0 },
        { status: 'promoted', count: 171 },
        { status: 'retracted', count: 0 },
        { status: 'rejected', count: 0 },
      ],
      total: 171,
      promoted_cohort_only: true,
    },
    research_status: over.research_status ?? [
      { status: 'pending', count: 0 },
      { status: 'in_progress', count: 0 },
      { status: 'done', count: 171 },
      { status: 'blocked', count: 0 },
    ],
    gaps: over.gaps ?? GAP_KEYS.map((k) => makeGap(k)),
    taxonomy: over.taxonomy ?? [
      {
        facet: 'category',
        counts_what: 'products',
        terms_total: 1,
        terms_used: 1,
        publish_floor: null,
        terms_published: null,
        terms: [{ id: 'c1', slug: 'field', name: 'Field Management', count: 12, published: null }],
      },
      {
        facet: 'trade',
        counts_what: 'products',
        terms_total: 2,
        terms_used: 1,
        publish_floor: 3,
        terms_published: 1,
        terms: [
          { id: 't1', slug: 'electrical', name: 'Electrical', count: 4, published: true },
          { id: 't2', slug: 'plumbing', name: 'Plumbing', count: 1, published: false },
        ],
      },
      {
        facet: 'data_object',
        counts_what: 'claims',
        terms_total: 1,
        terms_used: 1,
        publish_floor: null,
        terms_published: null,
        terms: [{ id: 'd1', slug: 'rfi', name: 'RFI', count: 915, published: null }],
      },
    ],
    claim_coverage: over.claim_coverage ?? {
      integrations_total: 496,
      integrations_with_claims: 496,
      integrations_without_claims: 0,
      claims_total: 915,
      claims_with_active_attestation: 915,
      claims_without_active_attestation: 0,
      attestations_total: 915,
      integrations_without_claims_sample: [],
      integrations_without_claims_sample_truncated: false,
    },
  };
}

function makeSeries(notes: AdminNote[] = [ADDITIONS_NOTE]): AdminTimeseriesResponse {
  return {
    metric: 'catalog.products_created',
    interval: 'day',
    window: {
      from: '2026-07-15T00:00:00.000Z',
      to: '2026-08-14T00:00:00.000Z',
      timezone: 'UTC',
      days: 30,
    },
    generated_at: '2026-08-13T05:00:00.000Z',
    source: 'live',
    notes,
    internal_filter: { available: false, applied: false, asns: [] },
    points: [
      { day: '2026-08-11', value: 2, value_excluding_internal: null, reconstructed: false },
      { day: '2026-08-12', value: 5, value_excluding_internal: null, reconstructed: false },
    ],
    total: { total: 7, excluding_internal: null },
  };
}

interface ApiMock {
  coverage: ReturnType<typeof vi.fn>;
  timeseries: ReturnType<typeof vi.fn>;
}

function makeApiMock(over: Partial<ApiMock> = {}): ApiMock {
  return {
    coverage: over.coverage ?? vi.fn(async () => makeCoverage()),
    timeseries: over.timeseries ?? vi.fn(async () => makeSeries()),
  };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

async function setup(api: ApiMock) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminCatalogApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(CatalogCoverage);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

/** The section wrapping the counts-over-time table. */
function additionsSection(el: HTMLElement): HTMLElement {
  const section = el.querySelector('[aria-labelledby="admin-catalog-additions-heading"]');
  if (!section) throw new Error('additions section missing');
  return section as HTMLElement;
}

function gapCard(el: HTMLElement, label: string): HTMLElement {
  const card = [...el.querySelectorAll('li')].find((li) =>
    li.querySelector('h4')?.textContent?.trim().startsWith(label),
  );
  if (!card) throw new Error(`No gap card "${label}"`);
  return card as HTMLElement;
}

describe('CatalogCoverage', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders nothing but a shell before the fetch resolves (SSR-neutral first paint)', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AdminCatalogApi, useValue: makeApiMock() },
      ],
    });
    const fixture = TestBed.createComponent(CatalogCoverage);
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // The heading + intro paint immediately; the data sections do not.
    expect(el.querySelector('#admin-catalog-heading')).not.toBeNull();
    expect(el.querySelector('[aria-labelledby="admin-catalog-totals-heading"]')).toBeNull();
  });

  it('loads coverage and the four catalog additions series', async () => {
    const { el, api } = await setup(makeApiMock());

    expect(api.coverage).toHaveBeenCalledTimes(1);
    expect(api.timeseries).toHaveBeenCalledTimes(4);
    expect(api.timeseries.mock.calls.map((c) => c[0])).toEqual([
      'catalog.products_created',
      'catalog.integrations_created',
      'catalog.vendors_created',
      'catalog.claims_created',
    ]);
    // Both endpoints of the same window, inclusive UTC calendar dates.
    for (const [, from, to] of api.timeseries.mock.calls) {
      expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(el.textContent).toContain('171');
    expect(el.textContent).toContain('496');
  });

  // ─── The AC's named case ───────────────────────────────────────────────────

  describe('the approximation banner on counts-over-time', () => {
    it('renders the additions-only caveat inside the counts-over-time section', async () => {
      const { el } = await setup(makeApiMock());

      const text = additionsSection(el).textContent ?? '';
      expect(text).toContain('additions per day');
      expect(text).toContain('not a net total');
      // Localized prose, never the API's untranslated `message` or raw code.
      expect(text).not.toContain('catalog_series_is_additions_only');
      expect(text).not.toContain('WIRE FALLBACK');
    });

    it('disappears when the API stops sending the note (what P2.1 will do)', async () => {
      const { el } = await setup(makeApiMock({ timeseries: vi.fn(async () => makeSeries([])) }));

      expect(additionsSection(el).textContent).not.toContain('not a net total');
      // The table itself is still there — only the caveat went away.
      expect(additionsSection(el).querySelector('table')).not.toBeNull();
    });

    it('lists the newest day first, reversing the API ascending points', async () => {
      const { el } = await setup(makeApiMock());

      const days = Array.from(additionsSection(el).querySelectorAll('tbody tr th')).map((c) =>
        (c.textContent ?? '').trim(),
      );
      expect(days).toEqual(['2026-08-12', '2026-08-11']);
    });

    it('shows each distinct caveat once, not once per series', async () => {
      // All four requests share a window, so they return identical notes.
      const { el } = await setup(makeApiMock());
      const banners = additionsSection(el).querySelectorAll('aec-admin-notes li');
      expect(banners).toHaveLength(1);
    });
  });

  // ─── The all-affected rendering ────────────────────────────────────────────

  describe('the all-affected case', () => {
    it('renders 171 of 171 as an ordinary count, with no alert anywhere', async () => {
      const { el } = await setup(
        makeApiMock({
          coverage: vi.fn(async () =>
            makeCoverage({
              gaps: GAP_KEYS.map((k) =>
                k === 'products_without_logo'
                  ? makeGap(k, {
                      total: 171,
                      universe: 171,
                      sample: [{ id: 'p1', name: 'Procore', slug: 'procore' }],
                      sample_truncated: true,
                    })
                  : makeGap(k),
              ),
            }),
          ),
        }),
      );

      const card = gapCard(el, 'No logo');
      expect(card.textContent).toContain('171');
      expect(card.textContent).toContain('of 171');
      // The defining assertion: an entirely-affected catalog is a worklist.
      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(card.querySelector('[role="alert"]')).toBeNull();
    });

    it('links each sample row to the product page', async () => {
      const { el } = await setup(
        makeApiMock({
          coverage: vi.fn(async () =>
            makeCoverage({
              gaps: [
                makeGap('products_without_logo', {
                  total: 1,
                  sample: [{ id: 'p1', name: 'Procore', slug: 'procore' }],
                }),
              ],
            }),
          ),
        }),
      );

      const link = gapCard(el, 'No logo').querySelector('a');
      expect(link?.getAttribute('href')).toContain('/products/procore');
      expect(link?.textContent).toContain('Procore');
    });

    it('says so plainly when a gap is clear', async () => {
      const { el } = await setup(makeApiMock());
      expect(gapCard(el, 'No logo').textContent).toContain('Nothing missing');
    });

    it('reports truncation against the exact count', async () => {
      const { el } = await setup(
        makeApiMock({
          coverage: vi.fn(async () =>
            makeCoverage({
              gaps: [
                makeGap('products_without_vendor', {
                  total: 40,
                  sample: [{ id: 'p1', name: 'Procore', slug: 'procore' }],
                  sample_truncated: true,
                }),
              ],
            }),
          ),
        }),
      );
      expect(gapCard(el, 'No vendor').textContent).toContain('Showing 1 of 40');
    });
  });

  // ─── The degenerate funnel ─────────────────────────────────────────────────

  it('explains the promoted-only funnel instead of showing a bare 171/0/0/0/0', async () => {
    const { el } = await setup(
      makeApiMock({
        coverage: vi.fn(async () =>
          makeCoverage({
            notes: [
              {
                code: 'funnel_is_promoted_cohort_only',
                severity: 'warn',
                message: 'untranslated',
                params: { promoted: 171 },
              },
            ],
          }),
        ),
      }),
    );

    expect(el.textContent).toContain('one populated stage by design');
    expect(el.textContent).toContain('review app');
    // Every stage is still listed, zeros included.
    const funnel = el.querySelector('[aria-labelledby="admin-catalog-funnel-heading"]');
    expect(funnel?.textContent).toContain('Promoted');
    expect(funnel?.textContent).toContain('Retracted');
  });

  // ─── Taxonomy ──────────────────────────────────────────────────────────────

  it('shows the trade publication gate and labels thin terms', async () => {
    const { el } = await setup(makeApiMock());
    const trades = el.querySelector('[aria-labelledby="admin-catalog-facet-trade"]');

    expect(trades?.textContent).toContain('1 clear the 3-product publication floor');
    expect(trades?.textContent).toContain('Electrical');
    expect(trades?.textContent).toContain('Published');
    expect(trades?.textContent).toContain('Thin');
  });

  it('labels the data-object column as claims, not products', async () => {
    const { el } = await setup(makeApiMock());
    const dataObjects = el.querySelector('[aria-labelledby="admin-catalog-facet-data_object"]');

    const headers = [...(dataObjects?.querySelectorAll('thead th') ?? [])].map((h) =>
      h.textContent?.trim(),
    );
    expect(headers).toContain('Claims');
    expect(headers).not.toContain('Products');
    // No publication column on a facet with no gate.
    expect(headers).not.toContain('Page');
  });

  // ─── Claims coverage ───────────────────────────────────────────────────────

  it('links a claimless integration to its pair page', async () => {
    const { el } = await setup(
      makeApiMock({
        coverage: vi.fn(async () =>
          makeCoverage({
            claim_coverage: {
              integrations_total: 2,
              integrations_with_claims: 1,
              integrations_without_claims: 1,
              claims_total: 1,
              claims_with_active_attestation: 1,
              claims_without_active_attestation: 0,
              attestations_total: 1,
              integrations_without_claims_sample: [
                {
                  id: 'i1',
                  name: null,
                  source_product: { id: 'p1', name: 'Revit', slug: 'revit' },
                  target_product: { id: 'p2', name: 'Procore', slug: 'procore' },
                },
              ],
              integrations_without_claims_sample_truncated: false,
            },
          }),
        ),
      }),
    );

    const section = el.querySelector('[aria-labelledby="admin-catalog-claims-heading"]');
    const link = section?.querySelector('ul a');
    expect(link?.getAttribute('href')).toBe('/products/revit/integrations/procore');
    // A nullable integration name still renders — the endpoints carry the label.
    expect(link?.textContent).toContain('Revit');
    expect(link?.textContent).toContain('Procore');
  });

  // ─── Failure isolation ─────────────────────────────────────────────────────

  describe('failure handling', () => {
    it('offers a retry when coverage fails', async () => {
      const coverage = vi
        .fn<() => Promise<AdminCatalogCoverageResponse>>()
        .mockRejectedValueOnce(new Error('401'))
        .mockResolvedValueOnce(makeCoverage());
      const { el, fixture } = await setup(makeApiMock({ coverage }));

      expect(el.querySelector('[role="alert"]')?.textContent).toContain("couldn't load");

      const retry = [...el.querySelectorAll('button')].find(
        (b) => b.textContent?.trim() === 'Try again',
      );
      retry?.click();
      await fixture.whenStable();
      await settle();
      fixture.detectChanges();

      expect(el.querySelector('[role="alert"]')).toBeNull();
      expect(el.textContent).toContain('Catalog totals');
    });

    it('keeps the gap lists when only the additions series fails', async () => {
      // The gap lists are the actionable half of the screen; a timeseries outage
      // must not take them down with it.
      const { el } = await setup(
        makeApiMock({ timeseries: vi.fn(async () => Promise.reject(new Error('500'))) }),
      );

      expect(additionsSection(el).textContent).toContain("couldn't load the additions series");
      expect(el.querySelector('[aria-labelledby="admin-catalog-gaps-heading"]')).not.toBeNull();
      expect(el.textContent).toContain('Catalog totals');
    });

    it('says nothing was added rather than printing 30 rows of zeros', async () => {
      const { el } = await setup(
        makeApiMock({
          timeseries: vi.fn(async () => ({
            ...makeSeries(),
            points: [
              { day: '2026-08-11', value: 0, value_excluding_internal: null, reconstructed: false },
              { day: '2026-08-12', value: 0, value_excluding_internal: null, reconstructed: false },
            ],
          })),
        }),
      );

      expect(additionsSection(el).textContent).toContain('Nothing was added');
      expect(additionsSection(el).querySelector('table')).toBeNull();
      // The caveat still shows — it explains the number that is being reported.
      expect(additionsSection(el).textContent).toContain('not a net total');
    });
  });

  // ─── Structural a11y ───────────────────────────────────────────────────────

  it('nests its headings under the shell h1 without skipping a level', async () => {
    const { el } = await setup(makeApiMock());

    // The shell owns h1; this screen starts at h2 and never jumps.
    expect(el.querySelector('h1')).toBeNull();
    expect(el.querySelectorAll('h2')).toHaveLength(1);
    expect(el.querySelectorAll('h3').length).toBeGreaterThan(0);
  });

  it('gives every data table a caption and row/column header scopes', async () => {
    const { el } = await setup(makeApiMock());

    const tables = [...el.querySelectorAll('table')];
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      expect(table.querySelector('caption')?.textContent?.trim().length ?? 0).toBeGreaterThan(0);
      for (const th of table.querySelectorAll('th')) {
        expect(th.getAttribute('scope')).toMatch(/^(row|col)$/);
      }
    }
  });
});
