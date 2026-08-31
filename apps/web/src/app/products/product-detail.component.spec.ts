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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  IntegrationListItem,
  ProductDetail,
  ProductIntegrationItem,
  ProductLink,
} from '@aeci/shared';

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
      verified: false,
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
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
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
): IntegrationListItem => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  name: `${source.name} ↔ ${target.name}`,
  mechanism_kind: 'iPaaS',
  mechanism_name: 'via Agave ERP Sync',
  direction,
  source,
  target,
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
    ...overrides,
  });

/**
 * Stage 1.5 Addendum B — the "Integrations it powers" hub section that makes
 * a connector product's page intelligible (its endpoint table is legitimately
 * empty because it is the mechanism, not an endpoint).
 */
describe('ProductDetailPage powered-integrations hub', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders a hub card whose heading is the hub name, with pair-page partner rows', () => {
    const { el } = setup(
      connector({
        integrations_as_connector: [
          edge(procore, acumatica, 'one-way'),
          edge(sage, procore, 'bidirectional'),
        ],
      }),
    );

    const section = el.querySelector('#powered-integrations');
    expect(section).toBeTruthy();
    // Heading counts distinct PAIRS — what the section actually renders.
    expect(section!.querySelector('h2')!.textContent).toContain('Integrations it powers (2)');

    const cards = section!.querySelectorAll('aec-product-powered-hub section');
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
    expect(heading.querySelector('a')!.getAttribute('href')).toBe('/products/procore');
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
    // Each row has a real accessible name naming BOTH endpoints.
    expect(rows[0]!.getAttribute('aria-label')).toBe('View the Procore and Acumatica integration');
    // Direction is framed relative to the hub, and the mechanism is shown —
    // the same vocabulary the sibling endpoint table uses.
    expect(rows[0]!.textContent).toContain('Outbound');
    expect(rows[1]!.textContent).toContain('Both');
    expect(rows[0]!.textContent).toContain('iPaaS');
  });

  it('renders a hubless pair as a standalone two-endpoint row instead of a one-partner hub', () => {
    const { el } = setup(
      connector({ integrations_as_connector: [edge(procore, acumatica, 'bidirectional')] }),
    );

    const section = el.querySelector('#powered-integrations')!;
    expect(section.querySelector('h2')!.textContent).toContain('Integrations it powers (1)');

    const cards = section.querySelectorAll('aec-product-powered-hub section');
    expect(cards).toHaveLength(1);
    // No hub cards above it, so it is simply "Connections", not "Other".
    expect(cards[0]!.querySelector('h3')!.textContent!.trim()).toBe('Connections');

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

    const cards = el.querySelectorAll('aec-product-powered-hub section');
    // Hub identity by link, not heading text (the aria-hidden fallback initial
    // is part of textContent). The trailing card is the hubless bucket, whose
    // heading is a label with no product link.
    const hubHrefs = [...cards].map((c) => c.querySelector('h3 a')?.getAttribute('href') ?? null);
    expect(hubHrefs).toEqual(['/products/procore', null]);
    expect(cards[1]!.querySelector('h3')!.textContent!.trim()).toBe('Other connections');
    // Viewpoint Vista appears once as a partner under Procore, and once inside
    // the hubless pair row — never as a competing hub heading.
    expect(hubHrefs).not.toContain('/products/viewpoint-vista');
  });

  it('shows the empty state (with a correction link) for a connector with no powered edges', () => {
    const { el } = setup(connector());

    const section = el.querySelector('#powered-integrations');
    expect(section).toBeTruthy();
    expect(section!.querySelector('h2')!.textContent).toContain('Integrations it powers (0)');
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
        integrations_as_source: [{ ...edge(procore, acumatica), context_direction: null }],
        integrations_as_connector: [edge(procore, acumatica), edge(sage, procore)],
      }),
    );

    const endpoints = el.querySelector('#integrations')!;
    expect(endpoints.textContent).toContain('Only partners listed on AECi appear here');

    const powered = el.querySelector('#powered-integrations')!;
    expect(powered.textContent).toContain(
      'Only integrations between products listed on AECi appear here',
    );

    // Each note routes to the same correction drawer the empty states use, so
    // the caveat is a contribution loop rather than a dead disclaimer.
    for (const section of [endpoints, powered]) {
      expect(
        section.querySelector<HTMLAnchorElement>('p a[href="/products/agave-erp-sync/correction"]'),
      ).toBeTruthy();
    }
  });

  it('omits the catalog-scope note where the list is empty (the empty state already hedges)', () => {
    // Endpoint table empty, powered list populated: only the populated section
    // carries the note. Doubling up with "No integrations recorded yet. Vendor
    // data is curated…" would say the same thing twice.
    const { el } = setup(connector({ integrations_as_connector: [edge(procore, acumatica)] }));

    expect(el.querySelector('#integrations')!.textContent).not.toContain('Only partners listed');
    expect(el.querySelector('#powered-integrations')!.textContent).toContain(
      'Only integrations between products listed on AECi appear here',
    );
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

/**
 * The endpoint integrations table (`#integrations`) — the edges this product
 * TERMINATES, as opposed to the powered-hub section above. Covers the row
 * ORDER only; `ProductIntegrationRow`'s own spec covers what a row renders.
 */
describe('ProductDetailPage integrations table order', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const endpointEdge = (source: ProductLink, target: ProductLink): ProductIntegrationItem => ({
    ...edge(source, target),
    context_direction: null,
  });

  /**
   * The partner name from each rendered row, in DOM order. A row carries two
   * sibling links — the stretched pair-page overlay and the partner-product
   * link (see `ProductIntegrationRow`) — and only the partner one points at a
   * bare product page.
   */
  const partnerOrder = (el: HTMLElement) =>
    [
      ...el.querySelectorAll<HTMLTableRowElement>(
        // Attribute-selected component, so the `@defer` placeholder row (a bare
        // `<tr aria-hidden>` skeleton, no links) can't be mistaken for a result.
        '#integrations tbody tr[aec-product-integration-row]',
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
    const rows = el.querySelectorAll('#integrations tbody tr[aec-product-integration-row]');
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

    const { el } = setup(
      buildProduct({
        integrations_as_source: partners.map((partner) => endpointEdge(procore, partner)),
      }),
    );

    // Only the undeferred head renders here — `@defer (on viewport)` never
    // triggers in this harness — which is exactly the boundary under test.
    const rendered = partnerOrder(el);
    expect(rendered).toHaveLength(20);
    expect(rendered[0]).toBe('Partner 01');
    expect(rendered.at(-1)).toBe('Partner 20');
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
 * The Actions-sidebar claim CTA. `vendors.verified` is the only public signal
 * that a listing is claimed, so it drives the copy: an unverified vendor gets
 * "Claim this listing", a verified one gets "Request access to this listing"
 * plus a note. Both open the same `kind:'claim'` request — seats are
 * admin-granted and multi-seat (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11), so the
 * claim form stays the only route in for a second person at the vendor.
 */
describe('ProductDetailPage claim CTA', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const actions = (el: HTMLElement) =>
    el.querySelector('section[aria-labelledby="actions-label"]') as HTMLElement;

  it('offers to claim the listing when the built-by vendor is unverified', () => {
    const { el } = setup(buildProduct());
    const section = actions(el);

    expect(section.textContent).toContain('Claim this listing');
    expect(section.textContent).not.toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Already managed by a verified vendor');
  });

  it('offers to request access when the built-by vendor is verified', () => {
    const { el } = setup(
      buildProduct({
        vendor: {
          id: '00000000-0000-4000-8000-000000010001',
          slug: 'procore',
          name: 'Procore Technologies',
          logo_url: null,
          verified: true,
        },
      }),
    );
    const section = actions(el);

    expect(section.textContent).toContain('Request access to this listing');
    expect(section.textContent).not.toContain('Claim this listing');
    expect(section.textContent).toContain('Already managed by a verified vendor');

    // Copy only: the CTA still targets the same claim route/kind.
    const cta = section.querySelector<HTMLAnchorElement>('a[href="/products/procore/claim"]');
    expect(cta).toBeTruthy();
  });

  it('falls back to the claim copy when the product has no vendor at all', () => {
    // `ProductDetail.vendor` is nullable (no DB constraint forces one), so the
    // verified read must not assume a vendor is present.
    const { el } = setup(buildProduct({ vendor: null }));
    const section = actions(el);

    expect(section.textContent).toContain('Claim this listing');
    expect(section.textContent).not.toContain('Already managed by a verified vendor');
  });
});

/**
 * Stage 1.5 Addendum C §13.6 (AECI-707) — the role-varied template: section
 * order, the hero reach line, and the §13.4(2) self-exclusion that decides
 * whether the powered section renders at all.
 */
const bodySectionIds = (el: HTMLElement): string[] =>
  [...el.querySelectorAll('[slot="body"] > [id]')].map((n) => n.id);

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
    const { el } = setup(
      connector({
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
    const { el } = setup(buildProduct({ integrations_as_connector: [edge(sage, acumatica)] }));

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
        integrations_as_target: [
          { ...selfEdge(procore, agave), context_direction: null },
          { ...selfEdge(acumatica, agave), context_direction: null },
          { ...selfEdge(sage, agave), context_direction: null },
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
    expect(el.querySelector('#integrations')!.querySelector('h2')!.textContent).toContain(
      'Integrations (3)',
    );
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
      'Connects 4 products in the AECi catalog',
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
      'Connects 3 products in the AECi catalog',
    );
    expect(el.querySelector('#powered-integrations')).toBeNull();
  });

  it('singularizes at one product', () => {
    const { el } = setup(connector({ integrations_as_connector: [selfEdge(procore, agave)] }));

    expect(el.querySelector('[slot="hero"]')!.textContent).toContain(
      'Connects 1 product in the AECi catalog',
    );
  });

  it('renders nothing at zero, on a connector or an application', () => {
    for (const product of [connector(), buildProduct()]) {
      const { el } = setup(product);
      expect(el.querySelector('[slot="hero"]')!.textContent).not.toContain('Connects');
      TestBed.resetTestingModule();
    }
  });
});
