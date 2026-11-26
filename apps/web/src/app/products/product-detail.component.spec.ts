/**
 * ProductDetailPage — hero rating cluster.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (Angular's TestBed /
 * vitest runner) rather than the node-only Vitest pass that excludes Angular DI
 * (see `apps/web/vitest.config.ts`).
 *
 * Scope: the hero rating/review meta line near the product name. It renders for
 * every product — the published aggregate (`rating_overall_avg !== null`, gated
 * server-side at ≥5 reviews) when rated, a "Not yet rated" chip + live review
 * count at 1–4 reviews, and the count ALONE at zero (the chip and the count said
 * the same thing twice, so the one that explains the absence survives) — plus the
 * hero write-a-review CTA. The leaf
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
import { By } from '@angular/platform-browser';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  IntegrationListItem,
  PoweredIntegrationItem,
  ProductDetail,
  ProductIntegrationItem,
  ProductLink,
} from '@aeci/shared';

import { AccountApi } from '../account/account-api';
import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';

import { SectionNav } from '../shared/section-nav/section-nav';

import { ProductDetailPage } from './product-detail';
import { trail } from '../shared/breadcrumb/breadcrumb-trail.harness';

function buildProduct(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    claim_status: 'claimed',
    id: '00000000-0000-4000-8000-000000020001',
    slug: 'procore',
    name: 'Procore',
    logo_url: 'https://example.com/procore.png',
    vendor_facts: { company_size: null, ownership_type: null },
    product_role: 'application',
    connector_kind: null,
    vendor: {
      id: '00000000-0000-4000-8000-000000010001',
      slug: 'procore',
      name: 'Procore Technologies',
      logo_url: 'https://example.com/procore-logo.png',
    },
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2024-06-01T00:00:00.000Z',
    updated_at: '2024-06-01T00:00:00.000Z',
    summary: null,
    description: 'Construction management platform.',
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
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    ...overrides,
  };
}

function setup(product: ProductDetail) {
  const analytics = { productViewed: vi.fn(), externalLinkClicked: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: Analytics, useValue: analytics },
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
  return { fixture, el: fixture.nativeElement as HTMLElement, analytics };
}

/** Click the hero's "Visit website" link without leaving the test page. */
function clickWebsite(el: HTMLElement, href: string): void {
  el.addEventListener('click', (e) => e.preventDefault());
  const anchor = el.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
  expect(anchor).toBeTruthy();
  anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

// AECI-933: the website click records whose site it leads to, the product's
// primary vendor, and the product page it came from.
describe('ProductDetailPage vendor facts line (AECI-1310)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const line = (facts: ProductDetail['vendor_facts']): string | undefined =>
    setup(buildProduct({ vendor_facts: facts }))
      .el.querySelector('[data-testid="product-vendor-facts"]')
      ?.textContent?.trim();

  it('shows size and ownership together', () => {
    expect(line({ company_size: '51-200', ownership_type: 'private' })).toBe(
      '51–200 employees · Private',
    );
  });

  it('shows whichever one exists', () => {
    expect(line({ company_size: null, ownership_type: 'nonprofit' })).toBe('Nonprofit');
  });

  it('renders no line when neither exists', () => {
    expect(line({ company_size: null, ownership_type: null })).toBeUndefined();
  });
});

describe('ProductDetailPage website click ownership (AECI-933)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("sends the primary vendor as the owner of the product's website", () => {
    const { el, analytics } = setup(buildProduct());
    clickWebsite(el, 'https://www.procore.com');
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith({
      destination: 'https://www.procore.com/',
      source: 'product_detail',
      owner_vendor_id: '00000000-0000-4000-8000-000000010001',
      link_origin: 'vendor',
      source_entity_type: 'product',
      source_entity_id: '00000000-0000-4000-8000-000000020001',
      link_purpose: 'website',
    });
  });

  it('sends a null owner for a product with no vendor', () => {
    const { el, analytics } = setup(buildProduct({ vendor: null }));
    clickWebsite(el, 'https://www.procore.com');
    expect(analytics.externalLinkClicked).toHaveBeenCalledOnce();
    expect(analytics.externalLinkClicked.mock.lastCall?.[0]).toHaveProperty(
      'owner_vendor_id',
      null,
    );
  });
});

// AECI-1569: Bing counts an empty alt as missing, so these two logos carry a real one.
describe('ProductDetailPage logo alt text (AECI-1569)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('gives the hero logo and the vendor card logo a real alt', () => {
    const { el } = setup(buildProduct());
    const alts = Array.from(el.querySelectorAll('aec-logo-or-initial img')).map((img) =>
      img.getAttribute('alt'),
    );
    expect(alts).toContain('Procore logo');
    expect(alts).toContain('Procore Technologies logo');
  });
});

// AECI-1309: the two Managed doc links, public whenever the product has a value.
describe('ProductDetailPage resources links (AECI-1309)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders no Resources group when the product has neither link', () => {
    const { el } = setup(buildProduct());
    expect(el.querySelector('#resources-label')).toBeNull();
  });

  it('renders both links, each in a new tab and tracked by purpose', () => {
    const { el, analytics } = setup(
      buildProduct({
        tool_integrations_url: 'https://www.procore.com/integrations',
        api_docs_url: 'https://developers.procore.com/docs',
      }),
    );
    expect(el.querySelector('#resources-label')?.textContent?.trim()).toBe('Resources');
    const integrations = el.querySelector<HTMLAnchorElement>(
      'a[href="https://www.procore.com/integrations"]',
    );
    expect(integrations?.textContent).toContain('Integrations page');
    expect(integrations?.getAttribute('target')).toBe('_blank');
    expect(integrations?.getAttribute('rel')).toBe('noopener nofollow');

    clickWebsite(el, 'https://developers.procore.com/docs');
    expect(analytics.externalLinkClicked).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ source: 'product_detail', link_purpose: 'docs' }),
    );
    clickWebsite(el, 'https://www.procore.com/integrations');
    expect(analytics.externalLinkClicked.mock.lastCall?.[0]).toHaveProperty(
      'link_purpose',
      'listing',
    );
  });

  it('renders only the link the product has', () => {
    const { el } = setup(buildProduct({ api_docs_url: 'https://developers.procore.com/docs' }));
    expect(el.textContent).toContain('API documentation');
    expect(el.textContent).not.toContain('Integrations page');
  });
});

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
    expect(hero!.textContent).not.toContain('Not yet rated');

    // The count is a path-preserving jump link to the Reviews section.
    const jump = hero!.querySelector<HTMLAnchorElement>('a[href$="#reviews"]');
    expect(jump).toBeTruthy();
    expect(jump!.getAttribute('href')).toBe('/products/procore#reviews');

    // The hero also surfaces the (cache-neutral) write-a-review CTA.
    expect(hero!.querySelector('aec-review-cta')).toBeTruthy();
  });

  it('shows "Not yet rated" + a linked count below the rating threshold', () => {
    // 1–4 reviews: the API nulls the average, but the reviews exist — so the
    // hero shows the label + a jump-link count, with no stars and no fabricated
    // score (a single-review average is statistically misleading, §5.5).
    const { el } = setup(buildProduct({ review_count: 3, rating_overall_avg: null }));

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    expect(hero!.querySelector('aec-review-stars')).toBeNull();
    expect(hero!.textContent).toContain('Not yet rated');
    expect(hero!.textContent).toContain('3 reviews');

    const jump = hero!.querySelector<HTMLAnchorElement>('a[href$="#reviews"]');
    expect(jump).toBeTruthy();
    expect(jump!.getAttribute('href')).toBe('/products/procore#reviews');

    expect(hero!.querySelector('aec-review-cta')).toBeTruthy();
  });

  it('says "No reviews yet" ONCE at zero reviews, with no rating chip and no jump link', () => {
    const { el } = setup(buildProduct({ review_count: 0, rating_overall_avg: null }));

    const hero = el.querySelector('[slot="hero"]');
    expect(hero).toBeTruthy();
    expect(hero!.querySelector('aec-review-stars')).toBeNull();
    expect(hero!.textContent).toContain('No reviews yet');
    // "Not yet rated · No reviews yet" said the same thing twice in two visual
    // registers. The count explains the absence, so it is the half that stays.
    expect(hero!.textContent).not.toContain('Not yet rated');
    expect(hero!.querySelector('[aria-hidden="true"]')?.textContent).not.toBe('·');
    // Nothing to jump to at zero reviews, so the count is plain text, not a link.
    expect(hero!.querySelector('a[href$="#reviews"]')).toBeNull();
    // The CTA still renders — the action row shows even without a website.
    expect(hero!.querySelector('aec-review-cta')).toBeTruthy();
  });
});

const link = (slug: string, name: string): ProductLink => ({
  id: `id-${slug}`,
  slug,
  name,
  logo_url: null,
});

let seq = 0;
const edge = (
  source: ProductLink,
  target: ProductLink,
  direction: IntegrationListItem['direction'] = null,
): PoweredIntegrationItem => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  name: `${source.name} ↔ ${target.name}`,
  mechanism_kind: 'iPaaS',
  mechanism_name: 'via Agave ERP Sync',
  direction,
  source,
  target,
  via: null,
  data_object_slugs: [],
  created_at: '2024-06-01T00:00:00.000Z',
  updated_at: '2024-06-01T00:00:00.000Z',
});

const procore = link('procore', 'Procore');
const acumatica = link('acumatica', 'Acumatica');
const sage = link('sage-intacct', 'Sage Intacct');
const vista = link('viewpoint-vista', 'Viewpoint Vista');
const bluebeam = link('bluebeam-revu', 'Bluebeam Revu');

const connector = (overrides: Partial<ProductDetail> = {}) =>
  buildProduct({
    slug: 'agave-erp-sync',
    name: 'Agave ERP Sync',
    product_role: 'connector',
    connector_kind: null,
    ...overrides,
  });

/**
 * Stage 1.5 Addendum B — the "Integrations it powers" hub section that makes
 * a connector product's page intelligible (its endpoint table is legitimately
 * empty because it is the mechanism, not an endpoint).
 */
// ── Record line (AECI-981 / STAGE_2_ATTESTATIONS_SPEC.md §13.9; AECI-1666) ──────
//
// The rendered half of the AECI-981 defect: nothing bound the API's `maintenance` object
// to this page's mount site, so a dropped input would have rendered AECi attribution
// forever. Since AECI-1666 the line opens "About this listing" instead of sitting in the
// header as a chip, and an unclaimed listing never reads "Vendor maintained".
describe('ProductDetailPage record line', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const panel = (el: HTMLElement) => el.querySelector('[data-testid="listing-provenance"]');

  it('retires the header chip', () => {
    const { el } = setup(
      buildProduct({
        maintenance: { maintained_by: 'vendor', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    expect(el.querySelector('[slot="hero"] aec-maintenance-marker')).toBeNull();
  });

  // Ruling 2026-11-17: every listing shows the panel, including one AECi maintains alone.
  it('shows the panel with the AECi record line on an AECi-only listing', () => {
    const { el } = setup(buildProduct());
    expect(panel(el)?.hasAttribute('hidden')).toBe(false);
    expect(panel(el)?.querySelector('h2')?.textContent?.trim()).toBe('About this listing');
    expect(panel(el)?.querySelector('aec-maintenance-marker')?.textContent?.trim()).toBe(
      'AEC Integrations maintained',
    );
  });

  it('adds the review date to the AECi record line when there is one', () => {
    const { el } = setup(
      buildProduct({
        maintenance: { maintained_by: 'aeci', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    expect(panel(el)?.querySelector('aec-maintenance-marker')?.textContent?.trim()).toBe(
      'AEC Integrations maintained · Reviewed September 16, 2026',
    );
  });

  it('opens the panel with the vendor line when the record has been taken over', () => {
    const { el } = setup(
      buildProduct({
        maintenance: { maintained_by: 'vendor', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
      }),
    );
    const marker = panel(el)!.querySelector('aec-maintenance-marker');
    // The verb differs by branch off the SAME column: "Updated" for a vendor,
    // "Reviewed" for AECi. Asserting the whole string is what catches a mis-bind
    // that passes the right date into the wrong branch.
    expect(marker!.textContent).toContain(
      'Vendor maintained: Procore Technologies keeps this up to date · Updated September 16, 2026',
    );
  });

  it('reads the AECi form on an unclaimed listing whatever is stored (ruling 3)', () => {
    const { el } = setup(
      buildProduct({
        claim_status: 'unclaimed',
        maintenance: { maintained_by: 'vendor', last_reviewed_at: '2026-09-16T00:00:00.000Z' },
        under_review: ['description'],
        description: null,
      }),
    );
    expect(el.textContent).not.toContain('Vendor maintained');
    expect(panel(el)!.querySelector('aec-maintenance-marker')!.textContent?.trim()).toBe(
      'AEC Integrations maintained',
    );
  });
});

describe('ProductDetailPage powered-integrations hub', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // AECI-2037: a Sync Service's section and its nav link both say "delivers".
  it('heads a Sync Service section and its nav link "Integrations it delivers"', () => {
    const { el } = setup(
      connector({
        connector_kind: 'sync_service',
        integrations_as_connector: [
          edge(procore, acumatica, 'a_to_b'),
          edge(sage, procore, 'both'),
        ],
      }),
    );
    const section = el.querySelector('#powered-integrations')!;
    expect(section.querySelector('h2')!.textContent).toContain('Integrations it delivers (2)');
    const nav = el.querySelector('aec-section-nav')!.textContent!;
    expect(nav).toContain('Integrations it delivers');
    expect(nav).not.toContain('Integrations it powers');
  });

  it('renders a hub card whose heading is the hub name, with pair-page partner rows', () => {
    const { el } = setup(
      connector({
        integrations_as_connector: [
          edge(procore, acumatica, 'a_to_b'),
          edge(sage, procore, 'both'),
        ],
      }),
    );

    const section = el.querySelector('#powered-integrations');
    expect(section).toBeTruthy();
    // Heading counts distinct PAIRS — what the section actually renders.
    expect(section!.querySelector('h2')!.textContent).toContain('Integrations it powers (2)');

    const cards = section!.querySelectorAll('aec-integration-group-card section');
    expect(cards).toHaveLength(1);
    // Procore is the more frequent endpoint on both edges → it is the hub, no
    // matter which side of the row it was authored on. The heading is now a
    // plain noun phrase, not a "Connects … with" sentence fragment.
    const heading = cards[0]!.querySelector('h3')!;
    // `LogoOrInitial`'s fallback letter sits inside the heading but is
    // aria-hidden, so it shows up in textContent and not in the accessible
    // name — assert on the link identity, which is unambiguous.
    expect(heading.textContent).toContain('Procore');
    expect(heading.textContent).not.toContain('Connects');
    // AECI-841: the heading is the disclosure button now, so the hub's own page
    // link sits beside it in the same header bar rather than inside it. A link
    // cannot nest in a button.
    expect(heading.querySelector('a')).toBeNull();
    expect(heading.querySelector('button')!.getAttribute('aria-expanded')).toBe('true');
    expect(cards[0]!.querySelector('a[href="/products/procore"]')).toBeTruthy();
    // The card header carries the group size so the count can't drift right.
    expect(cards[0]!.textContent).toContain('2 connections');

    const rows = cards[0]!.querySelectorAll<HTMLAnchorElement>('ul a');
    expect([...rows].map((a) => a.textContent!.trim())).toEqual([
      expect.stringContaining('Acumatica'),
      expect.stringContaining('Sage Intacct'),
    ]);
    // Rows link the CANONICAL pair page (context = alphabetically-first slug).
    expect(rows[0]!.getAttribute('href')).toBe('/products/acumatica/integrations/procore');
    expect(rows[1]!.getAttribute('href')).toBe('/products/procore/integrations/sage-intacct');
    // Each row has a real accessible name naming BOTH endpoints, and (AECI-1117)
    // restating the direction and mechanism the aria-label would otherwise hide.
    expect(rows[0]!.getAttribute('aria-label')).toBe(
      'View the Procore and Acumatica integration, direction Procore sends to Acumatica, iPaaS',
    );
    expect(rows[1]!.getAttribute('aria-label')).toContain(
      'direction Procore and Sage Intacct sync both ways',
    );
    // Direction is framed relative to the hub, and the mechanism is shown —
    // the same vocabulary the sibling endpoint table uses.
    expect(rows[0]!.textContent).toContain('Procore sends to Acumatica');
    expect(rows[1]!.textContent).toContain('Procore and Sage Intacct sync both ways');
    expect(rows[0]!.textContent).toContain('iPaaS');
  });

  it('renders a hubless pair as a standalone two-endpoint row instead of a one-partner hub', () => {
    const { el } = setup(
      connector({ integrations_as_connector: [edge(procore, acumatica, 'both')] }),
    );

    const section = el.querySelector('#powered-integrations')!;
    expect(section.querySelector('h2')!.textContent).toContain('Integrations it powers (1)');

    const cards = section.querySelectorAll('aec-integration-group-card section');
    expect(cards).toHaveLength(1);
    // No hub cards above it, so it is simply "Connections", not "Other".
    const hublessHeading = cards[0]!.querySelector('h3')!.textContent!;
    expect(hublessHeading).toContain('Connections');
    expect(hublessHeading).not.toContain('Other');
    expect(hublessHeading).toContain('1 connection');

    const row = cards[0]!.querySelector<HTMLAnchorElement>('ul a')!;
    expect(row.textContent).toContain('Acumatica');
    expect(row.textContent).toContain('Procore');
    expect(row.getAttribute('href')).toBe('/products/acumatica/integrations/procore');
  });

  it('never renders one product as both a hub heading and a partner row', () => {
    // The live Agave shape: deciding the hub per edge made Viewpoint Vista a
    // partner under Procore AND a hub over Sage Intacct in the same section.
    const { el } = setup(
      connector({
        integrations_as_connector: [
          edge(procore, acumatica),
          edge(procore, link('cmic', 'CMiC')),
          edge(procore, vista),
          edge(sage, vista),
        ],
      }),
    );

    const cards = el.querySelectorAll('aec-integration-group-card section');
    // Hub identity by link, not heading text (the aria-hidden fallback initial
    // is part of textContent). The trailing card is the hubless bucket, whose
    // heading is a label with no product link.
    const hubHrefs = [...cards].map(
      (c) =>
        c
          .querySelector('a[href^="/products/"]:not([href*="/integrations/"])')
          ?.getAttribute('href') ?? null,
    );
    expect(hubHrefs).toEqual(['/products/procore', null]);
    expect(cards[1]!.querySelector('h3')!.textContent).toContain('Other connections');
    // Viewpoint Vista appears once as a partner under Procore, and once inside
    // the hubless pair row — never as a competing hub heading.
    expect(hubHrefs).not.toContain('/products/viewpoint-vista');
  });

  it('shows the empty state (with a correction link) for a connector with no powered edges', () => {
    const { el } = setup(connector());

    const section = el.querySelector('#powered-integrations');
    expect(section).toBeTruthy();
    expect(section!.querySelector('h2')!.textContent).toContain('Integrations it powers (0)');
    expect(section!.querySelector('aec-integration-group-card')).toBeNull();
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
    expect(nav!.textContent).not.toContain('Integrations it powers');
  });

  it('still renders the section for an application that powers edges (data-driven safety net)', () => {
    // A THIRD-PARTY pair: `buildProduct` is Procore, and an edge naming Procore
    // as an endpoint would be a Convention-A self-reference that §13.4(2)
    // excludes (covered in its own describe below), not a powered edge.
    const { el } = setup(buildProduct({ integrations_as_connector: [edge(sage, acumatica)] }));

    expect(el.querySelector('#powered-integrations')).toBeTruthy();
    expect(el.querySelector('aec-section-nav')!.textContent).toContain('Integrations it powers');
  });

  /**
   * Catalog-scope note. Both integration lists are bounded by what is promoted
   * into the directory (an edge needs BOTH endpoints as products), so a
   * populated list systematically understates the vendor. The note states that
   * boundary on the POPULATED branch — the empty branch already hedges — and
   * appears on both sections, because caveating one would imply the other is
   * complete.
   */
  it('notes the catalog boundary under both populated integration lists', () => {
    const { el } = setup(
      connector({
        integrations_as_source: [
          {
            ...edge(procore, acumatica),
            context_direction: null,
            powered_by_product: null,
            data_object_slugs: [],
            data_objects: [],
            partner_categories: [],
            agreement: null,
          },
        ],
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );

    const endpoints = el.querySelector('#integrations')!;
    expect(endpoints.textContent).toContain('Only partners listed on AEC Integrations appear here');

    const powered = el.querySelector('#powered-integrations')!;
    expect(powered.textContent).toContain(
      'Only integrations between products listed on AEC Integrations appear here',
    );

    // Each note routes to the same correction drawer the empty states use, so
    // the caveat is a contribution loop rather than a dead disclaimer.
    for (const section of [endpoints, powered]) {
      expect(
        section.querySelector<HTMLAnchorElement>('p a[href="/products/agave-erp-sync/correction"]'),
      ).toBeTruthy();
    }
  });

  it('omits the catalog-scope note where the list is empty', () => {
    // Endpoint table empty, powered list populated: only the populated section
    // carries the note. The empty endpoint section prints no sentence at all on
    // this page (AECI-2050). The reach line keeps that section on the page (AECI-2046).
    const { el } = setup(
      connector({ integrations_as_connector: [edge(procore, acumatica)], reachable_pair_count: 3 }),
    );

    expect(el.querySelector('#integrations')!.textContent).not.toContain('Only partners listed');
    expect(el.querySelector('#powered-integrations')!.textContent).toContain(
      'Only integrations between products listed on AEC Integrations appear here',
    );
  });

  it('badges the hero with the product role for a connector, and not for an application', () => {
    const { el } = setup(connector());
    const hero = el.querySelector('[slot="hero"]')!;
    expect(hero.querySelector('aec-role-badge')!.textContent).toContain('Connector');

    TestBed.resetTestingModule();
    const plain = setup(buildProduct());
    // An application has no role chip, and since AECI-1666 retired the maintenance chip
    // that shared its row, the hero renders no kicker row for it at all.
    expect(plain.el.querySelector('[slot="hero"]')!.querySelector('aec-role-badge')).toBeNull();
  });
});

/**
 * The endpoint integrations table (`#integrations`) — the edges this product
 * TERMINATES, as opposed to the powered-hub section above. Covers the row
 * ORDER only; `ProductIntegrationRow`'s own spec covers what a row renders.
 */
describe('ProductDetailPage integrations table order', () => {
  beforeEach(() => TestBed.resetTestingModule());

  // `edge()` above is a POWERED edge (`iPaaS`, for the connector-hub specs). An
  // endpoint edge in these order tests is an ordinary accountable-party one, so
  // it overrides the kind — otherwise §13.2(c) routes every row into the unnamed
  // "Via a connector" group and the direct lane under test is empty.
  const endpointEdge = (source: ProductLink, target: ProductLink): ProductIntegrationItem => ({
    ...edge(source, target),
    mechanism_kind: 'native',
    context_direction: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: [],
    agreement: null,
  });

  /**
   * The partner name from each rendered row, in DOM order. A row carries two
   * sibling links — the trailing pair-page chevron and the partner-product
   * link (see `ProductIntegrationRow`) — and only the partner one points at a
   * bare product page.
   */
  const partnerOrder = (el: HTMLElement) =>
    [
      ...el.querySelectorAll<HTMLElement>(
        // Attribute-selected components, so the `@defer` placeholder (a bare
        // skeleton, no links) can't be mistaken for a result. Cards are the
        // default view since AECI-1782; a table row reads the same way.
        '#integrations tbody tr[aec-product-integration-row], #integrations li[aec-product-integration-card]',
      ),
    ].map((row) => {
      const partner = [...row.querySelectorAll('a')].find(
        (a) => !a.getAttribute('href')!.includes('/integrations/'),
      );
      return partner!.textContent!.trim();
    });

  it('orders rows alphabetically by partner, interleaving the source and target buckets', () => {
    // Both buckets are supplied out of alphabetical order, and the expected
    // result alternates between them (source, target, target, source) — so
    // this fails both if the sort is dropped AND if the buckets are merely
    // concatenated with each half sorted independently.
    const { el } = setup(
      buildProduct({
        integrations_as_source: [endpointEdge(procore, vista), endpointEdge(procore, acumatica)],
        integrations_as_target: [endpointEdge(sage, procore), endpointEdge(bluebeam, procore)],
      }),
    );

    expect(partnerOrder(el)).toEqual([
      'Acumatica',
      'Bluebeam Revu',
      'Sage Intacct',
      'Viewpoint Vista',
    ]);
  });

  it('breaks a repeated-partner tie on the integration name, not on DB order', () => {
    // One partner reachable by two mechanisms. Without the tail comparison
    // these two rows tie and `Array#sort` stability pins them to the arbitrary
    // order the API happened to return.
    const viaB = {
      ...endpointEdge(procore, acumatica),
      name: 'B — REST API',
      mechanism_name: 'REST bridge',
    };
    const viaA = {
      ...endpointEdge(procore, acumatica),
      name: 'A — native',
      mechanism_name: 'Native link',
    };

    const { el } = setup(
      buildProduct({
        integrations_as_source: [viaB, viaA],
        integrations_as_target: [endpointEdge(sage, procore)],
      }),
    );

    expect(partnerOrder(el)).toEqual(['Acumatica', 'Acumatica', 'Sage Intacct']);
    // Partner name and pair link are identical on both Acumatica rows, so the
    // mechanism is the only visible discriminator: `A — native` must lead.
    const rows = el.querySelectorAll('#integrations li[aec-product-integration-card]');
    expect(rows[0]!.textContent).toContain('Native link');
    expect(rows[1]!.textContent).toContain('REST bridge');
  });

  // The 21-row case below instantiates the `@defer (on viewport)` block, whose
  // trigger news up an `IntersectionObserver` unguarded (unlike our own
  // browser-only code, which checks `typeof`). jsdom has none.
  afterEach(() => vi.unstubAllGlobals());

  it('sorts before the 20-row @defer cut, so the visible rows are the alphabetical head', () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        observe = vi.fn();
        unobserve = vi.fn();
        disconnect = vi.fn();
      },
    );

    // 21 partners authored in REVERSE alphabetical order. If the slice ran
    // before the sort, "Partner 01" would land in the deferred tail.
    const partners = Array.from({ length: 21 }, (_, i) =>
      link(
        `partner-${String(21 - i).padStart(2, '0')}`,
        `Partner ${String(21 - i).padStart(2, '0')}`,
      ),
    );

    const { fixture, el } = setup(
      buildProduct({
        integrations_as_source: partners.map((partner) => endpointEdge(procore, partner)),
      }),
    );
    // AECI-1783: the card view groups a list this long, so the lane cut is read in the
    // table, which keeps it.
    [...el.querySelectorAll<HTMLButtonElement>('aec-listing-view-toggle button')]
      .find((b) => b.textContent?.includes('Table'))!
      .click();
    fixture.detectChanges();

    // Only the undeferred head renders here — `@defer (on viewport)` never
    // triggers in this harness — which is exactly the boundary under test.
    const rendered = partnerOrder(el);
    expect(rendered).toHaveLength(20);
    expect(rendered[0]).toBe('Partner 01');
    expect(rendered.at(-1)).toBe('Partner 20');
  });
});

/**
 * The endpoint Integrations section SPLIT into lanes — Stage 1.5 Addendum C
 * §13.3. `connector-lane-grouping.spec.ts` covers the routing and collapse
 * rules as pure functions; this covers what the split RENDERS: one table per
 * lane, the linked group heading, the sub-counts, and the single scope note.
 */
describe('ProductDetailPage integrations lanes (§13.3)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const agave = link('agave-erp-sync', 'Agave ERP Sync');

  const endpointEdge = (
    source: ProductLink,
    target: ProductLink,
    overrides: Partial<ProductIntegrationItem> = {},
  ): ProductIntegrationItem => ({
    ...edge(source, target),
    mechanism_kind: 'native',
    context_direction: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: [],
    agreement: null,
    ...overrides,
  });

  /** One named container per lane: a card list in the default view (AECI-1782), a
   *  table in the table view. The naming rule is the same for both. */
  const tables = (el: HTMLElement) => [
    ...el.querySelectorAll<HTMLElement>(
      '#integrations table, #integrations [data-testid="integration-cards"]',
    ),
  ];

  it('renders ONE unheaded table when nothing is connector-delivered', () => {
    // The overwhelmingly common page: zero visual churn from the split.
    const { el } = setup(
      buildProduct({
        integrations_as_source: [endpointEdge(procore, acumatica)],
      }),
    );

    const rendered = tables(el);
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.getAttribute('aria-label')).toBe('Integrations');
    // No lane heading: the cards' own h3s are the partners, not lanes (AECI-1782).
    expect(el.querySelectorAll('#integrations aec-integration-group-card')).toHaveLength(0);
  });

  it('renders one table PER LANE, direct first, each with an accessible name', () => {
    // One <table> per lane is the accessibility requirement (§13.3): a group
    // header row inside a shared <tbody> has no name relationship to the rows
    // under it, so the grouping would exist visually and not at all otherwise.
    const { el } = setup(
      buildProduct({
        integrations_as_source: [
          endpointEdge(procore, acumatica),
          endpointEdge(procore, sage, { via: agave }),
        ],
      }),
    );

    const rendered = tables(el);
    expect(rendered).toHaveLength(2);
    // Every lane table is named, and by its own heading rather than a duplicated
    // string — so heading and table can never drift apart.
    for (const table of rendered) {
      const id = table.getAttribute('aria-labelledby');
      expect(id).toBeTruthy();
      expect(el.querySelector(`#${id}`)).toBeTruthy();
    }
    expect(rendered[0]!.getAttribute('aria-labelledby')).toBe('integrations-direct');
    expect(rendered[1]!.getAttribute('aria-labelledby')).toBe('integrations-via-agave-erp-sync');
  });

  it('links the connector name in the "Via {connector}" heading', () => {
    // The return path into the Addendum B hub — §12.3's linked hub heading
    // pointing the other way.
    const { el } = setup(
      buildProduct({
        integrations_as_source: [endpointEdge(procore, sage, { via: agave })],
      }),
    );

    const heading = el.querySelector('#integrations-via-agave-erp-sync')!;
    expect(heading.textContent).toContain('Via Agave ERP Sync');
    // AECI-841: the heading became the disclosure button, so the connector link
    // moved to the same header bar beside it. The return path survives; only
    // the element carrying the name changed.
    expect(heading.querySelector('a')).toBeNull();
    const linkEl = heading.parentElement!.querySelector('a')!;
    expect(linkEl.getAttribute('href')).toBe('/products/agave-erp-sync');
    // AECI-1125: an ordinary in-app link. It stays in the tab, so it carries no
    // target and its name no longer announces a new tab.
    expect(linkEl.hasAttribute('target')).toBe(false);
    expect(linkEl.hasAttribute('rel')).toBe(false);
    expect(linkEl.getAttribute('aria-label')).toBe('View product: Agave ERP Sync');
  });

  it('heads the unnamed group without inventing a connector name (§13.2(c))', () => {
    // `iPaaS` with no `powered_by`, because the connector has no product row. 53
    // production rows on 2026-08-31 while AECI-700 parked Zapier and Workato; 7 on
    // 2026-09-24, after AECI-1064 reversed the park (Make, n8n, Boomi and others).
    const { el } = setup(
      buildProduct({
        integrations_as_source: [endpointEdge(procore, sage, { mechanism_kind: 'iPaaS' })],
      }),
    );

    const heading = el.querySelector('#integrations-via-')!;
    expect(heading.textContent).toContain('Via a connector');
    expect(heading.querySelector('a')).toBeNull();
    // NEVER invent a name, and never link one either.
    expect(heading.parentElement!.querySelector('a')).toBeNull();
  });

  it('keeps a Convention-A self-reference in the direct lane (§13.2(a))', () => {
    // Without clause (a) this renders a group whose only partner IS the
    // connector: "Via Aquifer → Aquifer".
    const { el } = setup(
      buildProduct({
        integrations_as_target: [
          endpointEdge(procore, agave, { mechanism_kind: 'iPaaS', powered_by_product: agave }),
        ],
      }),
    );

    expect(tables(el)).toHaveLength(1);
    expect(el.querySelectorAll('#integrations aec-integration-group-card')).toHaveLength(0);
  });

  it('sums the sub-counts to the section heading count', () => {
    const { el } = setup(
      buildProduct({
        integrations_as_source: [
          endpointEdge(procore, acumatica),
          endpointEdge(procore, vista),
          endpointEdge(procore, sage, { via: agave }),
        ],
      }),
    );

    // The heading carries no count (ruled 2026-11-16).
    expect(el.querySelector('#integrations-title')!.textContent!.trim()).toBe('Integrations');
    expect(el.querySelector('#integrations-direct')!.textContent).toContain('2 integrations');
    expect(el.querySelector('#integrations-via-agave-erp-sync')!.textContent).toContain(
      '1 integration',
    );
  });

  it('counts COLLAPSED Via rows, so the heading matches what a reader can count', () => {
    // Two edges, one (connector, partner) — one row. A heading of 2 over one
    // visible row is the failure §13.3's rule exists to prevent.
    const { el } = setup(
      buildProduct({
        integrations_as_source: [
          endpointEdge(procore, sage, { via: agave, name: 'A' }),
          endpointEdge(procore, sage, { via: agave, name: 'B' }),
        ],
      }),
    );

    // The heading carries no count (ruled 2026-11-16).
    expect(el.querySelector('#integrations-title')!.textContent!.trim()).toBe('Integrations');
    expect(
      el.querySelectorAll(
        '#integrations tbody tr[aec-product-integration-row], #integrations li[aec-product-integration-card]',
      ),
    ).toHaveLength(1);
  });

  it('renders the §12.7 catalog-scope note ONCE, not once per lane', () => {
    const { el } = setup(
      buildProduct({
        integrations_as_source: [
          endpointEdge(procore, acumatica),
          endpointEdge(procore, sage, { via: agave }),
          endpointEdge(procore, vista, { mechanism_kind: 'iPaaS' }),
        ],
      }),
    );

    const section = el.querySelector('#integrations')!;
    expect(
      section.textContent!.match(/Only partners listed on AEC Integrations appear here/g),
    ).toHaveLength(1);
  });

  it('keeps ONE anchor and one section-nav entry across the split', () => {
    // "One section, two lanes, one anchor, so no link, sitemap or cache-tag
    // churn" (§13.3).
    const { el } = setup(
      buildProduct({
        integrations_as_source: [
          endpointEdge(procore, acumatica),
          endpointEdge(procore, sage, { via: agave }),
        ],
      }),
    );

    expect(el.querySelectorAll('#integrations')).toHaveLength(1);
    expect(navIds(el).filter((id) => id === 'integrations')).toEqual(['integrations']);
  });
});

describe('ProductDetailPage taxonomy chips (AECI-544)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const link = (slug: string, name: string) => ({
    id: `id-${slug}`,
    slug,
    name,
  });

  it('renders a Trades section linking each tag to its browse page', () => {
    const { el } = setup(
      buildProduct({
        trades: [link('electrical', 'Electrical'), link('plumbing', 'Plumbing')],
      }),
    );

    const section = el.querySelector('section[aria-labelledby="trades-label"]');
    expect(section).toBeTruthy();
    expect(section!.querySelector('#trades-label')!.textContent!.trim()).toBe('Trades');
    expect(section!.querySelector('a[href="/trades/electrical"]')).toBeTruthy();
    // Chips are never gated on the publication floor — a sub-floor term is a
    // true tag, so it still links (TRADES_VOCABULARY.md §6).
    expect(section!.querySelector('a[href="/trades/plumbing"]')).toBeTruthy();
  });

  it('omits the Trades section entirely when the product carries none', () => {
    // The common case: trades are sparse by design, and horizontal platforms
    // must never be tagged.
    const { el } = setup(buildProduct({ trades: [] }));

    expect(el.querySelector('section[aria-labelledby="trades-label"]')).toBeNull();
    expect(el.querySelector('a[href^="/trades/"]')).toBeNull();
  });
});

/**
 * The Actions-sidebar claim CTA is stateless (AECI-1266). Every listing reads
 * "Claim Vendor" (AECI-1925; the company name visually hidden after it, AECI-1365: a claim is on the company) with no note, whatever plan the built-by vendor holds: a
 * state-dependent wording told visitors which vendors pay. It opens the same
 * `kind:'claim'` request for a first claim and for a colleague joining an account
 * someone already holds. Seats are admin-granted and multi-seat
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11), so the claim form stays the only route
 * in for a second person at the vendor.
 */
describe('ProductDetailPage claim CTA', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const actions = (el: HTMLElement) =>
    el.querySelector('[data-testid="product-facts-actions"]') as HTMLElement;

  it("always offers to claim the product's company, with no note", () => {
    const { el } = setup(buildProduct());
    const section = actions(el);

    expect(section.textContent?.replace(/\s+/g, ' ')).toContain(
      'Claim Vendor Procore Technologies',
    );
    expect(
      section.querySelector('a[href="/products/procore/claim"] .sr-only')?.textContent?.trim(),
    ).toBe('Procore Technologies');
    expect(section.textContent).not.toContain('Claim this listing');
    expect(section.textContent).not.toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Already managed through an active vendor account');
    // AECI-1131: the vendor card no longer carries the account label.
    expect(el.querySelector('aec-vendor-account-badge')).toBeNull();

    const cta = section.querySelector<HTMLAnchorElement>('a[href="/products/procore/claim"]');
    expect(cta).toBeTruthy();
  });

  it('falls back to "Claim your company" when the product has no vendor at all', () => {
    // `ProductDetail.vendor` is nullable (no DB constraint forces one).
    const { el } = setup(buildProduct({ vendor: null }));
    const section = actions(el);

    expect(section.textContent).toContain('Claim your company');
    expect(section.textContent).not.toContain('Already managed through an active vendor account');
  });

  // AECI-1283 (`VENDOR_PROGRAM_PAGE_SPEC.md` §2.4): the vendor landing page sits
  // beside the claim CTA. It is the same for every visitor and every plan, so it
  // stays in the cached HTML.
  // It explains claiming rather than claiming, so it must not read like a second
  // claim button. It opens a new tab so the visitor can come back to claim, and it
  // names the vendor so the page's claim dialog skips the search.
  it('links "Learn more about claiming" to /vendor-program?vendor= in a new tab', () => {
    const { el } = setup(buildProduct());
    const link = actions(el).querySelector<HTMLAnchorElement>(
      '[data-testid="product-vendor-program-link"]',
    );
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe('/vendor-program?vendor=procore');
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener');
    expect(link!.textContent).toContain('Learn more about claiming');
    expect(link!.textContent).toContain('opens in a new tab');
  });

  it('links to /vendor-program with no vendor param when the product has no vendor', () => {
    const { el } = setup(buildProduct({ vendor: null }));
    const link = actions(el).querySelector<HTMLAnchorElement>(
      '[data-testid="product-vendor-program-link"]',
    );
    expect(link!.getAttribute('href')).toBe('/vendor-program');
  });
});

/**
 * Stage 1.5 Addendum C §13.6 (AECI-707) — the role-varied template: section
 * order, the hero reach line, and the §13.4(2) self-exclusion that decides
 * whether the powered section renders at all.
 */
// Both body slots, in document order. The page splits its body across
// `body-lead` (About, which must stay above the metadata panel when
// DetailLayout is single-column) and `body` (everything after it), so a
// `[slot="body"]`-only sweep would silently drop `#about` from the order this
// spec exists to pin. querySelectorAll returns document order, not selector
// order, so the two slots come back interleaved correctly.
const bodySectionIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[slot="body-lead"] > [id], [slot="body"] > [id]')].map((n) => n.id);

const navIds = (el: HTMLElement): string[] => {
  const nav = el.querySelector('aec-section-nav');
  if (!nav) return [];
  return [...nav.querySelectorAll<HTMLAnchorElement>('a')].map(
    (a) => a.getAttribute('href')!.split('#')[1]!,
  );
};

/** A Convention-A edge (§13.2a): the page product is itself an endpoint. */
const selfEdge = (partner: ProductLink, self: ProductLink) => edge(partner, self);

describe('ProductDetailPage role-varied section order (§13.6)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('leads with the powered section on a connector that has one', () => {
    // An endpoint row of its own keeps #integrations on the page (AECI-2046).
    const { el } = setup(
      connector({
        integrations_as_source: [
          {
            ...edge(procore, acumatica),
            context_direction: null,
            powered_by_product: null,
            data_object_slugs: [],
            data_objects: [],
            partner_categories: [],
            agreement: null,
          },
        ],
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );

    // Real DOM order, not CSS order: this is what screen readers and crawlers
    // read, and it is why the section is placed by an ngTemplateOutlet.
    expect(bodySectionIds(el)).toEqual([
      'about',
      'powered-integrations',
      'integrations',
      'reviews',
    ]);
    // §13.6: "section-nav follows render order".
    expect(navIds(el)).toEqual(['about', 'powered-integrations', 'integrations', 'reviews']);
    // Anchor ids are unchanged, so no link / sitemap / cache-tag churn.
    expect(el.querySelector('#powered-integrations')).toBeTruthy();
    expect(el.querySelector('#integrations')).toBeTruthy();
  });

  it('keeps today order for a hybrid, even with powered edges', () => {
    // There are exactly two hybrids catalog-wide, and AnyWare Apps is half
    // first-party native apps; swapping would demote its own product surface.
    const { el } = setup(
      connector({
        product_role: 'hybrid',
        connector_kind: null,
        integrations_as_source: [
          {
            ...edge(procore, acumatica),
            context_direction: null,
            powered_by_product: null,
            data_object_slugs: [],
            data_objects: [],
            partner_categories: [],
            agreement: null,
          },
        ],
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );

    expect(bodySectionIds(el)).toEqual([
      'about',
      'integrations',
      'powered-integrations',
      'reviews',
    ]);
    expect(navIds(el)).toEqual(['about', 'integrations', 'powered-integrations', 'reviews']);
  });

  it('keeps today order for an application that powers edges', () => {
    // Third-party pair, for the same reason as the safety-net case above.
    const { el } = setup(
      buildProduct({ integrations_as_connector: [edge(sage, acumatica)], reachable_pair_count: 1 }),
    );

    expect(bodySectionIds(el)).toEqual([
      'about',
      'integrations',
      'powered-integrations',
      'reviews',
    ]);
  });

  it('does not swap a connector whose powered section is empty', () => {
    // Nothing to lead with, so leading with it would put an empty state at the
    // top of the page.
    const { el } = setup(connector());

    expect(bodySectionIds(el)).toEqual([
      'about',
      'integrations',
      'powered-integrations',
      'reviews',
    ]);
  });
});

describe('ProductDetailPage self-exclusion (§13.4(2))', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const agave = link('agave-erp-sync', 'Agave ERP Sync');

  it('drops a Convention-A edge from the powered section, count included', () => {
    const { el } = setup(
      connector({
        integrations_as_connector: [
          selfEdge(procore, agave),
          edge(sage, acumatica),
          edge(sage, vista),
        ],
      }),
    );

    const section = el.querySelector('#powered-integrations')!;
    // Two third-party pairs render; the self-referencing edge does not, so it
    // cannot appear here AND in #integrations for the same fact.
    expect(section.querySelector('h2')!.textContent).toContain('Integrations it powers (2)');
    expect(section.textContent).not.toContain('Agave ERP Sync');
  });

  it('suppresses the section and its nav entry when self-exclusion empties it', () => {
    // The live Aquifer / Kroo shape: every powered edge is Convention A, so the
    // same edges are already rendered by the endpoint table. An empty state here
    // would contradict the hero line directly above it.
    const { el } = setup(
      connector({
        integrations_as_connector: [
          selfEdge(procore, agave),
          selfEdge(acumatica, agave),
          selfEdge(sage, agave),
        ],
        // A Convention-A edge carries its own endpoint as `powered_by`, which is
        // what §13.2(a) reads to keep it in the DIRECT lane — so these render
        // here once, and never as a "Via Agave ERP Sync → Agave ERP Sync" group.
        integrations_as_target: [
          {
            ...selfEdge(procore, agave),
            context_direction: null,
            powered_by_product: agave,
            data_object_slugs: [],
            data_objects: [],
            partner_categories: [],
            agreement: null,
          },
          {
            ...selfEdge(acumatica, agave),
            context_direction: null,
            powered_by_product: agave,
            data_object_slugs: [],
            data_objects: [],
            partner_categories: [],
            agreement: null,
          },
          {
            ...selfEdge(sage, agave),
            context_direction: null,
            powered_by_product: agave,
            data_object_slugs: [],
            data_objects: [],
            partner_categories: [],
            agreement: null,
          },
        ],
      }),
    );

    expect(el.querySelector('#powered-integrations')).toBeNull();
    expect(navIds(el)).not.toContain('powered-integrations');
    expect(el.querySelector('aec-section-nav')!.textContent).not.toContain(
      'Integrations it powers',
    );
    // The endpoint table carries every one of those edges, so the page still
    // answers "what does this connect".
    expect(el.querySelector('#integrations')!.querySelector('h2')!.textContent!.trim()).toBe(
      'Integrations',
    );
    expect(el.querySelectorAll('#integrations li[aec-product-integration-card]')).toHaveLength(3);
  });

  it('keeps the empty state for a connector that genuinely powers nothing', () => {
    // Extractus / MYOB 0link: nothing was excluded, so "no record of it powering
    // anything" is a true claim worth inviting a correction for.
    const { el } = setup(connector());

    const section = el.querySelector('#powered-integrations')!;
    expect(section.textContent).toContain('No integrations are recorded as running');
    expect(navIds(el)).toContain('powered-integrations');
  });
});

describe('ProductDetailPage hero reach line (§13.6)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const agave = link('agave-erp-sync', 'Agave ERP Sync');

  it('counts distinct endpoint products, not pairs', () => {
    const { el } = setup(
      connector({
        integrations_as_connector: [
          edge(procore, acumatica),
          edge(procore, sage),
          edge(procore, vista),
        ],
      }),
    );

    // Four distinct products across three pairs.
    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 4 products in the AEC Integrations catalog',
    );
  });

  it('reports reach for a Convention-A connector whose powered section is suppressed', () => {
    // The number the grouped view cannot give: the hero reads the RAW edge list
    // minus the page product, so 4 distinct endpoints become 3 rather than 0.
    const { el } = setup(
      connector({
        integrations_as_connector: [
          selfEdge(procore, agave),
          selfEdge(acumatica, agave),
          selfEdge(sage, agave),
        ],
      }),
    );

    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 3 products in the AEC Integrations catalog',
    );
    expect(el.querySelector('#powered-integrations')).toBeNull();
  });

  it('singularizes at one product', () => {
    const { el } = setup(connector({ integrations_as_connector: [selfEdge(procore, agave)] }));

    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 1 product in the AEC Integrations catalog',
    );
  });

  it('renders nothing at zero, on a connector or an application', () => {
    for (const product of [connector(), buildProduct()]) {
      const { el } = setup(product);
      // The pair finder's "Connects to" label (AECI-1787) is not the reach line.
      expect(el.querySelector('[slot="hero"]')!.textContent).not.toMatch(/Connects \d/);
      TestBed.resetTestingModule();
    }
  });
});

/**
 * AECI-2051: the payload shape the API sends. `integrations_as_connector` is the raw
 * powered list (§13.4(2)), so a Convention-A edge arrives in an endpoint bucket AND in
 * the connector bucket, with the same id. The page must show it once.
 */
describe('ProductDetailPage with the raw powered list (§13.4(2), AECI-2051)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const agave = link('agave-erp-sync', 'Agave ERP Sync');

  /** The endpoint-bucket form of a Convention-A edge: same id, powered by the page product. */
  const asEndpointRow = (e: PoweredIntegrationItem): ProductIntegrationItem => ({
    ...e,
    context_direction: null,
    powered_by_product: agave,
    data_objects: [],
    partner_categories: [],
    agreement: null,
  });

  /** Every pair-page link in the two integration sections, as an unordered pair key. */
  const pairLinks = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLAnchorElement>('#integrations a, #powered-integrations a')].flatMap(
      (a) => {
        const m = (a.getAttribute('href') ?? '').match(
          /^\/products\/([^/]+)\/integrations\/([^/?#]+)/,
        );
        return m ? [[m[1]!, m[2]!].sort().join('::')] : [];
      },
    );

  it('shows the hero line and no false empty state when every edge is a self-reference', () => {
    // The Aquifer and Kroo shape, as the API sends it.
    const selfEdges = [selfEdge(procore, agave), selfEdge(acumatica, agave), selfEdge(sage, agave)];
    const { el } = setup(
      connector({
        integration_count: 3,
        integrations_as_target: selfEdges.map(asEndpointRow),
        integrations_as_connector: selfEdges,
      }),
    );

    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 3 products in the AEC Integrations catalog',
    );
    // §12.3 branch 2: the edges are listed under Integrations, so the page must not say
    // nothing runs on this connector.
    expect(el.textContent).not.toContain('No integrations are recorded as running');
    expect(el.querySelector('#powered-integrations')).toBeNull();
    expect(navIds(el)).not.toContain('powered-integrations');
    expect(el.querySelectorAll('#integrations li[aec-product-integration-card]')).toHaveLength(3);
  });

  it('renders no pair twice when self-references and third-party pairs arrive together', () => {
    const selfEdges = [selfEdge(procore, agave), selfEdge(acumatica, agave)];
    const { el } = setup(
      connector({
        integration_count: 4,
        integrations_as_target: selfEdges.map(asEndpointRow),
        integrations_as_connector: [...selfEdges, edge(sage, acumatica), edge(sage, vista)],
      }),
    );

    expect(pairLinks(el).sort()).toEqual(
      [
        'acumatica::agave-erp-sync',
        'agave-erp-sync::procore',
        'acumatica::sage-intacct',
        'sage-intacct::viewpoint-vista',
      ].sort(),
    );
    // The self-references are endpoint rows only. The powered section never names the
    // page product.
    expect(el.querySelectorAll('#integrations li[aec-product-integration-card]')).toHaveLength(2);
    const powered = el.querySelector('#powered-integrations')!;
    expect(powered.querySelector('h2')!.textContent).toContain('Integrations it powers (2)');
    expect(powered.textContent).not.toContain('Agave ERP Sync');
    // Reach counts products: Procore, Acumatica, Sage Intacct and Viewpoint Vista.
    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 4 products in the AEC Integrations catalog',
    );
  });

  it('leaves a connector with only third-party pairs as it was', () => {
    const { el } = setup(
      connector({
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );

    const powered = el.querySelector('#powered-integrations')!;
    expect(powered.querySelector('h2')!.textContent).toContain('Integrations it powers (2)');
    expect(pairLinks(el).sort()).toEqual(['acumatica::procore', 'procore::sage-intacct']);
    expect(el.textContent).not.toContain('No integrations are recorded as running');
    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 3 products in the AEC Integrations catalog',
    );
    // Still leads the page (§13.6).
    expect(bodySectionIds(el).slice(0, 2)).toEqual(['about', 'powered-integrations']);
  });
});

describe('ProductDetailPage extensions (§13.3b / AECI-710)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const listItem = (slug: string, name: string) => ({
    ...buildProduct(),
    id: 'p-' + slug,
    slug,
    name,
  });

  it('puts "Built within" in the facts card, directly under Vendor', () => {
    const { el } = setup(buildProduct({ extension_of: [listItem('salesforce', 'Salesforce')] }));
    const metadata = el.querySelector('[slot="metadata"]')!;
    // AECI-1779: Vendor and Built within share the card's vendor column, in that order.
    const groups = [...metadata.querySelectorAll('section[aria-labelledby]')].map((s) =>
      s.getAttribute('aria-labelledby'),
    );

    expect(groups.slice(0, 2)).toEqual(['vendor-card-title', 'built-within-title']);
    const vendor = metadata.querySelector('[aria-labelledby="vendor-card-title"]')!;
    expect(vendor.nextElementSibling?.getAttribute('aria-labelledby')).toBe('built-within-title');
    expect(el.querySelector('[slot="body"] [aec-product-built-within]')).toBeNull();
  });

  it('lists extensions after every integrations section and before Reviews, with a nav entry', () => {
    const { el } = setup(
      buildProduct({
        description: 'Construction management platform.',
        extensions: [listItem('extractus', 'Extractus')],
      }),
    );

    const order = bodySectionIds(el);
    expect(order.indexOf('extensions')).toBe(order.indexOf('reviews') - 1);
    expect(order.indexOf('extensions')).toBeGreaterThan(order.indexOf('integrations'));
    expect(navIds(el)).toContain('extensions');
    expect(navIds(el).indexOf('extensions')).toBe(navIds(el).indexOf('reviews') - 1);
  });

  it('never renders an extension inside #integrations, and leaves its count alone', () => {
    const { el } = setup(
      buildProduct({
        integration_count: 0,
        extensions: [listItem('extractus', 'Extractus')],
        extension_of: [listItem('salesforce', 'Salesforce')],
      }),
    );
    const integrations = el.querySelector('#integrations')!;

    expect(integrations.textContent).not.toContain('Extractus');
    // The host appears once, in the empty state's pointer sentence, never as a
    // row or a link into the integrations list.
    expect(integrations.querySelector('table')).toBeNull();
    expect(integrations.querySelector('a[href="/products/salesforce"]')).toBeNull();
    expect(integrations.textContent).toContain('Procore runs inside Salesforce; see Built within.');
    expect(integrations.querySelector('h2')!.textContent).not.toMatch(/[1-9]/);
  });

  it('omits both sections and the nav entry for a product with no extension rows', () => {
    const { el } = setup(buildProduct({ description: 'Construction management platform.' }));

    expect(el.querySelector('[aec-product-built-within]')).toBeNull();
    expect(el.querySelector('#extensions')).toBeNull();
    expect(navIds(el)).not.toContain('extensions');
  });
});

describe('ProductDetailPage unclaimed wording (AECI-1618)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const WORDING = 'Unclaimed · not affiliated with or endorsed by this vendor';

  it('puts the wording directly beside a small logo on an unclaimed listing', () => {
    const { fixture } = setup(
      buildProduct({ claim_status: 'unclaimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const note = el.querySelector('aec-unclaimed-note');
    expect(note?.textContent?.trim()).toBe(WORDING);
    const logo = note?.previousElementSibling;
    expect(logo?.tagName.toLowerCase()).toBe('aec-logo-or-initial');
    expect(logo?.querySelector('img')?.getAttribute('width')).toBe('32');
  });

  // AECI-1769: the subject's logo renders once, in the slot beside the note, and the
  // claimed-only 64px slot never shows it.
  it('renders an unclaimed product logo only beside the note', () => {
    const LOGO = 'https://cdn.example.com/a.png';
    const { fixture } = setup(buildProduct({ claim_status: 'unclaimed', logo_url: LOGO }));
    const el = fixture.nativeElement as HTMLElement;
    const imgs = [...el.querySelectorAll('img')].filter((i) => i.getAttribute('src') === LOGO);
    expect(imgs).toHaveLength(1);
    expect(imgs[0]!.closest('aec-logo-or-initial')?.nextElementSibling?.tagName).toBe(
      'AEC-UNCLAIMED-NOTE',
    );
  });

  it('shows the wording with no logo', () => {
    const { fixture } = setup(buildProduct({ claim_status: 'unclaimed', logo_url: null }));
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('aec-unclaimed-note')?.textContent,
    ).toContain(WORDING);
  });

  // AECI-1778: the claimed logo moved into the hero band's 104px mark slot.
  it('keeps the hero logo and adds no wording on a claimed listing', () => {
    const { fixture } = setup(
      buildProduct({ claim_status: 'claimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-unclaimed-note')).toBeNull();
    const mark = el.querySelector('[data-testid=product-hero-mark]');
    expect(mark?.closest('.aec-hero-band')).not.toBeNull();
    expect(mark?.querySelector('img')?.getAttribute('width')).toBe('104');
  });

  // AECI-1778 with the logo rule (AECI-1769): the 104px mark is the initial tile for an
  // unclaimed product, even when the payload holds its logo. The note keeps its words.
  it('shows the initial tile in the hero mark for an unclaimed listing', () => {
    const { fixture } = setup(
      buildProduct({ claim_status: 'unclaimed', logo_url: 'https://cdn.example.com/a.png' }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const mark = el.querySelector('[data-testid=product-hero-mark]')!;
    expect(mark.querySelector('img')).toBeNull();
    expect(mark.querySelector('span[aria-hidden=true]')?.textContent?.trim()).toBe('P');
    const note = el.querySelector('.aec-hero-band aec-unclaimed-note')!;
    expect(note.textContent?.trim()).toBe(WORDING);
    // Bone-secondary on Forest, never the light-ground grey.
    expect(note.classList.contains('text-(--text-on-brand-secondary)')).toBe(true);
    expect(note.classList.contains('text-(--text-secondary)')).toBe(false);
  });
});

// AECI-2012 (Chris, 2026-11-23): the ruling 41 trial tag is out of the sticky bar. The page no
// longer hands the bar a claim status. An unclaimed listing keeps the full Unclaimed note in the
// hero, under the name. A claimed listing shows neither.
describe('ProductDetailPage Unclaimed marking: the hero note, never the bar (AECI-2012)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const marking = (product: ProductDetail) => {
    const { fixture, el } = setup(product);
    const nav = fixture.debugElement.query(By.directive(SectionNav));
    expect(nav).not.toBeNull();
    const navEl = nav.nativeElement as HTMLElement;
    return {
      barTakesClaim: 'claimStatus' in (nav.componentInstance as object),
      barSaysUnclaimed: (navEl.textContent ?? '').includes('Unclaimed'),
      heroNote: el.querySelector('aec-unclaimed-note') !== null,
    };
  };

  it('an unclaimed listing shows the note in the hero and nothing in the bar', () => {
    const r = marking(
      buildProduct({ claim_status: 'unclaimed', description: 'Construction management.' }),
    );
    expect(r).toEqual({ barTakesClaim: false, barSaysUnclaimed: false, heroNote: true });
  });

  it('a claimed listing shows no Unclaimed marking anywhere', () => {
    const r = marking(
      buildProduct({ claim_status: 'claimed', description: 'Construction management.' }),
    );
    expect(r).toEqual({ barTakesClaim: false, barSaysUnclaimed: false, heroNote: false });
  });
});

// AECI-1666: every caption and correction moved into one "About this listing" panel.
describe('ProductDetailPage provenance panel (AECI-1666)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const updated = (name: string) => ({
    form: 'updated' as const,
    vendor_names: [name],
    date: '2026-10-04T00:00:00.000Z',
  });
  const term = (slug: string) => ({
    id: '00000000-0000-4000-8000-000000000001',
    slug,
    name: slug.toUpperCase(),
  });
  const CAPTIONS = {
    description: null,
    profile: null,
    usefulness: null,
    managed: null,
    corrections: [],
  };
  const correction = (field: string, source_url: string | null = null, cleared = false) => ({
    field,
    date: '2026-09-15T00:00:00.000Z',
    source_url,
    cleared,
  });
  const lines = (el: Element | null, id: string) =>
    Array.from(el?.querySelectorAll(`[data-testid="${id}"]`) ?? []).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );
  const panel = (el: HTMLElement) => el.querySelector('[data-testid="listing-provenance"]')!;

  // The band shell has no sidebar (AECI-1778), so both copies sit in the last body band:
  // the card from lg, the closed disclosure below it. Neither is in the facts card.
  it('mounts one card and one disclosure as the last body band, one test id', () => {
    const { el } = setup(
      buildProduct({ captions: { ...CAPTIONS, description: updated('Procore Technologies') } }),
    );
    const copies = el.querySelectorAll('aec-listing-provenance');
    expect(copies).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="listing-provenance"]')).toHaveLength(1);
    const band = el.querySelector('[data-testid="listing-provenance-band"]')!;
    expect(band.parentElement?.lastElementChild).toBe(band);
    expect(band.closest('[data-testid="product-body-bands"]')).not.toBeNull();
    expect(panel(el).closest('aside')).toBeNull();
    expect(panel(el).querySelector('h2')?.textContent?.trim()).toBe('About this listing');
    const disclosure = Array.from(copies).find((c) => c !== panel(el))!;
    expect(disclosure.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(disclosure.closest('[data-testid="listing-provenance-band"]')).toBe(band);
  });

  it('renders no inline caption anywhere outside the panel', () => {
    const { el } = setup(
      buildProduct({
        categories: [term('c')],
        trades: [term('t')],
        usefulness: { audiences: [{ slug: 'a', name: 'A', points: ['One'] }], phases: [] },
        usefulness_source: 'vendor',
        captions: {
          description: updated('Procore Technologies'),
          profile: updated('Procore Technologies'),
          usefulness: updated('Procore Technologies'),
          managed: updated('Procore Technologies'),
          corrections: [correction('website'), correction('trade_slugs')],
        },
      }),
    );
    for (const caption of Array.from(el.querySelectorAll('aec-field-caption'))) {
      expect(caption.closest('aec-listing-provenance')).not.toBeNull();
    }
    expect(el.querySelector('[data-testid="profile-caption"]')).toBeNull();
    expect(el.querySelector('[data-testid="managed-caption"]')).toBeNull();
    expect(el.querySelector('[data-testid="logo-correction"]')).toBeNull();
  });

  it('names each group, in page order', () => {
    const { el } = setup(
      buildProduct({
        categories: [term('c')],
        audiences: [term('a')],
        usefulness: { audiences: [{ slug: 'a', name: 'A', points: ['One'] }], phases: [] },
        usefulness_source: 'vendor',
        captions: {
          ...CAPTIONS,
          description: updated('Procore Technologies'),
          profile: updated('Procore Technologies'),
          usefulness: { ...updated('Procore Technologies'), form: 'until' },
          managed: updated('Procore Technologies'),
        },
      }),
    );
    expect(lines(panel(el), 'field-caption')).toEqual([
      'About: Maintained by Procore Technologies · updated October 4, 2026',
      'Website and categories: Maintained by Procore Technologies · updated October 4, 2026',
      'How teams use it: Maintained by Procore Technologies until October 4, 2026',
      'Audiences, trades, phases and resources: Maintained by Procore Technologies · updated October 4, 2026',
    ]);
  });

  it('drops a group caption when the group shows nothing', () => {
    const { el } = setup(
      buildProduct({
        description: null,
        captions: {
          ...CAPTIONS,
          description: updated('Procore Technologies'),
          managed: updated('Procore Technologies'),
        },
      }),
    );
    expect(lines(panel(el), 'field-caption')).toEqual([]);
    expect(panel(el).hasAttribute('hidden')).toBe(false);
  });

  // AECI-2198: a vendor-written summary with no description still shows in the hero,
  // so the description group's "Maintained by" must stay on the page (§4.5.8).
  it('keeps the description group caption for a summary with no description', () => {
    const { el } = setup(
      buildProduct({
        description: null,
        summary: 'Run every jobsite from one platform.',
        captions: { ...CAPTIONS, description: updated('Procore Technologies') },
      }),
    );
    expect(el.querySelector('[data-testid=product-hero-summary]')).not.toBeNull();
    expect(lines(panel(el), 'field-caption')).toEqual([
      'About: Maintained by Procore Technologies · updated October 4, 2026',
    ]);
  });

  it('lists every correction by field, removals included, with the source link', () => {
    const { el } = setup(
      buildProduct({
        website: null,
        logo_url: 'https://logo.example/mark.png',
        captions: {
          ...CAPTIONS,
          corrections: [
            correction('logo_url', 'https://brand.example/kit'),
            correction('website', null, true),
            correction('phase_slugs', null, true),
          ],
        },
      }),
    );
    const found = lines(panel(el), 'field-correction');
    expect(found[0]).toMatch(/^Logo: Corrected by AEC Integrations on September 15, 2026 · Source/);
    expect(found.slice(1)).toEqual([
      'Website: Removed by AEC Integrations on September 15, 2026',
      'Project phases: Removed by AEC Integrations on September 15, 2026',
    ]);
    expect(panel(el).querySelector('a[href="https://brand.example/kit"]')).not.toBeNull();
  });

  // AECI-1666 ruling 1: a section a removal left empty disappears.
  it('drops a facet or Resources section that a removal emptied', () => {
    const { el } = setup(
      buildProduct({
        trades: [],
        tool_integrations_url: null,
        api_docs_url: null,
        captions: {
          ...CAPTIONS,
          corrections: [
            correction('trade_slugs', null, true),
            correction('tool_integrations_url', null, true),
          ],
        },
      }),
    );
    expect(el.querySelector('#trades-label')).toBeNull();
    expect(el.querySelector('#resources-label')).toBeNull();
    expect(lines(panel(el), 'field-correction')).toHaveLength(2);
  });

  it('counts the values under review', () => {
    const { el } = setup(
      buildProduct({
        description: null,
        website: null,
        under_review: ['description', 'website'],
      }),
    );
    expect(lines(panel(el), 'provenance-under-review')).toEqual([
      '2 values on this page are under review.',
    ]);
  });

  // §4.5.8: the count names only values the page marks in their slot.
  it('counts only the hidden values the page marks', () => {
    const { el } = setup(
      buildProduct({ website: null, under_review: ['website', 'unrendered_field'] }),
    );
    expect(lines(panel(el), 'provenance-under-review')).toEqual([
      '1 value on this page is under review.',
    ]);
  });

  // The count is every `aec-under-review` the page mounts, the Integrations rows' included.
  describe('counting the Integrations rows', () => {
    const row = (
      source: ProductLink,
      target: ProductLink,
      extra: Partial<ProductIntegrationItem> = {},
    ): ProductIntegrationItem => ({
      ...edge(source, target),
      mechanism_kind: 'native',
      context_direction: null,
      powered_by_product: null,
      data_object_slugs: [],
      data_objects: [],
      partner_categories: [],
      agreement: null,
      ...extra,
    });
    const agave = link('agave-erp-sync', 'Agave ERP Sync');
    const markers = (el: HTMLElement) => el.querySelectorAll('aec-under-review').length;
    const count = (el: HTMLElement) => lines(panel(el), 'provenance-under-review');

    it('counts two row markers as two', () => {
      const { el } = setup(
        buildProduct({
          integrations_as_source: [
            row(procore, sage, { under_review: ['mechanism_url'] }),
            row(procore, acumatica, { under_review: ['description'] }),
          ],
        }),
      );
      expect(markers(el)).toBe(2);
      expect(count(el)).toEqual(['2 values on this page are under review.']);
    });

    it('adds a product field to the row markers', () => {
      const { el } = setup(
        buildProduct({
          website: null,
          under_review: ['website'],
          integrations_as_source: [row(procore, sage, { under_review: ['mechanism_url'] })],
          integrations_as_target: [row(vista, procore, { under_review: ['description'] })],
        }),
      );
      expect(markers(el)).toBe(3);
      expect(count(el)).toEqual(['3 values on this page are under review.']);
    });

    // Two Via edges to one partner collapse into one row, which renders the
    // representative edge's markers only (`splitIntegrationLanes`).
    it('counts a collapsed Via row by the edge it renders', () => {
      const { el } = setup(
        buildProduct({
          integrations_as_source: [
            row(procore, sage, { via: agave, name: 'A', under_review: ['mechanism_url'] }),
            row(procore, sage, { via: agave, name: 'B', under_review: ['description'] }),
          ],
        }),
      );
      // Cards are the default view since AECI-1782. A collapsed Via row is one card.
      expect(
        el.querySelectorAll(
          '#integrations tbody tr[aec-product-integration-row], #integrations li[aec-product-integration-card]',
        ),
      ).toHaveLength(1);
      expect(markers(el)).toBe(1);
      expect(count(el)).toEqual(['1 value on this page is under review.']);
    });
  });

  // §4.5.8: a field the page never renders shows no line, and a correction that set a
  // value shows only while that value does.
  it('drops a correction with no slot on the page, or on a value the page does not show', () => {
    const { el } = setup(
      buildProduct({
        website: null,
        api_docs_url: null,
        captions: {
          ...CAPTIONS,
          corrections: [
            correction('unrendered_field'),
            correction('website'),
            correction('api_docs_url'),
          ],
        },
      }),
    );
    expect(lines(panel(el), 'field-correction')).toEqual([]);
  });

  // AECI-1666 ruling 2: the rows lost their line, so the panel says where it went.
  it('notes the integration pages when a row carried a caption or a correction', () => {
    const row = (extra: Partial<ProductIntegrationItem>): ProductIntegrationItem => ({
      ...edge(procore, sage),
      mechanism_kind: 'native',
      context_direction: null,
      powered_by_product: null,
      data_object_slugs: [],
      data_objects: [],
      partner_categories: [],
      agreement: null,
      ...extra,
    });
    const withNote = setup(
      buildProduct({ integrations_as_source: [row({ caption: updated('Sage') })] }),
    ).el;
    expect(lines(panel(withNote), 'provenance-integrations-note')).toEqual([
      "Each integration's page says who maintains it.",
    ]);
    TestBed.resetTestingModule();
    const without = setup(buildProduct({ integrations_as_source: [row({})] })).el;
    expect(lines(panel(without), 'provenance-integrations-note')).toEqual([]);
  });
});

// AECI-1238 (§11d.7): a value AECi hid while it checks it. The API sends it `null`.
describe('ProductDetailPage values under review (AECI-1238)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  const markers = (el: Element | null) =>
    Array.from(el?.querySelectorAll('[data-testid="field-under-review"]') ?? []).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );

  it('keeps #about for a hidden description, with the marker in its slot', () => {
    const { el } = setup(buildProduct({ description: null, under_review: ['description'] }));
    expect(markers(el.querySelector('#about'))).toEqual([
      'Under review. AEC Integrations is checking this detail.',
    ]);
  });

  it('names a hidden website and Resources link where its link would be', () => {
    const { el } = setup(
      buildProduct({
        website: null,
        tool_integrations_url: null,
        api_docs_url: null,
        under_review: ['website', 'api_docs_url'],
      }),
    );
    expect(markers(el)).toEqual([
      'Website: Under review. AEC Integrations is checking this detail.',
      'API documentation: Under review. AEC Integrations is checking this detail.',
    ]);
  });

  it('renders no marker when nothing is under review', () => {
    const { el } = setup(buildProduct({}));
    expect(markers(el)).toEqual([]);
  });
});

// AECI-1778: the page sits on DetailLayout's band shell, with the Forest hero band.
describe('ProductDetailPage band shell and hero (AECI-1778)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders exactly one h1, inside the hero band, holding only the product name', () => {
    const { el } = setup(buildProduct());
    const h1s = el.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.closest('.aec-hero-band')).not.toBeNull();
    expect(h1s[0]!.textContent?.trim()).toBe('Procore');
  });

  it('mounts the band shell, with the facts card after the hero and before the nav', () => {
    const { el } = setup(buildProduct({ description: 'A construction platform.' }));
    expect(el.querySelector('[data-shell=bands]')).not.toBeNull();
    const facts = el.querySelector('[data-testid=product-facts]')!;
    expect(facts.hasAttribute('aeccard')).toBe(true);
    const order = [
      el.querySelector('aec-product-hero'),
      facts,
      el.querySelector('aec-section-nav'),
      el.querySelector('#about'),
      el.querySelector('#integrations'),
    ];
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  it('names the vendor in the hero byline, linked to its page', () => {
    const { el } = setup(buildProduct());
    const byline = el.querySelector('[data-testid=product-hero-vendor]')!;
    expect(byline.textContent?.replace(/\s+/g, ' ').trim()).toBe('by Procore Technologies');
    expect(byline.querySelector('a')?.getAttribute('href')).toBe('/vendors/procore');
  });

  it('shows no byline for a product with no vendor', () => {
    const { el } = setup(buildProduct({ vendor: null }));
    expect(el.querySelector('[data-testid=product-hero-vendor]')).toBeNull();
  });

  it('makes "Visit website" the one Bone button and "Write a review" the secondary', () => {
    const { el } = setup(buildProduct());
    const band = el.querySelector('.aec-hero-band')!;
    const visit = band.querySelector('a[href="https://www.procore.com"]')!;
    expect(visit.getAttribute('data-variant')).toBe('on-brand');
    expect(visit.getAttribute('rel')).toBe('noopener nofollow');
    expect(visit.getAttribute('target')).toBe('_blank');
    expect(band.querySelector('aec-review-cta a')?.getAttribute('data-variant')).toBe(
      'on-brand-secondary',
    );
    expect(band.querySelectorAll('[data-variant=on-brand]')).toHaveLength(1);
    expect(band.querySelector('[data-variant=ghost]')).toBeNull();
  });

  // AECI-1720 restore C (mock-up 6, .lede): the description's first paragraph under the
  // name, two lines at most, hidden from assistive tech because About reads it in full.
  it('prints the description first paragraph as a two-line lede, and nothing without one', () => {
    const { el } = setup(
      buildProduct({ description: 'Construction management platform.\n\nA second paragraph.' }),
    );
    const lede = el.querySelector<HTMLElement>('[data-testid=product-hero-lede]')!;
    expect(lede.textContent!.trim()).toBe('Construction management platform.');
    expect(lede.className).toContain('line-clamp-2');
    expect(lede.getAttribute('aria-hidden')).toBe('true');
    expect(lede.closest('aec-hero-band')).not.toBeNull();
  });

  it('prints no lede without a description', () => {
    const { el } = setup(buildProduct({ description: null }));
    expect(el.querySelector('[data-testid=product-hero-lede]')).toBeNull();
  });

  // AECI-2198: a summary replaces the clamped lede. It is printed whole and
  // is not aria-hidden, because no other part of the page carries it.
  it('prints a summary whole, unclamped and readable, in place of the lede', () => {
    const { el } = setup(
      buildProduct({
        description: 'Construction management platform.\n\nA second paragraph.',
        summary: 'Run every jobsite from one platform.',
      }),
    );
    const line = el.querySelector<HTMLElement>('[data-testid=product-hero-summary]')!;
    expect(line.textContent!.trim()).toBe('Run every jobsite from one platform.');
    expect(line.className).not.toContain('line-clamp');
    expect(line.hasAttribute('aria-hidden')).toBe(false);
    expect(line.className).toContain('text-t-16');
    expect(line.className).toContain('sm:text-t-20');
    expect(line.closest('aec-hero-band')).not.toBeNull();
    expect(el.querySelector('[data-testid=product-hero-lede]')).toBeNull();
    expect(el.querySelector('[data-testid=summary-under-review]')).toBeNull();
  });

  it('marks a hidden summary under review in its slot, with no fallback lede', () => {
    const { el } = setup(
      buildProduct({
        description: 'Construction management platform.',
        summary: null,
        under_review: ['summary'],
      }),
    );
    const marker = el.querySelector('[data-testid=summary-under-review]')!;
    expect(marker).not.toBeNull();
    expect(marker.closest('aec-hero-band')).not.toBeNull();
    expect(marker.textContent).toContain('Summary');
    expect(el.querySelector('[data-testid=product-hero-lede]')).toBeNull();
    expect(el.querySelector('[data-testid=product-hero-summary]')).toBeNull();
  });

  it('pins the product hero text column to the top beside the panel (mock-up 6)', () => {
    const { el } = setup(buildProduct());
    const text = el.querySelector('aec-hero-band [data-testid=hero-band-text]')!;
    expect(text.classList).toContain('lg:self-start');
  });

  it('keeps the two averages apart, each at one decimal, and the count', () => {
    const { el } = setup(
      buildProduct({ review_count: 12, rating_overall_avg: 4.25, rating_onboarding_avg: 3 }),
    );
    const ratings = el.querySelector('[data-testid=product-hero-ratings]')!;
    const text = ratings.textContent!.replace(/\s+/g, ' ');
    expect(text).toContain('4.3');
    // Mock-up 6's names (AECI-1720 restore C), one name on every public page.
    expect(text).toContain('Product quality');
    expect(text).not.toContain('Overall');
    expect(text).toContain('3.0');
    expect(text).toContain('Onboarding experience');
    expect(text).toContain('12 reviews');
    const stars = ratings.querySelectorAll('aec-review-stars');
    expect(stars).toHaveLength(2);
  });

  it('puts the review count in its own cell with a down arrow, a full row below sm (AECI-1720)', () => {
    const { el } = setup(
      buildProduct({ review_count: 12, rating_overall_avg: 4.25, rating_onboarding_avg: 3 }),
    );
    const ratings = el.querySelector('[data-testid=product-hero-ratings]')!;
    // Two scores side by side on a phone, the count on its own row under a rule.
    expect(ratings.classList).toContain('grid-cols-2');
    expect(ratings.querySelectorAll('[data-testid=product-hero-rating-cell]')).toHaveLength(2);
    const count = ratings.querySelector('[data-testid=product-hero-review-count]')!;
    expect(count.classList).toContain('col-span-2');
    expect(count.classList).toContain('border-t');
    const link = count.querySelector('a')!;
    expect(link.getAttribute('href')).toBe('/products/procore#reviews');
    expect(link.querySelector('svg')).not.toBeNull();
  });

  it('fills the hero panel slot with the integrations wheel (AECI-2018)', () => {
    const row: ProductIntegrationItem = {
      ...edge(procore, vista),
      mechanism_kind: 'native',
      context_direction: null,
      powered_by_product: null,
      data_object_slugs: [],
      data_objects: [],
      partner_categories: [],
      agreement: null,
    };
    const { el } = setup(buildProduct({ integrations_as_source: [row] }));
    const panel = el.querySelector('.aec-hero-panel')!;
    expect(panel.querySelector('[data-testid="product-hero-visual"]')).not.toBeNull();
    expect(panel.querySelector('[data-testid="product-hero-wheel"]')).not.toBeNull();
    // The pair finder of ruling R3 is gone from the product page.
    expect(el.querySelector('[data-testid="product-pair-finder"]')).toBeNull();
  });

  it('puts the mailing-list band on white, so the page keeps one Bone band', () => {
    const { el } = setup(buildProduct());
    const section = el.querySelector('aec-mailing-list-signup section')!;
    expect(section.classList.contains('bg-(--surface-base)')).toBe(true);
    expect(section.classList.contains('bg-(--accent-warm)')).toBe(false);
  });
});

describe('ProductDetailPage About band (AECI-1780)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const t = (slug: string, name = slug) => ({ id: `id-${slug}`, slug, name });

  it('puts the description and "Who it is for" in #about, on the Bone lead band', () => {
    const { el } = setup(
      buildProduct({
        audiences: [t('architects', 'Architects')],
        trades: [t('electrical', 'Electrical')],
        phases: [t('design', 'Design'), t('construction', 'Construction')],
      }),
    );
    const about = el.querySelector('#about')!;
    expect(about.closest('[slot="body-lead"]')).not.toBeNull();
    expect(about.querySelector('[data-testid=product-description]')?.textContent?.trim()).toBe(
      'Construction management platform.',
    );
    const panel = about.querySelector('[data-testid=product-who-it-is-for]')!;
    expect(panel.querySelector('h3')?.textContent?.trim()).toBe('Who it is for');
    // Group order is the facet sidebar's, and terms keep the API's order (phases in
    // lifecycle order), each a chip link to its term page.
    expect(Array.from(panel.querySelectorAll('h4')).map((h) => h.textContent?.trim())).toEqual([
      'Audiences',
      'Trades',
      'Project phases',
    ]);
    const phases = panel.querySelector('[aria-labelledby=phases-label]')!;
    expect(
      Array.from(phases.querySelectorAll('a.aec-chip')).map((a) => a.getAttribute('href')),
    ).toEqual(['/phases/design', '/phases/construction']);
    // The facts card no longer carries any of the three groups.
    const facts = el.querySelector('aec-product-facts-card')!;
    for (const id of ['audiences-label', 'trades-label', 'phases-label']) {
      expect(facts.querySelector(`#${id}`), id).toBeNull();
    }
  });

  it('heads About with the hidden label and "About {product}", and keeps paragraph breaks (AECI-1720)', () => {
    const { el } = setup(
      buildProduct({
        description:
          'First paragraph.\n\nSecond paragraph,\nwith a line break.\n \nThird <b>x</b>.',
        audiences: [t('a')],
      }),
    );
    const about = el.querySelector('#about')!;
    const h2 = about.querySelector('h2#description-title')!;
    expect(h2.textContent?.trim()).toBe('About Procore');
    const kicker = h2.previousElementSibling!;
    expect(kicker.getAttribute('aria-hidden')).toBe('true');
    expect(kicker.textContent?.trim()).toBe('About');
    const paragraphs = Array.from(
      about.querySelectorAll('[data-testid=product-description] > p'),
    ) as HTMLElement[];
    expect(paragraphs.map((p) => p.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'First paragraph.',
      'Second paragraph, with a line break.',
      'Third <b>x</b>.',
    ]);
    // The first is the serif lead, the rest the smaller secondary size.
    expect(paragraphs[0]!.getAttribute('data-testid')).toBe('product-description-lead');
    expect(paragraphs[0]!.className).toContain('text-t-24');
    expect(paragraphs[1]!.className).toContain('text-t-16');
    // A single line break is a <br>, and stored markup stays text.
    expect(paragraphs[1]!.querySelectorAll('br')).toHaveLength(1);
    expect(paragraphs[2]!.querySelector('b')).toBeNull();
    // "Who it is for" carries its intro line and a glyph on each chip.
    const panel = about.querySelector('[data-testid=product-who-it-is-for]')!;
    expect(panel.textContent).toContain('The teams, project phases and trades it is listed for.');
    expect(panel.querySelector('a.aec-chip svg')).not.toBeNull();
  });

  it('keeps heading order h2, h3, h4 inside About (axe heading-order)', () => {
    const { el } = setup(buildProduct({ audiences: [t('a')] }));
    const tags = Array.from(el.querySelectorAll('#about h2, #about h3, #about h4')).map(
      (h) => h.tagName,
    );
    expect(tags).toEqual(['H2', 'H3', 'H4']);
  });

  it('renders About for facets alone, with no description, and lists it in the nav', () => {
    const { el } = setup(buildProduct({ description: null, audiences: [t('a')] }));
    const about = el.querySelector('#about')!;
    expect(about).not.toBeNull();
    expect(about.querySelector('[data-testid=product-description]')).toBeNull();
    expect(about.querySelector('[data-testid=product-who-it-is-for]')).not.toBeNull();
    expect(navIds(el)[0]).toBe('about');
  });

  // Ruling 36 (2026-11-16): no empty left column beside "Who it is for".
  const SPLIT = 'lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]';

  it('gives "Who it is for" the full band width when there is no description', () => {
    const { el } = setup(buildProduct({ description: null, audiences: [t('a')] }));
    const about = el.querySelector('#about')!;
    expect(about.classList).not.toContain(SPLIT);
    expect(about.classList).toContain('grid');
    // The heading still comes first, then the card.
    const heading = about.querySelector('h2#description-title')!;
    const panel = about.querySelector('[data-testid=product-who-it-is-for]')!;
    expect(heading.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the two-column split with a description, or with its under-review line', () => {
    const withText = setup(buildProduct({ audiences: [t('a')] })).el;
    expect(withText.querySelector('#about')!.classList).toContain(SPLIT);
    TestBed.resetTestingModule();
    const hidden = setup(
      buildProduct({ description: null, under_review: ['description'], audiences: [t('a')] }),
    ).el;
    expect(hidden.querySelector('#about')!.classList).toContain(SPLIT);
  });

  it('drops a facet emptied by AECi, and lists the removal in the panel', () => {
    const { el } = setup(
      buildProduct({
        description: null,
        captions: {
          description: null,
          profile: null,
          usefulness: null,
          managed: null,
          corrections: [
            {
              field: 'trade_slugs',
              date: '2026-09-15T00:00:00.000Z',
              source_url: null,
              cleared: true,
            },
          ],
        },
      }),
    );
    // AECI-1666: a facet a removal emptied disappears, heading and all. With nothing else
    // in About the band goes too, and the removal is listed in "About this listing".
    expect(el.querySelector('[aria-labelledby=trades-label]')).toBeNull();
    expect(el.querySelector('#about')).toBeNull();
    const provenance = el.querySelector('[data-testid="listing-provenance"]')!;
    expect(provenance.textContent?.replace(/\s+/g, ' ')).toContain(
      'Trades: Removed by AEC Integrations on September 15, 2026',
    );
  });

  it('drops the band and its nav entry when there is no description and no facet', () => {
    const { el } = setup(buildProduct({ description: null }));
    expect(el.querySelector('#about')).toBeNull();
    expect(el.querySelector('[slot="body-lead"]')).toBeNull();
    expect(navIds(el)).not.toContain('about');
  });

  it('shows the description alone, with no empty "Who it is for" card', () => {
    const { el } = setup(buildProduct());
    expect(el.querySelector('#about [data-testid=product-description]')).not.toBeNull();
    expect(el.querySelector('aec-product-who-it-is-for')).toBeNull();
  });
});

describe('ProductDetailPage breadcrumb (AECI-1777)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads Home, Products, then the product as the current page', () => {
    const { el } = setup(buildProduct());
    expect(trail(el)).toEqual([
      { label: 'Home', href: '/', current: false },
      { label: 'Products', href: '/products', current: false },
      { label: 'Procore', href: null, current: true },
    ]);
  });
});

// AECI-1786: a product with no integrations on record (mock-up 8). The section carries the
// legal-reviewed strings of PLAN.md section 5.2 exactly.
describe('ProductDetailPage zero-integration state (AECI-1786)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const HEADING = 'We have no integrations for Procore on record';
  const CAVEAT = 'Not on record means we have not found one. It is not proof that none exists.';
  const API_NOTE =
    'An API is not an integration. We list an integration only when we can show that one exists.';
  const NO_DIRECTORY = 'We have not found an integrations page published by Procore Technologies.';

  const section = (el: HTMLElement) => el.querySelector<HTMLElement>('#integrations')!;
  const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const directEdge = (source: ProductLink, target: ProductLink): ProductIntegrationItem => ({
    ...edge(source, target),
    mechanism_kind: 'native',
    context_direction: null,
    powered_by_product: null,
    data_object_slugs: [],
    data_objects: [],
    partner_categories: [],
    agreement: null,
  });

  it('names the section with the legal heading and prints the caveat, API note and No directory line', () => {
    const { el } = setup(buildProduct());
    const s = section(el);

    expect(squash(s.querySelector('#integrations-title')!.textContent)).toBe(HEADING);
    expect(s.getAttribute('aria-labelledby')).toBe('integrations-title');
    expect(squash(s.querySelector('[data-testid=integrations-zero-caveat]')!.textContent)).toBe(
      CAVEAT,
    );
    expect(squash(s.querySelector('[data-testid=integrations-zero-api-note]')!.textContent)).toBe(
      API_NOTE,
    );
    expect(
      squash(s.querySelector('[data-testid=integrations-zero-no-directory]')!.textContent),
    ).toBe(NO_DIRECTORY);
  });

  // AECI-1720: a vendor whose name ends in a full stop ("SiteLedger Inc.") printed
  // "Inc.." here. The legal-reviewed message is unchanged; the name gives up its stop.
  it('ends the No directory line in one full stop when the vendor name ends in one', () => {
    const p = buildProduct();
    const { el } = setup(buildProduct({ vendor: { ...p.vendor!, name: 'SiteLedger Inc.' } }));
    const line = squash(
      section(el).querySelector('[data-testid=integrations-zero-no-directory]')!.textContent,
    );
    expect(line).toBe('We have not found an integrations page published by SiteLedger Inc.');
    expect(line).not.toContain('..');
  });

  it('carries the kicker over the legal heading, as a paragraph, not a heading (AECI-1720)', () => {
    const { el } = setup(buildProduct());
    const kicker = section(el).querySelector('[data-testid=integrations-kicker]')!;
    expect(kicker.tagName).toBe('P');
    expect(squash(kicker.textContent)).toBe('Integrations on record');
  });

  it('heads the vendor card "From {vendor}" with one line on what its links are (AECI-1720)', () => {
    const { el } = setup(buildProduct({ api_docs_url: 'https://developer.procore.com' }));
    const vendor = section(el).querySelector('[data-testid=integrations-zero-vendor]')!;
    expect(squash(vendor.querySelector('#integrations-zero-resources')!.textContent)).toBe(
      'From Procore Technologies',
    );
    expect(
      squash(vendor.querySelector('[data-testid=integrations-zero-vendor-intro]')!.textContent),
    ).toBe('What the vendor publishes about connecting to Procore.');
  });

  it('never says the product "does not integrate"', () => {
    const { el } = setup(buildProduct());
    expect(el.textContent).not.toMatch(/does not integrate|doesn.t integrate/i);
  });

  it('opens the existing correction request from "It does exist"', () => {
    const { el } = setup(buildProduct());
    const button = section(el).querySelector<HTMLAnchorElement>(
      '[data-testid=integrations-zero-correction]',
    )!;

    expect(squash(button.textContent)).toBe('It does exist');
    // The routed fallback form is the one every "suggest a correction" link uses.
    expect(button.getAttribute('href')).toBe('/products/procore/correction');
  });

  // Ruling 51, option A (2026-11-16): the STAGE_1_5_SPEC.md section 11.4 heading and line
  // sit directly above the button, in one group, and the line describes the button.
  it('puts "Know of one?" and its line directly above "It does exist", and the line describes the button', () => {
    const { el } = setup(buildProduct());
    const group = section(el).querySelector<HTMLElement>('[data-testid=integrations-zero-know]')!;
    const children = [...group.children];

    // The button sits in its own wrapper at the card's foot (mock-up 8, .know .acts).
    expect(children.map((c) => c.tagName)).toEqual(['H3', 'P', 'DIV']);
    expect(squash(children[0]!.textContent)).toBe('Know of one?');
    expect(squash(children[1]!.textContent)).toBe(
      'Tell us where you saw it and we will look at it.',
    );
    const button = children[2]!.firstElementChild as HTMLAnchorElement;
    expect(button.getAttribute('data-testid')).toBe('integrations-zero-correction');
    const described = el.querySelector('#' + button.getAttribute('aria-describedby'));
    expect(described).toBe(children[1]);
    // The label is unchanged: the description adds to the name, it does not replace it.
    expect(squash(button.textContent)).toBe('It does exist');
  });

  // AECI-1720 restore C (mock-up 8, .know): the group is the page's one Forest feature
  // card, with Bone ink and the Bone main button.
  it('draws "Know of one?" as the one Forest feature card, with the Bone main button', () => {
    const { el } = setup(buildProduct());
    const card = section(el).querySelector<HTMLElement>('[data-testid=integrations-zero-know]')!;
    expect(card.className).toContain('bg-(--accent-primary)');
    expect(card.className).toContain('text-(--text-on-brand)');
    expect(card.className).toContain('rounded-card');
    expect(card.className).toContain('shadow-card');
    const button = card.querySelector('[data-testid=integrations-zero-correction]')!;
    expect(button.getAttribute('data-variant')).toBe('on-brand');
    // One Forest feature card per page: nothing else in the page body takes the fill.
    const forest = [...el.querySelectorAll<HTMLElement>('[class*="bg-(--accent-primary)"]')].filter(
      (node) => !node.closest('aec-hero-band') && node.classList.contains('aec-card'),
    );
    expect(forest).toEqual([card]);
  });

  it('keeps the outline: the section h2, then the h3 "Know of one?" before the h3 vendor card', () => {
    const { el } = setup(buildProduct({ api_docs_url: 'https://developer.procore.com' }));
    const headings = [...section(el).querySelectorAll('h2, h3')].map(
      (h) => `${h.tagName} ${squash(h.textContent)}`,
    );
    expect(headings).toEqual([
      'H2 We have no integrations for Procore on record',
      'H3 Know of one?',
      'H3 From Procore Technologies',
    ]);
  });

  it('drops the filter panel, the Cards or Table toggle, the scope note and the old empty line', () => {
    const { el } = setup(buildProduct());
    const s = section(el);

    expect(s.querySelector('[data-testid=integrations-filter-panel]')).toBeNull();
    expect(s.querySelector('aec-listing-view-toggle')).toBeNull();
    expect(s.textContent).not.toContain('Only partners listed');
    expect(s.textContent).not.toContain('No integrations recorded yet');
    expect(s.textContent).not.toContain('Integrations (0)');
  });

  it('keeps Integrations in the section nav and drops the absent Extensions entry', () => {
    const { el } = setup(buildProduct());
    expect(navIds(el)).toContain('integrations');
    expect(navIds(el)).not.toContain('extensions');
  });

  it("lists the vendor's own links with the facts card's labels, and then no No directory line", () => {
    const { el } = setup(
      buildProduct({
        api_docs_url: 'https://developer.procore.com',
        tool_integrations_url: 'https://marketplace.procore.com',
      }),
    );
    const vendor = section(el).querySelector<HTMLElement>(
      '[data-testid=integrations-zero-vendor]',
    )!;

    const links = [...vendor.querySelectorAll<HTMLAnchorElement>('a[target=_blank]')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://marketplace.procore.com',
      'https://developer.procore.com',
    ]);
    expect(links.every((a) => a.getAttribute('rel') === 'noopener nofollow')).toBe(true);
    expect(squash(vendor.textContent)).toContain('Integrations page');
    expect(squash(vendor.textContent)).toContain('API documentation');
    expect(vendor.querySelector('[data-testid=integrations-zero-no-directory]')).toBeNull();
    expect(squash(vendor.textContent)).toContain(API_NOTE);
  });

  it('shows the No directory line with API docs but no integrations page', () => {
    const { el } = setup(buildProduct({ api_docs_url: 'https://developer.procore.com' }));
    expect(squash(section(el).textContent)).toContain(NO_DIRECTORY);
  });

  it('holds the No directory line while AECi checks a hidden integrations page link', () => {
    const { el } = setup(buildProduct({ under_review: ['tool_integrations_url'] }));
    expect(section(el).querySelector('[data-testid=integrations-zero-no-directory]')).toBeNull();
  });

  it('lists a link AECi corrected in the panel, not in the zero card', () => {
    const { el } = setup(
      buildProduct({
        tool_integrations_url: 'https://marketplace.procore.com',
        captions: {
          description: null,
          profile: null,
          usefulness: null,
          managed: null,
          corrections: [
            {
              field: 'tool_integrations_url',
              date: '2026-09-15T00:00:00.000Z',
              source_url: null,
              cleared: false,
            },
          ],
        },
      }),
    );
    const vendor = section(el).querySelector('[data-testid=integrations-zero-vendor]')!;
    // AECI-1666: the correction line is in "About this listing", not beside the link.
    expect(vendor.querySelector('[data-testid=field-correction]')).toBeNull();
    const provenance = el.querySelector('[data-testid="listing-provenance"]')!;
    expect(
      squash(provenance.querySelector('[data-testid=field-correction]')?.textContent),
    ).toContain('Corrected by AEC Integrations');
    // AECI-1720: a corrected link is AECi's value, so the card does not call its links
    // the vendor's. It keeps the facts card's "Resources" and drops the vendor line.
    expect(squash(vendor.querySelector('#integrations-zero-resources')!.textContent)).toBe(
      'Resources',
    );
    expect(vendor.querySelector('[data-testid=integrations-zero-vendor-intro]')).toBeNull();
    expect(vendor.textContent).not.toContain('What the vendor publishes');
  });

  it('holds the No directory line when AECi removed the integrations page link', () => {
    const { el } = setup(
      buildProduct({
        captions: {
          description: null,
          profile: null,
          usefulness: null,
          managed: null,
          corrections: [
            {
              field: 'tool_integrations_url',
              date: '2026-09-15T00:00:00.000Z',
              source_url: null,
              cleared: true,
            },
          ],
        },
      }),
    );
    expect(section(el).querySelector('[data-testid=integrations-zero-no-directory]')).toBeNull();
    // The heading and caveat still render.
    expect(section(el).querySelector('[data-testid=integrations-zero-caveat]')).not.toBeNull();
  });

  it('holds the No directory line when the product has no vendor to name', () => {
    const { el } = setup(buildProduct({ vendor: null }));
    expect(section(el).querySelector('[data-testid=integrations-zero-no-directory]')).toBeNull();
    // The heading and caveat still render.
    expect(squash(section(el).querySelector('#integrations-title')!.textContent)).toBe(HEADING);
  });

  it('agrees with the facts card, which keeps its own zero words', () => {
    const { el } = setup(buildProduct());
    const card = el.querySelector('[data-testid=product-facts-count]')!;
    expect(squash(card.textContent)).toContain(HEADING);
    expect(squash(card.textContent)).toContain(CAVEAT);
  });

  it('is not the zero state when a stored zero sits over listed rows', () => {
    const { el } = setup(
      buildProduct({ integrations_as_source: [directEdge(procore, acumatica)] }),
    );
    expect(squash(section(el).querySelector('#integrations-title')!.textContent)).toBe(
      'Integrations',
    );
    expect(section(el).querySelector('[data-testid=integrations-zero-caveat]')).toBeNull();
  });

  it('is not the zero state on a connector that powers edges', () => {
    // A host keeps the section on the page (AECI-2046), with only its Built within line.
    const { el } = setup(
      connector({
        integrations_as_connector: [edge(procore, acumatica)],
        extension_of: [
          {
            id: '00000000-0000-4000-8000-000000000777',
            slug: 'revit',
            name: 'Revit',
            logo_url: null,
            product_role: 'application',
            connector_kind: null,
            vendor: null,
            integration_count: 0,
            review_count: 0,
            rating_overall_avg: null,
            rating_onboarding_avg: null,
            created_at: '2024-06-01T00:00:00.000Z',
            updated_at: '2024-06-01T00:00:00.000Z',
          },
        ],
      }),
    );
    expect(section(el).textContent).not.toContain('We have no integrations for');
    // AECI-2050: nor the plain empty sentence, which "Integrations it powers" makes false.
    expect(section(el).textContent).not.toContain('No integrations recorded yet');
    expect(squash(section(el).textContent)).toContain('runs inside Revit');
    expect(el.querySelector('#powered-integrations')).toBeTruthy();
  });

  it('is not the zero state when the reach line reports pairs reachable via connectors', () => {
    const { el } = setup(buildProduct({ reachable_pair_count: 2 }));
    const s = section(el);

    expect(squash(s.querySelector('#integrations-title')!.textContent)).toBe('Integrations');
    expect(s.querySelector('[data-testid=integrations-zero-caveat]')).toBeNull();
    expect(s.textContent).not.toContain('We have no integrations for');
    expect(squash(s.textContent)).toContain('2 pairs reachable via connectors');
  });

  it('is not the zero state when the stored count is above zero', () => {
    const { el } = setup(buildProduct({ integration_count: 3 }));
    expect(section(el).querySelector('[data-testid=integrations-zero-caveat]')).toBeNull();
    expect(section(el).textContent).toContain('No integrations recorded yet');
  });
});

/** Collapse whitespace, for the AECI-2046 cases below. */
const flat = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

// AECI-2046 (ruled by Chris 2026-11-24): a page that only powers pairs has no bare
// "Integrations" heading. The section and its nav link go together.
describe('ProductDetailPage hides an empty Integrations section beside powered pairs (AECI-2046)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('hides the section and its nav link on a connector that only powers pairs', () => {
    const { el } = setup(
      connector({
        connector_kind: 'sync_service',
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );
    expect(el.querySelector('#integrations')).toBeNull();
    expect(navIds(el)).not.toContain('integrations');
    expect(el.querySelector('#powered-integrations')).toBeTruthy();
    expect(navIds(el)).toContain('powered-integrations');
  });

  it('keeps it when the reach line has pairs to report', () => {
    const { el } = setup(
      connector({ integrations_as_connector: [edge(procore, acumatica)], reachable_pair_count: 2 }),
    );
    expect(el.querySelector('#integrations')).toBeTruthy();
    expect(navIds(el)).toContain('integrations');
  });

  it('keeps the empty state on a product with no integrations of any kind', () => {
    const { el } = setup(buildProduct());
    expect(el.querySelector('#integrations')).toBeTruthy();
    expect(navIds(el)).toContain('integrations');
  });
});

// AECI-2046 (ruling 15 on AECI-2035): the "What it syncs" block on a Sync Service page.
describe('ProductDetailPage "What it syncs" block (AECI-2046)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const FACTS = {
    sync_frequency: 'Every 15 minutes',
    sync_support: 'Rivets supports it',
    sync_setup: 'A one-hour setup call',
    source_url: 'https://example.com/rivets-sync',
    recorded_at: '2026-11-20T00:00:00.000Z',
  };
  const SYNCS = {
    pair_count: 8,
    pairs_with_flows: 8,
    objects: [
      { slug: 'budgets', name: 'Budgets', pair_count: 8, both_ways: 8, one_way: 0 },
      { slug: 'invoices', name: 'Invoices & Payments', pair_count: 3, both_ways: 0, one_way: 3 },
      { slug: 'job-costs', name: 'Job Costs', pair_count: 8, both_ways: 5, one_way: 3 },
    ],
  };
  const syncService = (overrides: Partial<ProductDetail> = {}) =>
    connector({
      name: 'Rivets Sync',
      connector_kind: 'sync_service',
      integrations_as_connector: [edge(procore, acumatica)],
      ...overrides,
    });
  const block = (el: HTMLElement) => el.querySelector<HTMLElement>('#what-it-syncs');

  it('renders the facts and the record types, with direction and coverage, before the pairs', () => {
    const { el } = setup(syncService({ sync_facts: FACTS, what_it_syncs: SYNCS }));
    const b = block(el)!;
    expect(flat(b.querySelector('h2')!.textContent)).toBe('What Rivets Sync syncs');
    expect(
      flat(b.querySelector('[data-testid=what-it-syncs-fact-sync_frequency]')!.textContent),
    ).toBe('How often it syncs Every 15 minutes');
    // Marked as ours, with its source and date (the Terms' promise for our text).
    expect(
      flat(b.querySelector('[data-testid=what-it-syncs-facts-source]')!.textContent),
    ).toContain('Recorded by AEC Integrations on November 20, 2026.');
    const source = b.querySelector<HTMLAnchorElement>(
      '[data-testid=what-it-syncs-facts-source-link]',
    )!;
    expect(source.getAttribute('href')).toBe('https://example.com/rivets-sync');
    expect(source.getAttribute('rel')).toBe('noopener nofollow');
    const lines = [...b.querySelectorAll('[data-testid=what-it-syncs-object]')].map((li) =>
      flat(li.textContent),
    );
    expect(lines).toEqual([
      'Budgets Both ways, on all 8 integrations',
      'Invoices & Payments One way, on 3 of 8 integrations',
      'Job Costs Both ways on 5 and one way on 3 of 8 integrations',
    ]);
    expect(flat(b.querySelector('[data-testid=what-it-syncs-intro]')!.textContent)).toContain(
      'across the 8 integrations it delivers',
    );
    expect(b.querySelector('[data-testid=what-it-syncs-uncovered]')).toBeNull();
    // It leads the pairs it describes, and the nav follows.
    expect(bodySectionIds(el).indexOf('what-it-syncs')).toBeLessThan(
      bodySectionIds(el).indexOf('powered-integrations'),
    );
    expect(navIds(el)).toContain('what-it-syncs');
  });

  it('says how many pairs list no record type yet (partial data)', () => {
    const { el } = setup(
      syncService({
        what_it_syncs: { ...SYNCS, pairs_with_flows: 5, objects: [SYNCS.objects[1]!] },
      }),
    );
    const b = block(el)!;
    expect(flat(b.querySelector('[data-testid=what-it-syncs-uncovered]')!.textContent)).toBe(
      'No types of data are listed yet for 3 of its 8 integrations.',
    );
    // No facts recorded: no facts row and no source line.
    expect(b.querySelector('[data-testid=what-it-syncs-facts]')).toBeNull();
    expect(b.querySelector('[data-testid=what-it-syncs-facts-source]')).toBeNull();
  });

  it('renders a blank fact as nothing, and fills the width with the rest', () => {
    const { el } = setup(
      syncService({ sync_facts: { ...FACTS, sync_support: '  ' }, what_it_syncs: null }),
    );
    const b = block(el)!;
    expect(b.querySelector('[data-testid=what-it-syncs-fact-sync_support]')).toBeNull();
    const dl = b.querySelector('[data-testid=what-it-syncs-facts]')!;
    expect(dl.querySelectorAll('dt')).toHaveLength(2);
    expect(dl.classList).toContain('md:grid-cols-2');
    // No record types: no list, no order line.
    expect(b.querySelector('[data-testid=what-it-syncs-objects]')).toBeNull();
  });

  it('renders nothing, and no nav link, with no record type and no fact', () => {
    const { el } = setup(
      syncService({
        sync_facts: null,
        what_it_syncs: { pair_count: 1, pairs_with_flows: 0, objects: [] },
      }),
    );
    expect(block(el)).toBeNull();
    expect(navIds(el)).not.toContain('what-it-syncs');
  });

  it('renders nothing on a product the API sent no block for', () => {
    const { el } = setup(buildProduct());
    expect(block(el)).toBeNull();
  });
});
