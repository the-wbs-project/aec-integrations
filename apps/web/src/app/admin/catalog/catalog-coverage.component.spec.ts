/**
 * AECI-579 / Phase 8.3 P1.5 — `CatalogCoverage` logic + structural a11y.
 *
 * The live axe pass runs in Playwright / static-serve on rendered routes (the
 * repo's component-level a11y convention — cf. `request-queue.component.spec.ts`).
 * Here we assert the rendering decisions that carry meaning:
 *
 *   1. **The provenance banner on counts-over-time.** Named in the AC as *"the
 *      thing most likely to be quietly dropped in a later refactor"*. It is
 *      driven by the timeseries response's own note — since AECI-686
 *      `catalog_series_is_surviving_rows` — so the assertion is that the note
 *      reaches the screen, and that it is absent when the API stops sending it.
 *      The request that earns that note (`basis=net`) is asserted alongside it:
 *      the note and the number have to come from the same reading.
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

/** What the API attaches to a `basis=net` catalog series (AECI-686): these are
 *  the rows still in the catalog, so the figures reconcile with the totals cards
 *  and an earlier bucket can fall as rows are removed later. */
const SURVIVING_ROWS_NOTE: AdminNote = {
  code: 'catalog_series_is_surviving_rows',
  severity: 'info',
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

function makeSeries(notes: AdminNote[] = [SURVIVING_ROWS_NOTE]): AdminTimeseriesResponse {
  return {
    metric: 'catalog.products_created',
    interval: 'day',
    basis: 'net',
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
    it('renders the surviving-rows caveat inside the counts-over-time section', async () => {
      const { el } = await setup(makeApiMock());

      const text = additionsSection(el).textContent ?? '';
      expect(text).toContain('records in the catalog now');
      // The restatement property is the whole cost of this basis. If the prose
      // ever loses it, the table starts claiming a fixed past it does not have.
      expect(text).toContain('can fall as records are removed later');
      // Localized prose, never the API's untranslated `message` or raw code.
      expect(text).not.toContain('catalog_series_is_surviving_rows');
      expect(text).not.toContain('WIRE FALLBACK');
    });

    // The reconciliation with the Catalog totals cards above this table is
    // entirely a property of WHICH basis is requested. `additions` is the
    // endpoint's default, so a dropped param is a silent regression to the
    // reading where 11,827 claim events sit under a card reading 1,691 — visible
    // only by reading two numbers on a screen nobody diffs.
    it('requests every series on the net basis, for all four metrics', async () => {
      const calls: unknown[][] = [];
      const timeseries = vi.fn(async (...args: unknown[]) => {
        calls.push(args);
        return makeSeries();
      });
      await setup(makeApiMock({ timeseries }));

      expect(calls.map((c) => [c[0], c[3]])).toEqual([
        ['catalog.products_created', 'net'],
        ['catalog.integrations_created', 'net'],
        ['catalog.vendors_created', 'net'],
        ['catalog.claims_created', 'net'],
      ]);
    });

    it('disappears when the API stops sending the note', async () => {
      const { el } = await setup(makeApiMock({ timeseries: vi.fn(async () => makeSeries([])) }));

      expect(additionsSection(el).textContent).not.toContain('records in the catalog now');
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

    it('says nothing in the catalog came from this window, not 30 rows of zeros', async () => {
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

      expect(additionsSection(el).textContent).toContain(
        'Nothing currently in the catalog was added in this window',
      );
      expect(additionsSection(el).querySelector('table')).toBeNull();
      // The caveat still shows — it explains the number that is being reported.
      expect(additionsSection(el).textContent).toContain('records in the catalog now');
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

  // ─── The Daily / Monthly panel ─────────────────────────────────────────────

  /**
   * Monthly is a client-side calendar-month rollup of the SAME daily series
   * (`interval` has one wire value), reached over a 12-month window that the
   * 30-day one never requests. Three things about that are worth pinning:
   * the wide fetch is lazy, its rollup is exact, and its caveats are its own.
   * The API derives every note from the window it served, so sharing one notes
   * list across two windows would eventually either hide a caveat on Monthly or
   * fabricate one on Daily.
   */
  describe('the Daily / Monthly tabs', () => {
    /**
     * A note attached to ONE of the two windows.
     *
     * The API derives every note from the window it actually served, so two
     * windows can carry different caveats — which is why the panel holds notes
     * per tab instead of sharing one list. On today's `basis=net` responses the
     * two happen to agree, so the code here is a stand-in and its identity is
     * immaterial: what is under test is that a note reaching one tab does not
     * leak onto the other, and vice versa. (Under the old `additions` basis this
     * was live: the 12-month window reached past the audit log's first row and
     * the 30-day one did not.)
     */
    const WINDOW_ONLY_NOTE: AdminNote = {
      code: 'catalog_series_starts_at',
      severity: 'info',
      message: 'WIRE FALLBACK — untranslated operator message',
      params: { earliest_day: '2026-05-01' },
    };

    /** A response whose points are given, rather than the fixture's two days. */
    function seriesOver(
      points: Array<{ day: string; value: number }>,
      notes: AdminNote[] = [SURVIVING_ROWS_NOTE],
    ): AdminTimeseriesResponse {
      return {
        ...makeSeries(notes),
        points: points.map((p) => ({
          ...p,
          value_excluding_internal: null,
          reconstructed: false,
        })),
      };
    }

    function tabs(el: HTMLElement): HTMLElement[] {
      return [...additionsSection(el).querySelectorAll('[role="tab"]')] as HTMLElement[];
    }

    /** Clicks a tab and drains the lazy fetch + the deferred panel render. */
    async function openTab(
      fixture: Awaited<ReturnType<typeof setup>>['fixture'],
      el: HTMLElement,
      label: string,
    ): Promise<void> {
      const tab = tabs(el).find((t) => (t.textContent ?? '').trim() === label);
      if (!tab) throw new Error(`No tab "${label}"`);
      tab.click();
      fixture.detectChanges();
      await fixture.whenStable();
      await settle();
      fixture.detectChanges();
    }

    it('does not fetch the 12-month window until Monthly is opened', async () => {
      const { api } = await setup(makeApiMock());

      // Four series, one window. The wide fetch is not paid for on arrival at a
      // screen most operators open for the gap lists.
      expect(api.timeseries).toHaveBeenCalledTimes(4);
    });

    it('fetches a month-aligned window under the 400-day cap when Monthly opens', async () => {
      const { fixture, el, api } = await setup(makeApiMock());
      await openTab(fixture, el, 'Monthly');

      expect(api.timeseries).toHaveBeenCalledTimes(8);
      const [, from, to] = api.timeseries.mock.calls[4];
      // A month bucket has to start on a month boundary, or the earliest row is
      // a partial month rendered as a whole one.
      expect(from).toMatch(/^\d{4}-\d{2}-01$/);
      const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
      expect(days).toBeLessThan(400);
      expect(days).toBeGreaterThan(300);
    });

    it('does not refetch when Monthly is re-selected', async () => {
      const { fixture, el, api } = await setup(makeApiMock());
      await openTab(fixture, el, 'Monthly');
      await openTab(fixture, el, 'Daily');
      await openTab(fixture, el, 'Monthly');

      // `ngTabContent` destroys the inactive panel, so a load keyed off render
      // would refetch on every switch back. It is keyed off selection instead.
      expect(api.timeseries).toHaveBeenCalledTimes(8);
    });

    it('sums the daily points into calendar months, newest month first', async () => {
      const timeseries = vi.fn(async () =>
        seriesOver([
          { day: '2026-07-30', value: 1 },
          { day: '2026-07-31', value: 2 },
          { day: '2026-08-01', value: 4 },
          { day: '2026-08-02', value: 3 },
        ]),
      );
      const { fixture, el } = await setup(makeApiMock({ timeseries }));
      await openTab(fixture, el, 'Monthly');

      const section = additionsSection(el);
      const months = [...section.querySelectorAll('tbody tr th')].map((c) =>
        (c.textContent ?? '').trim(),
      );
      expect(months).toEqual(['2026-08', '2026-07']);

      // 4 + 3 in August, 1 + 2 in July, per series.
      const august = [...(section.querySelectorAll('tbody tr')[0]?.querySelectorAll('td') ?? [])];
      expect(august.map((c) => (c.textContent ?? '').trim())).toEqual(['7', '7', '7', '7']);
    });

    it("keeps each window's caveats on its own tab", async () => {
      let call = 0;
      const timeseries = vi.fn(async () => {
        call += 1;
        // Calls 1-4 are the 30-day window; 5-8 are the 12-month one, which here
        // carries one extra caveat the narrow window does not.
        return call <= 4
          ? makeSeries([SURVIVING_ROWS_NOTE])
          : makeSeries([SURVIVING_ROWS_NOTE, WINDOW_ONLY_NOTE]);
      });
      const { fixture, el } = await setup(makeApiMock({ timeseries }));

      expect(additionsSection(el).textContent).not.toContain('The audit log begins');

      await openTab(fixture, el, 'Monthly');
      const monthly = additionsSection(el).textContent ?? '';
      expect(monthly).toContain('The audit log begins 2026-05-01');
      // The load-bearing banner rides on BOTH windows.
      expect(monthly).toContain('records in the catalog now');

      await openTab(fixture, el, 'Daily');
      expect(additionsSection(el).textContent).not.toContain('The audit log begins');
    });

    it('fails Monthly without disturbing Daily or the gap lists', async () => {
      let call = 0;
      const timeseries = vi.fn(async () => {
        call += 1;
        if (call > 4) throw new Error('timeseries 503');
        return makeSeries();
      });
      const { fixture, el } = await setup(makeApiMock({ timeseries }));
      await openTab(fixture, el, 'Monthly');

      expect(additionsSection(el).textContent).toContain("couldn't load the additions series");
      // The actionable half of the screen is untouched.
      expect(gapCard(el, 'No logo')).not.toBeNull();

      await openTab(fixture, el, 'Daily');
      const daily = additionsSection(el);
      expect(daily.querySelector('table')).not.toBeNull();
      expect(daily.textContent).not.toContain("couldn't load the additions series");
    });

    it('exposes two tabs and exactly one live panel', async () => {
      const { fixture, el } = await setup(makeApiMock());

      const labels = tabs(el).map((t) => (t.textContent ?? '').trim());
      expect(labels).toEqual(['Daily', 'Monthly']);
      expect(tabs(el).map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);

      await openTab(fixture, el, 'Monthly');
      expect(tabs(el).map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true']);

      // Only the selected panel holds content; the other is torn down.
      const rendered = [...additionsSection(el).querySelectorAll('[role="tabpanel"]')].filter(
        (p) => (p.textContent ?? '').trim() !== '',
      );
      expect(rendered).toHaveLength(1);
    });
  });
});
