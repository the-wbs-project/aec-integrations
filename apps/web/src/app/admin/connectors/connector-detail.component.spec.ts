/**
 * AECI-722 — `ConnectorDetail` logic + structural a11y.
 *
 * Four groups earn their keep beyond the happy path:
 *
 *  1. **The handover is present or absent, never stale.** A catalogue reclaimed
 *     to `review` must show NO handover block even though the `managed_by_vendor`
 *     audit row survives forever — the server suppresses it, and this asserts the
 *     screen does not reintroduce it from somewhere else.
 *  2. **A never-fetched action inventory reads as "Not fetched", not as zero.**
 *     §9a.3: a reader treating null as "none" would publish "this connector does
 *     nothing" about most of the catalogue.
 *  3. **The two pair lanes are two TABLES.** §13.3 requires one `<table>` per
 *     lane: a group-header row inside one `<tbody>` has no accessible name
 *     relationship to the rows beneath it, so the grouping would be visual only.
 *  4. **Sections fail independently.** Five fetches, five loading/failed pairs —
 *     a broken triage query must not blank the catalogue basics.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AdminConnectorCatalogDetail,
  AdminConnectorCounts,
  AdminConnectorStubRow,
} from '@aeci/shared';

import { AdminConnectorsApi } from './admin-connectors-api';
import { ConnectorDetail } from './connector-detail';

const CATALOG = 'cat-mindcloud';
const PRODUCT = {
  id: '00000000-0000-4000-8000-000000000010',
  name: 'MindCloud',
  slug: 'mindcloud',
};
const VENDOR = { id: '00000000-0000-4000-8000-000000000020', name: 'MindCloud Inc.', slug: 'mc' };

const COUNTS: AdminConnectorCounts = {
  surfaces: 1,
  stubs_total: 3,
  stubs_removed: 0,
  stubs_undecided: 1,
  mappings_mapped: 2,
  mappings_ruled_out: 0,
  mappings_out_of_scope: 0,
  mappings_no_record: 0,
  mappings_ambiguous_parked: 0,
  mappings_publishable: 1,
  pairs_curated: 1,
  pairs_generated: 0,
  pairs_unknown: 0,
  evidenced_pairs: 0,
};

function makeCatalog(over: Partial<AdminConnectorCatalogDetail> = {}): AdminConnectorCatalogDetail {
  return {
    id: CATALOG,
    connector_product: PRODUCT,
    connector_authorship: 'platform',
    managed_by: 'review',
    notes: null,
    last_ingested_at: '2026-08-29T02:00:00.000Z',
    counts: COUNTS,
    updated_at: '2026-08-30T00:00:00.000Z',
    surfaces: [
      {
        id: 'surf-1',
        surface_role: 'apps',
        index_kind: 'sitemap',
        index_url: 'https://example.com/apps.xml',
        last_ingested_at: '2026-08-29T02:00:00.000Z',
        notes: null,
      },
    ],
    handover: null,
    advisories: [],
    actor_emails_available: true,
    ...over,
  };
}

function makeStub(over: Partial<AdminConnectorStubRow> = {}): AdminConnectorStubRow {
  return {
    id: 'stub-1',
    slug: 'procore',
    label: 'Procore',
    url: 'https://example.com/procore',
    direction_role: 'both',
    action_count: null,
    actions_fetched: false,
    actions_fetched_at: null,
    first_seen_at: '2026-07-01T00:00:00.000Z',
    last_seen_at: '2026-08-30T00:00:00.000Z',
    removed_at: null,
    mappings: [],
    ...over,
  };
}

interface ApiMock {
  getCatalog: ReturnType<typeof vi.fn>;
  listStubs: ReturnType<typeof vi.fn>;
  listPairs: ReturnType<typeof vi.fn>;
  listAudit: ReturnType<typeof vi.fn>;
}

function makeApiMock(over: Partial<ApiMock> = {}): ApiMock {
  return {
    getCatalog: vi.fn(async () => makeCatalog()),
    listStubs: vi.fn(async () => ({
      data: [makeStub()],
      page: 1,
      perPage: 25,
      total: 1,
      advisories: [],
    })),
    listPairs: vi.fn(async (_id: string, q: Record<string, unknown>) =>
      q['lane'] === 'evidenced'
        ? { lane: 'evidenced', data: [], page: 1, perPage: 25, total: 0, advisories: [] }
        : { lane: 'reachable', data: [], page: 1, perPage: 25, total: 0, advisories: [] },
    ),
    listAudit: vi.fn(async () => ({
      data: [],
      page: 1,
      perPage: 25,
      total: 0,
      actor_emails_available: true,
    })),
    ...over,
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
      { provide: AdminConnectorsApi, useValue: api },
      {
        provide: ActivatedRoute,
        useValue: { snapshot: { paramMap: new Map([['id', CATALOG]]) } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ConnectorDetail);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

describe('ConnectorDetail', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('renders all five sections', async () => {
    const { el } = await setup(makeApiMock());
    expect([...el.querySelectorAll('h3')].map((h) => h.textContent?.trim())).toEqual([
      'Catalogue',
      'Feed surfaces',
      'Listings',
      'Pairs',
      'Audit trail',
    ]);
  });

  it('distinguishes a missing catalogue from a failed load', async () => {
    const notFound = await setup(
      makeApiMock({
        getCatalog: vi.fn(async () => Promise.reject({ status: 404 })),
      }),
    );
    expect(notFound.el.textContent).toContain('could not find that catalogue');
    expect(notFound.el.querySelector('[role="alert"]')).toBeNull();

    const failed = await setup(
      makeApiMock({
        getCatalog: vi.fn(async () => Promise.reject({ status: 500 })),
      }),
    );
    expect(failed.el.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('renders the handover while the lane is frozen', async () => {
    const { el } = await setup(
      makeApiMock({
        getCatalog: vi.fn(async () =>
          makeCatalog({
            managed_by: 'vendor',
            handover: {
              vendor: VENDOR,
              reason: 'Partnership track',
              actor: { id: 'a', display_name: 'Chris', email: null },
              at: '2026-08-30T10:00:00.000Z',
            },
          }),
        ),
      }),
    );
    expect(el.textContent).toContain('Handed over to');
    expect(el.textContent).toContain('MindCloud Inc.');
    expect(el.textContent).toContain('Partnership track');
  });

  it('renders NO handover once the lane is reclaimed', async () => {
    // The server suppresses it; this asserts the screen does not reintroduce a
    // stale handover from anywhere else.
    const { el } = await setup(makeApiMock());
    expect(el.textContent).not.toContain('Handed over to');
  });

  it('renders a never-fetched action inventory as "Not fetched", not as zero', async () => {
    const { el } = await setup(makeApiMock());
    const row = el.querySelector('tbody tr')!;
    expect(el.textContent).toContain('Not fetched');
    expect(row.textContent).not.toContain('Not yet reviewed0');
  });

  it('renders a listing with no decision as not yet reviewed', async () => {
    const { el } = await setup(makeApiMock());
    expect(el.textContent).toContain('Not yet reviewed');
  });

  it('renders the two pair lanes as SEPARATE tables, never one interleaved body', async () => {
    const { el } = await setup(
      makeApiMock({
        listPairs: vi.fn(async (_id: string, q: Record<string, unknown>) =>
          q['lane'] === 'evidenced'
            ? {
                lane: 'evidenced',
                data: [
                  {
                    id: '00000000-0000-4000-8000-000000000099',
                    product_a: { id: 'a', name: 'Procore', slug: 'procore' },
                    product_b: { id: 'b', name: 'Sage', slug: 'sage' },
                    name: null,
                    built_by_vendor: null,
                    mechanism_name: null,
                    direction: 'both',
                    listing_url: null,
                    last_reviewed_at: null,
                    maintained_by: 'aeci',
                  },
                ],
                page: 1,
                perPage: 25,
                total: 1,
                advisories: [],
              }
            : {
                lane: 'reachable',
                data: [
                  {
                    id: 'pair-1',
                    surface: 'curated',
                    side_a: {
                      stub_id: 's1',
                      slug: 'procore',
                      label: 'Procore',
                      product: null,
                      publishable: false,
                    },
                    side_b: {
                      stub_id: 's2',
                      slug: 'sage',
                      label: 'Sage',
                      product: null,
                      publishable: false,
                    },
                    url_a_to_b: null,
                    url_b_to_a: null,
                    classified_at: null,
                    first_seen_at: '2026-07-01T00:00:00.000Z',
                    last_seen_at: '2026-08-30T00:00:00.000Z',
                    removed_at: null,
                  },
                ],
                page: 1,
                perPage: 25,
                total: 1,
                advisories: [],
              },
        ),
      }),
    );
    const pairsSection = el.querySelector('section[aria-labelledby="admin-connector-pairs"]')!;
    expect(pairsSection.querySelectorAll('table')).toHaveLength(2);
    // Each table names itself, so a screen-reader user knows which lane they are in.
    for (const table of pairsSection.querySelectorAll('table')) {
      expect(table.querySelector('caption')?.textContent?.trim()).toBeTruthy();
    }
  });

  it('keeps the catalogue readable when the triage query fails', async () => {
    const { el } = await setup(
      makeApiMock({ listStubs: vi.fn(async () => Promise.reject(new Error('nope'))) }),
    );
    // Basics still rendered…
    expect(el.textContent).toContain('MindCloud');
    // …and the failure is scoped to its own section.
    expect(el.textContent).toContain('could not load the listings');
  });

  it('shows an error with retry for a failed pairs load, never the empty state', async () => {
    // A failed fetch must not read as "nothing delivered" — that is exactly the
    // loaded misreading the connector_evidenced_pairs_empty advisory guards
    // against, so both lanes surface an alert + retry like the other sections.
    const { el } = await setup(
      makeApiMock({ listPairs: vi.fn(async () => Promise.reject(new Error('nope'))) }),
    );
    const pairsSection = el.querySelector('section[aria-labelledby="admin-connector-pairs"]')!;
    expect(pairsSection.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(pairsSection.textContent).toContain('could not load the delivered pairs');
    expect(pairsSection.textContent).toContain('could not load these pages');
    expect(pairsSection.textContent).not.toContain('Nothing has been recorded as delivered');
    expect(pairsSection.textContent).not.toContain('publishes no pair pages');
  });

  describe('accessibility (structural)', () => {
    it('uses one h2 and no h1, with sections below it', async () => {
      const { el } = await setup(makeApiMock());
      expect(el.querySelectorAll('h1')).toHaveLength(0);
      expect(el.querySelectorAll('h2')).toHaveLength(1);
    });

    it('exposes EXACTLY ONE polite live region for the whole page', async () => {
      const { el } = await setup(makeApiMock());
      const regions = el.querySelectorAll('[role="status"]');
      expect(regions).toHaveLength(1);
      expect(regions[0]!.getAttribute('aria-live')).toBe('polite');
    });

    it('names and scopes every table it renders', async () => {
      const { el } = await setup(makeApiMock());
      for (const table of el.querySelectorAll('table')) {
        expect(table.querySelector('caption')?.textContent?.trim()).toBeTruthy();
        for (const th of table.querySelectorAll('thead th')) {
          expect(th.getAttribute('scope')).toBe('col');
        }
      }
    });
  });
});
