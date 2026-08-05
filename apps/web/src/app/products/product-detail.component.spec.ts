/**
 * ProductDetailPage — hero rating cluster.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (Angular's TestBed /
 * vitest runner) rather than the node-only Vitest pass that excludes Angular DI
 * (see `apps/web/vitest.config.ts`).
 *
 * Scope: the hero rating/review meta line near the product name. It now renders
 * for every product — the published aggregate (`rating_overall_avg !== null`,
 * gated server-side at ≥5 reviews) when rated, and a "Not Yet Rated" label + live
 * review count below that threshold — plus the hero write-a-review CTA. The leaf
 * services the page's children pull in (Analytics,
 * AuthService, AccountApi) are stubbed to neutral no-ops — their own specs cover
 * them; here we only assert the hero render branch. The product is delivered via
 * a stub `ActivatedRoute`, the same channel `productDetailResolver` populates in
 * production.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IntegrationListItem, ProductDetail, ProductLink } from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';

import { ProductDetailPage } from './product-detail';

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: 'https://example.com/procore.png',
    product_role: 'application',
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: 'https://example.com/procore-logo.png',
    },
    primary_category: null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    description: 'Construction management platform.',
    website: 'https://www.procore.com',
    tool_integrations_url: null,
    api_docs_url: null,
    has_api_docs: false,
    categories: [],
    audiences: [],
    phases: [],
    trades: [],
    usefulness: null,
    integrations_as_source: [],
    integrations_as_target: [],
    integrations_as_connector: [],
    related_products: [],
    reviews: [],
    ...overrides,
  };
}

function setup(product: ProductDetail) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: { productViewed: vi.fn() } },
      // Embedded review CTA (inside ProductReviews) — keep it on the neutral,
      // no-network path; its own spec exercises the real behaviour.
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
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ProductDetailPage hero rating', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the rating in the hero when the product has an aggregate', () => {
    // The API sets both averages together (and only at ≥5 reviews); mirror that.
    const { el } = setup(
      buildProduct({ review_count: 7, rating_overall_avg: 4.2, rating_onboarding_avg: 4.0 }),
    );

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    // Stars + one-decimal score, scoped to the hero (the Reviews summary lower
    // down also renders stars — this assertion must not pick those up).
    expect(hero!.querySelector('aec-review-stars')).toBeTruthy();
    expect(hero!.textContent).toContain('4.2');
    expect(hero!.textContent).toContain('7 reviews');
    // A rated product shows the score, not the below-threshold label.
    expect(hero!.textContent).not.toContain('Not Yet Rated');

    // The count is a path-preserving jump link to the Reviews section.
    const jump = hero!.querySelector<HTMLAnchorElement>('a[href$="#reviews"]');
    expect(jump).toBeTruthy();
    expect(jump!.getAttribute('href')).toBe('/products/procore#reviews');

    // The hero also surfaces the (cache-neutral) write-a-review CTA.
    expect(hero!.querySelector('aec-review-cta')).toBeTruthy();
  });

  it('shows "Not Yet Rated" + a linked count below the rating threshold', () => {
    // 1–4 reviews: the API nulls the average, but the reviews exist — so the
    // hero shows the label + a jump-link count, with no stars and no fabricated
    // score (a single-review average is statistically misleading, §5.5).
    const { el } = setup(buildProduct({ review_count: 3, rating_overall_avg: null }));

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    expect(hero!.querySelector('aec-review-stars')).toBeNull();
    expect(hero!.textContent).toContain('Not Yet Rated');
    expect(hero!.textContent).toContain('3 reviews');

    const jump = hero!.querySelector<HTMLAnchorElement>('a[href$="#reviews"]');
    expect(jump).toBeTruthy();
    expect(jump!.getAttribute('href')).toBe('/products/procore#reviews');

    expect(hero!.querySelector('aec-review-cta')).toBeTruthy();
  });

  it('shows "No reviews yet" with no jump link at zero reviews', () => {
    const { el } = setup(buildProduct({ review_count: 0, rating_overall_avg: null }));

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    expect(hero!.querySelector('aec-review-stars')).toBeNull();
    expect(hero!.textContent).toContain('Not Yet Rated');
    expect(hero!.textContent).toContain('No reviews yet');
    // Nothing to jump to at zero reviews, so the count is plain text, not a link.
    expect(hero!.querySelector('a[href$="#reviews"]')).toBeNull();
    // The CTA still renders — the action row shows even without a website.
    expect(hero!.querySelector('aec-review-cta')).toBeTruthy();
  });
});

/**
 * Stage 1.5 Addendum B — the "Powers these integrations" hub section that makes
 * a connector product's page intelligible (its endpoint table is legitimately
 * empty because it is the mechanism, not an endpoint).
 */
describe('ProductDetailPage powered-integrations hub', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const link = (slug: string, name: string): ProductLink => ({
    id: `id-${slug}`,
    slug,
    name,
    logo_url: null,
  });

  let seq = 0;
  const edge = (source: ProductLink, target: ProductLink): IntegrationListItem => ({
    id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    name: `${source.name} ↔ ${target.name}`,
    mechanism_kind: 'iPaaS',
    mechanism_name: 'via Agave ERP Sync',
    direction: null,
    source,
    target,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
  });

  const procore = link('procore', 'Procore');
  const acumatica = link('acumatica', 'Acumatica');
  const sage = link('sage-intacct', 'Sage Intacct');

  const connector = (overrides: Partial<ProductDetail> = {}) =>
    buildProduct({
      slug: 'agave-erp-sync',
      name: 'Agave ERP Sync',
      product_role: 'connector',
      ...overrides,
    });

  it('renders hub groups with a linked hub heading and pair-page chips', () => {
    const { el } = setup(
      connector({
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );

    const section = el.querySelector('#powered-integrations');
    expect(section).toBeTruthy();
    // Heading counts EDGES, not groups.
    expect(section!.querySelector('h2')!.textContent).toContain('Powers these integrations (2)');

    const groups = section!.querySelectorAll('aec-product-powered-hub section');
    expect(groups).toHaveLength(1);
    // Procore is the more frequent endpoint on both edges → it is the hub, no
    // matter which side of the row it was authored on.
    const heading = groups[0]!.querySelector('h3')!;
    expect(heading.textContent).toContain('Connects');
    expect(heading.textContent).toContain('Procore');
    expect(heading.querySelector('a')!.getAttribute('href')).toBe('/products/procore');

    const chips = groups[0]!.querySelectorAll<HTMLAnchorElement>('ul a');
    expect([...chips].map((a) => a.textContent!.trim())).toEqual(['Acumatica', 'Sage Intacct']);
    // Chips link the CANONICAL pair page (context = alphabetically-first slug).
    expect(chips[0]!.getAttribute('href')).toBe('/products/acumatica/integrations/procore');
    expect(chips[1]!.getAttribute('href')).toBe('/products/procore/integrations/sage-intacct');
  });

  it('shows the empty state (with a correction link) for a connector with no powered edges', () => {
    const { el } = setup(connector());

    const section = el.querySelector('#powered-integrations');
    expect(section).toBeTruthy();
    expect(section!.querySelector('h2')!.textContent).toContain('Powers these integrations (0)');
    expect(section!.querySelector('aec-product-powered-hub')).toBeNull();
    expect(section!.textContent).toContain('No integrations are recorded as running');
    expect(
      section!.querySelector<HTMLAnchorElement>('a[href="/products/agave-erp-sync/correction"]'),
    ).toBeTruthy();
  });

  it('omits the section and its nav entry for an application with no powered edges', () => {
    const { el } = setup(buildProduct({ description: 'Construction management platform.' }));

    expect(el.querySelector('#powered-integrations')).toBeNull();
    const nav = el.querySelector('aec-section-nav');
    expect(nav).toBeTruthy();
    expect(nav!.textContent).not.toContain('Powers integrations');
  });

  it('still renders the section for an application that powers edges (data-driven safety net)', () => {
    const { el } = setup(buildProduct({ integrations_as_connector: [edge(procore, acumatica)] }));

    expect(el.querySelector('#powered-integrations')).toBeTruthy();
    expect(el.querySelector('aec-section-nav')!.textContent).toContain('Powers integrations');
  });

  it('badges the hero with the product role for a connector, and not for an application', () => {
    const { el } = setup(connector());
    const hero = el.querySelector('[slot="hero"]')!;
    expect(hero.querySelector('aec-role-badge')!.textContent).toContain('Connector');

    TestBed.resetTestingModule();
    const plain = setup(buildProduct());
    // The badge component self-hides for `application` — it renders no chip.
    expect(
      plain.el.querySelector('[slot="hero"]')!.querySelector('aec-role-badge')!.textContent!.trim(),
    ).toBe('');
  });
});
