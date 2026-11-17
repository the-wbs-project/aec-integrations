/**
 * AECI-1779: the product page's facts card (`product-facts-card.ts`).
 *
 * Named `.component.spec.ts` so it runs under `ng test`. The page-level behaviour the card
 * inherited from the sidebar (captions, under-review markers, the claim and correction
 * entries) stays covered in `product-detail.component.spec.ts`, which renders the card
 * through the page. This spec pins what the card itself decides: the count figure, the
 * column order, what stays out of it, and the lower "who it is for" row.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PoweredIntegrationItem, ProductDetail, ProductIntegrationItem } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';

import { ProductFactsCard } from './product-facts-card';

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    claim_status: 'claimed',
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: 'https://example.com/procore.png',
    vendor_facts: { company_size: null, ownership_type: null },
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: 'https://example.com/procore-logo.png',
    },
    integration_count: 14,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: null,
    website: 'https://www.procore.com',
    tool_integrations_url: null,
    api_docs_url: null,
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    usefulness: null,
    usefulness_source: null,
    integrations_as_source: [],
    integrations_as_target: [],
    integrations_as_connector: [],
    related_products: [],
    extension_of: [],
    extensions: [],
    reviews: [],
    reachable_pair_count: 0,
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    under_review: [],
    ...overrides,
  } as ProductDetail;
}

const category = { id: 'c1', slug: 'project-management', name: 'Project Management' };
const audience = { id: 'a1', slug: 'general-contractors', name: 'General Contractors' };

function setup(product: ProductDetail) {
  const analytics = { externalLinkClicked: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: analytics },
    ],
  });
  const fixture = TestBed.createComponent(ProductFactsCard);
  fixture.componentRef.setInput('product', product);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return {
    fixture,
    el,
    analytics,
    card: el.querySelector<HTMLElement>('[data-testid=product-facts]')!,
  };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();

describe('ProductFactsCard (AECI-1779)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is one elevated card', () => {
    const { card } = setup(buildProduct());
    expect(card.hasAttribute('aeccard')).toBe(true);
    expect(card.classList).toContain('shadow-card');
  });

  describe('the count figure', () => {
    it('prints integration_count once, with the noun the product cards use', () => {
      const { card } = setup(buildProduct({ integration_count: 14 }));
      const stat = card.querySelector('[data-testid=product-facts-count]')!;
      expect(text(stat.querySelector('.aec-figure-value'))).toBe('14');
      expect(text(stat.querySelector('p'))).toBe('integrations');
      // The count appears once in the card, and a screen reader hears it once.
      expect(card.querySelectorAll('.aec-figure-value')).toHaveLength(1);
      expect(stat.querySelector('.aec-figure-value')!.getAttribute('aria-hidden')).toBeNull();
    });

    it('says "integration" for one', () => {
      const { card } = setup(buildProduct({ integration_count: 1 }));
      const stat = card.querySelector('[data-testid=product-facts-count]')!;
      expect(text(stat.querySelector('.aec-figure-value'))).toBe('1');
      expect(text(stat.querySelector('p'))).toBe('integration');
    });

    it('formats a large count with the locale grouping', () => {
      const { card } = setup(buildProduct({ integration_count: 1234 }));
      expect(text(card.querySelector('.aec-figure-value'))).toBe('1,234');
    });

    it('renders the legal-reviewed zero words and hides the bare numeral', () => {
      const { card } = setup(buildProduct({ integration_count: 0 }));
      const stat = card.querySelector('[data-testid=product-facts-count]')!;
      expect(stat.querySelector('.aec-figure-value')!.getAttribute('aria-hidden')).toBe('true');
      expect(text(stat)).toContain('We have no integrations for Procore on record');
      expect(text(stat)).toContain(
        'Not on record means we have not found one. It is not proof that none exists.',
      );
      expect(text(stat)).not.toContain('0 integrations');
    });

    it('shows the listed rows, never the zero words, when a stale stored zero sits over rows', () => {
      // The fx-agave fixture: stored integration_count 0, one endpoint row, two powered pairs.
      const page = { id: 'p0', slug: 'procore', name: 'Procore', logo_url: null };
      const a = { id: 'p1', slug: 'sage', name: 'Sage', logo_url: null };
      const b = { id: 'p2', slug: 'vista', name: 'Vista', logo_url: null };
      const c = { id: 'p3', slug: 'quickbooks', name: 'QuickBooks', logo_url: null };
      const base = {
        mechanism_kind: 'native',
        mechanism_name: null,
        direction: 'a_to_b',
        via: null,
        data_object_slugs: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
      } satisfies Partial<PoweredIntegrationItem>;
      const endpointRow: ProductIntegrationItem = {
        ...base,
        id: '00000000-0000-4000-8000-000000000101',
        name: 'Sage to Procore',
        context_direction: null,
        source: a,
        target: page,
        powered_by_product: null,
        data_objects: [],
        partner_categories: [],
        agreement: null,
      };
      const powered: PoweredIntegrationItem[] = [
        { ...base, id: '00000000-0000-4000-8000-000000000102', name: 'A', source: a, target: b },
        { ...base, id: '00000000-0000-4000-8000-000000000103', name: 'B', source: b, target: c },
      ];
      const { card } = setup(
        buildProduct({
          integration_count: 0,
          integrations_as_target: [endpointRow],
          integrations_as_connector: powered,
        }),
      );
      const stat = card.querySelector('[data-testid=product-facts-count]')!;
      expect(text(stat.querySelector('.aec-figure-value'))).toBe('3');
      expect(text(stat.querySelector('p'))).toBe('integrations');
      expect(text(stat)).not.toContain('on record');
    });

    it('keeps a non-zero stored count even when it differs from the listed rows', () => {
      const { card } = setup(buildProduct({ integration_count: 12 }));
      expect(text(card.querySelector('.aec-figure-value'))).toBe('12');
    });

    it('never carries the reach line: section 13.7 keeps it under the Integrations section', () => {
      const { card } = setup(buildProduct({ reachable_pair_count: 38 }));
      expect(text(card)).not.toMatch(/reachable/i);
      expect(text(card)).not.toContain('38');
    });
  });

  describe('the top row', () => {
    const columnHeadings = (card: HTMLElement) => [...card.querySelectorAll('h2')].map((h) => h.id);

    it('reads stat, Vendor, Categories, Resources, then the actions in DOM order', () => {
      const { card } = setup(
        buildProduct({ categories: [category], api_docs_url: 'https://dev.procore.com' }),
      );
      const row = card.firstElementChild!;
      expect(row.firstElementChild!.getAttribute('data-testid')).toBe('product-facts-count');
      expect(columnHeadings(card)).toEqual([
        'vendor-card-title',
        'categories-label',
        'resources-label',
      ]);
      // Mock-up 6 .f-acts (AECI-1720 restore): the buttons sit under Resources with no
      // heading of their own.
      expect(card.textContent).not.toContain('Actions');
      const resources = card.querySelector('[aria-labelledby=resources-label]')!;
      const actions = card.querySelector('[data-testid=product-facts-actions]')!;
      expect(
        resources.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it('takes the four mock-up columns with Categories and three without', () => {
      const four = setup(buildProduct({ categories: [category] })).card.firstElementChild!;
      expect(four.className).toContain(
        'xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.15fr)]',
      );
      expect(four.children).toHaveLength(4);
      TestBed.resetTestingModule();
      const three = setup(buildProduct()).card.firstElementChild!;
      expect(three.className).toContain(
        'xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1fr)_minmax(0,1.15fr)]',
      );
      expect(three.children).toHaveLength(3);
    });

    it('shows the vendor with its size and ownership line, linked to the vendor page', () => {
      const { card } = setup(
        buildProduct({ vendor_facts: { company_size: '201-1000', ownership_type: 'subsidiary' } }),
      );
      const vendor = card.querySelector('[aria-labelledby=vendor-card-title] a')!;
      expect(vendor.getAttribute('href')).toBe('/vendors/procore');
      expect(text(vendor.querySelector('[data-testid=product-vendor-facts]'))).toBe(
        '201–1,000 employees · Subsidiary',
      );
    });

    it('says "No vendor listed" when the product has none', () => {
      const { card } = setup(buildProduct({ vendor: null }));
      expect(text(card.querySelector('[aria-labelledby=vendor-card-title] p'))).toBe(
        'No vendor listed',
      );
    });

    it('opens each resource in a new tab and records its link purpose', () => {
      const { card, analytics } = setup(
        buildProduct({
          tool_integrations_url: 'https://procore.com/integrations',
          api_docs_url: 'https://dev.procore.com',
        }),
      );
      card.addEventListener('click', (e) => e.preventDefault());
      const links = [
        ...card.querySelectorAll<HTMLAnchorElement>('[aria-labelledby=resources-label] a'),
      ];
      expect(links.map((a) => text(a.querySelector('span.flex-1')))).toEqual([
        'Integrations page',
        'API documentation',
      ]);
      for (const a of links) {
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener nofollow');
        expect(text(a.querySelector('.sr-only'))).toBe('(opens in a new tab)');
        a.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
      const purposes = analytics.externalLinkClicked.mock.calls.map(
        (c) => (c[0] as { link_purpose: string }).link_purpose,
      );
      expect(purposes).toEqual(['listing', 'docs']);
    });

    it('keeps the claim and correction entries and the claiming link', () => {
      const { card } = setup(buildProduct());
      const actions = card.querySelector('[data-testid=product-facts-actions]')!;
      const hrefs = [...actions.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual([
        '/products/procore/claim',
        '/products/procore/correction',
        '/vendor-program?vendor=procore',
      ]);
      expect(text(actions)).toContain('Claim Procore Technologies');
      expect(text(actions)).toContain('Suggest a correction');
      expect(text(actions)).toContain('Learn more about claiming');
      // "Claim" stays before "Suggest a correction" (ruled 2026-11-16).
      expect(hrefs[0]).toContain('/claim');
    });

    it('carries the group glyph on each category chip (AECI-1720 restore)', () => {
      const { card } = setup(buildProduct({ categories: [category] }));
      const chip = card.querySelector('[aria-labelledby=categories-label] .aec-chip')!;
      expect(chip.hasAttribute('data-icon')).toBe(true);
      expect(chip.querySelector('svg')).not.toBeNull();
    });

    it('points to the Integrations section with "Know of one?" only at zero', () => {
      const zero = setup(buildProduct({ integration_count: 0 })).card;
      const link = zero.querySelector<HTMLAnchorElement>('[data-testid=product-facts-know-of-one]');
      expect(link?.textContent?.trim()).toBe('Know of one?');
      expect(link?.getAttribute('href')).toBe('/products/procore#integrations');
      TestBed.resetTestingModule();
      const some = setup(buildProduct({ integration_count: 4 })).card;
      expect(some.querySelector('[data-testid=product-facts-know-of-one]')).toBeNull();
    });
  });

  describe('the logo rule', () => {
    it('renders no product logo in the card, only the 32px vendor mark', () => {
      const { card } = setup(buildProduct({ claim_status: 'unclaimed' }));
      expect(card.querySelector('img[src="https://example.com/procore.png"]')).toBeNull();
      const marks = [...card.querySelectorAll('aec-logo-or-initial')];
      expect(marks).toHaveLength(1);
      // The 32px box: h-8 w-8, with 32 as the reserved intrinsic size.
      const box = marks[0]!.firstElementChild!;
      expect(box.classList).toContain('h-8');
      expect(box.classList).toContain('w-8');
      expect(box.getAttribute('width') ?? '32').toBe('32');
    });
  });

  // AECI-1780: Audiences, Trades and Project phases moved to the About band.
  describe('the Managed group in the card', () => {
    const managed = {
      description: null,
      profile: null,
      usefulness: null,
      managed: {
        form: 'updated' as const,
        vendor_names: ['Procore Technologies'],
        date: '2026-10-03',
      },
      corrections: [],
    };

    it('holds no facet group, and no Managed caption for facets alone', () => {
      const { card } = setup(buildProduct({ audiences: [audience], captions: managed }));
      expect(card.querySelector('#audiences-label')).toBeNull();
      expect(card.querySelector('[data-testid=product-facts-facets]')).toBeNull();
      expect(card.querySelector('[data-testid=managed-caption]')).toBeNull();
    });

    it('captions the Resources links, right after Resources', () => {
      const { card } = setup(
        buildProduct({ api_docs_url: 'https://developers.procore.com/docs', captions: managed }),
      );
      const caption = card.querySelector('[data-testid=managed-caption]')!;
      expect(caption.textContent).toContain('Maintained by Procore Technologies');
      expect(caption.previousElementSibling?.getAttribute('aria-labelledby')).toBe(
        'resources-label',
      );
    });
  });
});
