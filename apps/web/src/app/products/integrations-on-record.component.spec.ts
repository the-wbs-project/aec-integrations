/**
 * AECI-1827, ruling 96 option B: the empty pair page's "Integrations on record" cell and
 * the product page's facts card print the same figure for the same product. The facts
 * card counts the rows its page lists when the stored `integration_count` is 0. The pair
 * page has no rows, so the API counts them (`countListedIntegrationRows`) and sends
 * `listed_integration_count`. Both pages then apply `integrationsOnRecordCount`.
 *
 * The fixture is a stale stored zero over rows of every routing kind: two direct edges, a
 * Via pair that collapses, an unnamed iPaaS row, a self-powered edge, an evidenced pair,
 * and powered edges that collapse to one pair. Named `.component.spec.ts` for `ng test`.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { countListedIntegrationRows } from '@aeci/shared';
import type {
  PoweredIntegrationItem,
  ProductDetail,
  ProductIntegrationItem,
  ProductLink,
  ProductPairResponse,
} from '@aeci/shared';

import { Analytics } from '../analytics/analytics';

import { splitIntegrationLanes } from './connector-lane-grouping';
import { groupPoweredIntegrations } from './powered-hub-grouping';
import { ProductFactsCard } from './product-facts-card';
import { ProductsPairPage } from './products-pair';

const link = (slug: string): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name: slug,
  logo_url: null,
});
const self = link('procore');
const autocad = link('autocad');
const sage = link('sage');
const bim = link('bim360');
const zapier = link('zapier');

let seq = 0;
const row = (
  partial: Partial<ProductIntegrationItem> & { source: ProductLink; target: ProductLink },
): ProductIntegrationItem => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  name: `${partial.source.name} and ${partial.target.name}`,
  mechanism_kind: 'native',
  mechanism_name: null,
  direction: null,
  context_direction: null,
  via: null,
  powered_by_product: null,
  data_object_slugs: [],
  data_objects: [],
  partner_categories: [],
  agreement: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  ...partial,
});

const asSource = [
  row({ source: self, target: autocad }),
  row({ source: self, target: autocad }),
  row({ source: self, target: sage, powered_by_product: zapier }),
  row({ source: self, target: bim, mechanism_kind: 'iPaaS' }),
  row({ source: self, target: bim, powered_by_product: self }),
  row({ source: self, target: autocad, via: zapier, mechanism_kind: null }),
];
const asTarget = [row({ source: sage, target: self, powered_by_product: zapier })];
const poweredRows: PoweredIntegrationItem[] = [
  row({ source: autocad, target: sage }),
  row({ source: sage, target: autocad }),
];

/** The detail payload the product page renders: a stale stored zero over rows. */
const detail = {
  claim_status: 'claimed',
  id: 'id-procore',
  slug: 'procore',
  name: 'Procore',
  logo_url: null,
  vendor_facts: { company_size: null, ownership_type: null },
  product_role: 'application',
  vendor: null,
  integration_count: 0,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  description: null,
  website: null,
  tool_integrations_url: null,
  api_docs_url: null,
  categories: [],
  audiences: [],
  phases: [],
  trades: [],
  usefulness: null,
  usefulness_source: null,
  integrations_as_source: asSource,
  integrations_as_target: asTarget,
  integrations_as_connector: poweredRows,
  related_products: [],
  extension_of: [],
  extensions: [],
  reviews: [],
  reachable_pair_count: 0,
  maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
  under_review: [],
} as unknown as ProductDetail;

/** The server's count over the same rows, as the API reads them (slugs only). */
function serverListedCount(p: ProductDetail): number {
  const edge = (i: ProductIntegrationItem) => ({
    partnerSlug: i.source.slug === p.slug ? i.target.slug : i.source.slug,
    sourceSlug: i.source.slug,
    targetSlug: i.target.slug,
    connectorSlug: i.via?.slug ?? i.powered_by_product?.slug ?? null,
    evidenced: i.via !== null,
    mechanismKind: i.mechanism_kind,
  });
  return countListedIntegrationRows(
    p.slug,
    [...p.integrations_as_source, ...p.integrations_as_target].map(edge),
    p.integrations_as_connector.map((i) => ({
      sourceSlug: i.source.slug,
      targetSlug: i.target.slug,
    })),
  );
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

function providers(extra: unknown[] = []) {
  return [
    provideZonelessChangeDetection(),
    provideRouter([]),
    provideHttpClient(),
    provideHttpClientTesting(),
    { provide: Analytics, useValue: { externalLinkClicked: vi.fn(), integrationViewed: vi.fn() } },
    ...extra,
  ];
}

describe('integrations on record: the pair page and the facts card agree (AECI-1827)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('counts the same rows as the product page lists, on both sides of the wire', () => {
    const web =
      splitIntegrationLanes(detail.integrations_as_source, detail.integrations_as_target).rowCount +
      groupPoweredIntegrations(detail.integrations_as_connector, detail.slug).pairCount;
    // 2 direct + Zapier/sage + unnamed/bim360 + self-powered + Zapier/autocad + 1 pair.
    expect(web).toBe(7);
    expect(serverListedCount(detail)).toBe(web);
  });

  it('prints the facts card figure in the pair cell for a stored zero over rows', () => {
    TestBed.configureTestingModule({ providers: providers() });
    const card = TestBed.createComponent(ProductFactsCard);
    card.componentRef.setInput('product', detail);
    card.detectChanges();
    const figure = text(
      (card.nativeElement as HTMLElement).querySelector(
        '[data-testid=product-facts-count] .aec-figure-value',
      ),
    );

    TestBed.resetTestingModule();
    const subject = (slug: string, overrides: Record<string, unknown>) => ({
      claim_status: 'claimed' as const,
      id: `id-${slug}`,
      slug,
      name: slug,
      logo_url: null,
      product_role: 'application' as const,
      vendor: null,
      integration_count: 0,
      listed_integration_count: 0,
      review_count: 0,
      rating_overall_avg: null,
      rating_onboarding_avg: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      categories: [],
      audiences: [],
      phases: [],
      trades: [],
      api_docs_url: null,
      tool_integrations_url: null,
      ...overrides,
    });
    const pair = {
      context_product: subject('procore', { listed_integration_count: serverListedCount(detail) }),
      other_product: subject('revit', {}),
      mechanisms: [],
      sync_headline: { total: 0, confirmed: 0, single_source: 0 },
      maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
      version_diff: null,
      moved_to: null,
    } as unknown as ProductPairResponse;
    TestBed.configureTestingModule({
      providers: providers([
        {
          provide: ActivatedRoute,
          useValue: {
            data: of({ pair }),
            snapshot: { data: { pair } },
            queryParamMap: of(convertToParamMap({})),
          },
        },
      ]),
    });
    const page = TestBed.createComponent(ProductsPairPage);
    page.detectChanges();
    const cells = [
      ...(page.nativeElement as HTMLElement).querySelectorAll(
        '[data-testid="pair-empty-facts-integrations"] td',
      ),
    ];
    expect(figure).toBe('7');
    expect(text(cells[0]?.querySelector('span'))).toBe(figure);
    // A product with no rows reads as words, never a bare 0.
    expect(text(cells[1])).toBe('None on record yet');
    expect(cells.some((c) => /(^|\s)0(\s|$)/.test(c.textContent ?? ''))).toBe(false);
  });
});
