/**
 * AECI-1785: the product page "Similar products" section.
 *
 * Two halves. The section on its own: copy, cards, the uniform grid and the column
 * cap by count. The page: the section and its nav link show only with a non-empty
 * `related_products`, and both come last. The order rule itself is held by the
 * ordering firewall (`[surface:product-page-similar-products]`).
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductDetail, ProductListItem } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';

import { ProductDetailPage } from './product-detail';
import { ProductSimilarProducts } from './product-similar-products';

function item(i: number, overrides: Partial<ProductListItem> = {}): ProductListItem {
  return {
    id: `00000000-0000-4000-8000-${String(500 + i).padStart(12, '0')}`,
    slug: `similar-${i}`,
    name: `Similar ${i}`,
    logo_url: null,
    product_role: 'application',
    connector_kind: null,
    vendor: null,
    integration_count: 3,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const items = (n: number) => Array.from({ length: n }, (_, i) => item(i));

@Component({
  imports: [ProductSimilarProducts],
  template: `
    <section
      aec-product-similar-products
      id="similar"
      aria-labelledby="similar-title"
      productName="Bluebeam Revu"
      [products]="products()"
    ></section>
  `,
})
class Host {
  products = signal<readonly ProductListItem[]>([]);
}

function mount(list: readonly ProductListItem[]) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.products.set(list);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  return { el, section: el.querySelector<HTMLElement>('#similar')! };
}

describe('ProductSimilarProducts', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('heads the section, names the product and states the order', () => {
    const { section } = mount(items(3));
    const h2 = section.querySelector('h2#similar-title');
    expect(h2?.textContent?.trim()).toBe('Similar products');
    expect(section.getAttribute('aria-labelledby')).toBe('similar-title');
    expect(section.textContent).toContain('Products that share a category with Bluebeam Revu.');
    expect(
      section.querySelector('[data-testid="similar-products-order"]')?.textContent?.trim(),
    ).toBe('A to Z by name.');
  });

  it('renders every product as one same-size card, with no featured lead', () => {
    const list = items(6);
    const { section } = mount(list);
    const cards = [...section.querySelectorAll('ul[role="list"] > li')];
    expect(cards).toHaveLength(6);
    for (const li of cards) {
      expect(li.className).not.toContain('col-span');
      // The card shadow, from the shared aecCard base tone.
      expect(li.querySelector('.aec-card')?.className).toContain('shadow-card');
    }
    expect(section.textContent).not.toContain('Recently added');
    const hrefs = [...section.querySelectorAll('li a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(list.map((p) => `/products/${p.slug}`));
  });

  it('shows the initial tile when the server sent no logo', () => {
    const { section } = mount([item(0, { name: 'Kroo', logo_url: null })]);
    expect(section.querySelector('img')).toBeNull();
    expect(section.textContent).toContain('K');
  });

  it.each([
    [1, '1'],
    [2, '2'],
    [3, '3'],
    [4, '2'],
    [5, '3'],
    [6, '3'],
  ])('caps a grid of %i cards at data-columns=%s', (n, expected) => {
    const { section } = mount(items(n));
    expect(section.querySelector('ul.aec-card-grid')?.getAttribute('data-columns')).toBe(expected);
  });

  it('puts a single card beside the heading from md, and stacks every other count', () => {
    expect(mount(items(1)).section.className).toContain('md:grid-cols-2');
    TestBed.resetTestingModule();
    expect(mount(items(2)).section.className).not.toContain('md:grid-cols-2');
  });
});

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    claim_status: 'claimed',
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: null,
    vendor_facts: { company_size: null, ownership_type: null },
    product_role: 'application',
    connector_kind: null,
    vendor: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    summary: null,
    description: 'Construction management platform.',
    website: null,
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
    ...overrides,
  };
}

function page(product: ProductDetail): HTMLElement {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: { productViewed: vi.fn(), externalLinkClicked: vi.fn() } },
      { provide: AuthService, useValue: { isConfigured: vi.fn(() => false), isSignedIn: vi.fn() } },
      { provide: AccountApi, useValue: { findMyReviewForProduct: vi.fn(async () => null) } },
      {
        provide: ActivatedRoute,
        useValue: { data: of({ product }), snapshot: { data: { product } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProductDetailPage);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const navIds = (el: HTMLElement): string[] =>
  [...(el.querySelector('aec-section-nav')?.querySelectorAll('a') ?? [])].map(
    (a) => a.getAttribute('href')!.split('#')[1]!,
  );

const bodyIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[slot="body"] > [id]')].map((n) => n.id);

describe('ProductDetailPage similar products (AECI-1785)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('omits the section and its nav link when the list is empty', () => {
    const el = page(buildProduct());
    expect(el.querySelector('#similar')).toBeNull();
    expect(navIds(el)).not.toContain('similar');
  });

  it('renders the section last, after Reviews, with its nav link last', () => {
    const el = page(buildProduct({ related_products: items(2) }));
    expect(bodyIds(el).at(-1)).toBe('similar');
    expect(bodyIds(el).at(-2)).toBe('reviews');
    expect(navIds(el).at(-1)).toBe('similar');
    const link = [...el.querySelectorAll('aec-section-nav a')].at(-1);
    expect(link?.textContent).toContain('Similar products');
    expect(el.querySelectorAll('#similar li')).toHaveLength(2);
  });
});
