/**
 * ProductsPairPage render tests (AECI-294). Named `.component.spec.ts` so it
 * runs under `ng test` (TestBed). The pair is delivered via a stub
 * `ActivatedRoute` — the same channel `productsPairResolver` populates in
 * production.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  AgreementState,
  ContextDirection,
  PairClaimAttestation,
  ProductPairClaim,
  ProductPairResponse,
  SyncHeadline,
} from '@aeci/shared';

import { ProductsPairPage } from './products-pair';

const productListItem = (slug: string, name: string, overrides = {}) => ({
  id: `00000000-0000-4000-8000-${slug.padEnd(12, '0')}`,
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  vendor: null,
  primary_category: null,
  integration_count: 1,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

const aeciSeed = (note: string | null = 'Curated by AECi.'): PairClaimAttestation => ({
  source: 'aeci',
  attestor: 'aeci',
  asserted: true,
  note,
  introduced_at: null,
  deprecated_at: null,
});

/** A vendor attestation, framed context-relative the way the API resolves it. */
const vendorVote = (attestor: 'context' | 'other', asserted: boolean): PairClaimAttestation => ({
  source: attestor === 'context' ? 'vendor_a' : 'vendor_b',
  attestor,
  asserted,
  note: null,
  introduced_at: null,
  deprecated_at: null,
});

const claim = (
  slug: string,
  name: string,
  direction: ContextDirection,
  note = 'Curated by AECi.',
): ProductPairClaim => ({
  data_object_slug: slug,
  data_object_name: name,
  direction,
  agreement: 'unverified',
  attestations: [aeciSeed(note)],
});

/** A claim in an arbitrary agreement state, for the §4.2 render matrix. */
const claimInState = (
  slug: string,
  name: string,
  agreement: AgreementState,
  attestations: PairClaimAttestation[],
): ProductPairClaim => ({
  data_object_slug: slug,
  data_object_name: name,
  direction: 'outbound',
  agreement,
  attestations,
});

function buildPair(overrides: Partial<ProductPairResponse> = {}): ProductPairResponse {
  return {
    context_product: productListItem('procore', 'Procore'),
    other_product: productListItem('revit', 'Revit'),
    mechanisms: [
      {
        id: '00000000-0000-4000-8000-0000000000aa',
        mechanism_kind: 'marketplace-app',
        mechanism_name: 'Procore + Autodesk Construction Cloud',
        direction: 'outbound',
        description: 'The marketplace connector.',
        listing_url: 'https://example.com/listing',
        docs_url: null,
        built_by_vendor: null,
        powered_by_product: null,
        via: null,
        claims: [],
      },
    ],
    sync_headline: { total: 0, confirmed: 0, single_source: 0 },
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    // AECI-303: `null` = the §9 diff does not apply, which is the whole browser-side
    // suppression rule — no selectors, no markers, no history affordance.
    version_diff: null,
    ...overrides,
  };
}

/** A pair whose single mechanism carries claims (Layer B). `headline` overrides
 *  the derived counts for the states-rendering cases. */
function buildPairWithClaims(
  claims: ProductPairClaim[],
  headline: Partial<SyncHeadline> = {},
): ProductPairResponse {
  const base = buildPair();
  return {
    ...base,
    mechanisms: [{ ...base.mechanisms[0]!, claims }],
    sync_headline: {
      total: claims.length,
      confirmed: 0,
      single_source: 0,
      ...headline,
    },
  };
}

function setup(pair: ProductPairResponse | null, queryParams: Record<string, string> = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: {
          data: of({ pair }),
          snapshot: { data: { pair } },
          // The pair page reads `?view=` synchronously (SSR). `of()` satisfies
          // toSignal's `requireSync`; default (no param) resolves to `detailed`.
          queryParamMap: of(convertToParamMap(queryParams)),
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProductsPairPage);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

/** Flush the browser-only `afterNextRender` cookie read + the resulting update
 *  (the remembered Basic/Detailed choice). Mirrors `ConsentBanner`'s harness. */
async function hydrate(fixture: ReturnType<typeof setup>['fixture']): Promise<void> {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  fixture.detectChanges();
}

const PAIR_VIEW_COOKIE = 'aeci_pair_view';
function setViewCookie(mode: 'basic' | 'detailed'): void {
  document.cookie = `${PAIR_VIEW_COOKIE}=${mode}; path=/`;
}
function clearViewCookie(): void {
  document.cookie = `${PAIR_VIEW_COOKIE}=; path=/; max-age=0`;
}

describe('ProductsPairPage', () => {
  // Clear the persisted view before each test: the post-hydration cookie read
  // would otherwise leak a prior test's choice into the "detailed by default"
  // cases and make them order-dependent.
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearViewCookie();
  });

  it('renders the rail, heading, and a mechanism card', () => {
    const { el } = setup(buildPair());

    expect(el.querySelector('h1')?.textContent).toContain('How Procore and Revit exchange data');
    // Both endpoints appear (rail + breadcrumb).
    expect(el.textContent).toContain('Procore');
    expect(el.textContent).toContain('Revit');
    // Mechanism card: kind chip + name + external listing link.
    expect(el.textContent).toContain('Marketplace app');
    expect(el.textContent).toContain('Procore + Autodesk Construction Cloud');
    expect(el.querySelector('a[href="https://example.com/listing"]')).toBeTruthy();
  });

  it('renders the context-relative direction for the mechanism', () => {
    const { el } = setup(buildPair());
    // Context = Procore, integration outbound → "Sends to Revit".
    expect(el.textContent).toContain('Sends to Revit');
  });

  it('renders the empty data-flow band when the pair has no claims', () => {
    const { el } = setup(buildPair());
    expect(el.textContent).toContain('Data flows aren’t documented yet');
  });

  it('renders the sync headline + claim rows grouped by direction (Layer B)', () => {
    const { el } = setup(
      buildPairWithClaims([
        claim('models', 'Models', 'outbound'),
        claim('rfis', 'RFIs', 'inbound'),
      ]),
    );

    // Sync headline leads with breadth; the empty band is gone.
    expect(el.textContent).toContain('2 data objects sync');
    expect(el.textContent).not.toContain('Data flows aren’t documented yet');
    // Data-object rows, one per claim, each with a neutral badge + provenance.
    expect(el.textContent).toContain('Models');
    expect(el.textContent).toContain('RFIs');
    expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(2);
    expect(el.querySelectorAll('aec-claim-provenance')).toHaveLength(2);
    expect(el.textContent).toContain('Unverified · AECi');
    // Grouped into context-relative lanes (headings), not a standalone arrow.
    expect(el.textContent).toContain('Sends to Revit');
    expect(el.textContent).toContain('Receives from Revit');
  });

  it('suppresses the standalone mechanism arrow when the mechanism has claims', () => {
    const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
    // "Sends to Revit" appears exactly once — as the lane heading, not also as a
    // duplicate standalone mechanism arrow.
    const occurrences = (el.textContent ?? '').split('Sends to Revit').length - 1;
    expect(occurrences).toBe(1);
    expect(el.querySelector('h3.aec-overline')?.textContent).toContain('Sends to Revit');
  });

  it('renders the singular sync headline for one claim', () => {
    const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
    expect(el.textContent).toContain('1 data object syncs');
  });

  it('keeps a mechanism-card h2 when the mechanism is unnamed but has claims (no h1→h3 skip)', () => {
    const pair = buildPairWithClaims([claim('models', 'Models', 'outbound')]);
    const { el } = setup({
      ...pair,
      mechanisms: [{ ...pair.mechanisms[0]!, mechanism_name: null }],
    });
    // Detailed view (the default) renders the Layer-B lane <h3>s. Without a card
    // <h2> the hierarchy would jump page <h1> → lane <h3>. The kind label is
    // promoted into the heading as the fallback.
    const cardHeadings = Array.from(el.querySelectorAll('h2')).map((h) => h.textContent?.trim());
    expect(cardHeadings.some((t) => t?.includes('Marketplace app'))).toBe(true);
    expect(el.querySelector('h3.aec-overline')).toBeTruthy();
  });

  it('shows the empty-mechanisms message when the pair has no integrations', () => {
    const { el } = setup(buildPair({ mechanisms: [] }));
    expect(el.textContent).toContain('don’t have any integrations documented');
  });

  // The §4.2 matrix, rendered from fixtures with no vendor data in the DB.
  describe('agreement states (§4)', () => {
    /** Both endpoints carry a vendor, so attribution has names to use. */
    const withVendors = (pair: ProductPairResponse): ProductPairResponse => ({
      ...pair,
      context_product: {
        ...pair.context_product,
        vendor: {
          id: 'v1',
          name: 'Acme Software',
          slug: 'acme-software',
          logo_url: null,
          verified: true,
        },
      },
      other_product: {
        ...pair.other_product,
        vendor: { id: 'v2', name: 'Globex', slug: 'globex', logo_url: null, verified: false },
      },
    });

    const renderState = (
      agreement: AgreementState,
      attestations: PairClaimAttestation[],
      headline: Partial<SyncHeadline> = {},
    ) =>
      setup(
        withVendors(
          buildPairWithClaims([claimInState('rfis', 'RFIs', agreement, attestations)], headline),
        ),
      ).el;

    it('renders 0 voters as the neutral unverified chip', () => {
      expect(renderState('unverified', [aeciSeed()]).textContent).toContain('Unverified · AECi');
    });

    it('renders a denied-only claim as unverified, never as a conflict', () => {
      const el = renderState('unverified', [aeciSeed(), vendorVote('context', false)]);
      expect(el.textContent).toContain('Unverified · AECi');
      expect(el.textContent).not.toContain('Vendors disagree');
    });

    it('renders single_source attributed to the affirming vendor', () => {
      const el = renderState('single_source', [aeciSeed(), vendorVote('context', true)], {
        single_source: 1,
      });
      expect(el.textContent).toContain('Confirmed by Acme Software');
      // Never the bilateral wording.
      expect(el.textContent).not.toContain('Both vendors confirmed');
    });

    it('attributes single_source to the other product’s vendor when that side affirmed', () => {
      const el = renderState('single_source', [vendorVote('other', true)], { single_source: 1 });
      expect(el.textContent).toContain('Confirmed by Globex');
    });

    it('renders confirmed with the bilateral wording', () => {
      const el = renderState(
        'confirmed',
        [vendorVote('context', true), vendorVote('other', true)],
        { confirmed: 1 },
      );
      expect(el.textContent).toContain('Both vendors confirmed');
    });

    it('renders conflict as a disagreement between vendors', () => {
      const el = renderState('conflict', [vendorVote('context', true), vendorVote('other', false)]);
      expect(el.textContent).toContain('Vendors disagree');
    });

    it('reports one-sided and bilateral verification as separate clauses', () => {
      const el = setup(
        withVendors(
          buildPairWithClaims(
            [
              claimInState('rfis', 'RFIs', 'confirmed', [
                vendorVote('context', true),
                vendorVote('other', true),
              ]),
              claimInState('models', 'Models', 'single_source', [vendorVote('context', true)]),
            ],
            { total: 2, confirmed: 1, single_source: 1 },
          ),
        ),
      ).el;
      expect(el.textContent).toContain('1 of 2 vendor-confirmed');
      expect(el.textContent).toContain('1 confirmed by one vendor only');
      // The one-sided count must never be folded into the bilateral figure.
      expect(el.textContent).not.toContain('2 of 2 vendor-confirmed');
    });

    it('omits the one-sided clause entirely when there are none', () => {
      const el = renderState('unverified', [aeciSeed()]);
      expect(el.textContent).toContain('0 of 1 vendor-confirmed');
      expect(el.textContent).not.toContain('confirmed by one vendor only');
    });

    // The "confirmation arrives with the portal" subline is only true while no
    // vendor has spoken. Each case needs its own test — `setup()` instantiates
    // the TestBed, which can only happen once per spec.
    const AWAITING = 'Vendor confirmation arrives with the vendor portal';

    it('keeps the awaiting-vendors subline while every attestation is AECi’s', () => {
      expect(renderState('unverified', [aeciSeed()]).textContent).toContain(AWAITING);
    });

    it('retires the awaiting-vendors subline once a vendor has spoken, even to deny', () => {
      const el = renderState('unverified', [aeciSeed(), vendorVote('context', false)]);
      expect(el.textContent).not.toContain(AWAITING);
    });

    it('retires the awaiting-vendors subline once a vendor has affirmed', () => {
      const el = renderState('single_source', [vendorVote('context', true)], { single_source: 1 });
      expect(el.textContent).not.toContain(AWAITING);
    });

    // AC: `?view=basic` still collapses the lanes, whatever state the claims are in.
    it('still collapses the lanes in Basic view for a non-unverified claim', () => {
      const { el } = setup(
        withVendors(
          buildPairWithClaims(
            [
              claimInState('rfis', 'RFIs', 'conflict', [
                vendorVote('context', true),
                vendorVote('other', false),
              ]),
            ],
            { total: 1 },
          ),
        ),
        { view: 'basic' },
      );
      expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(0);
      expect(el.textContent).not.toContain('Vendors disagree');
      // The headline survives — Basic hides granularity, not breadth.
      expect(el.textContent).toContain('1 data object syncs');
    });
  });

  it('renders the NotFound shell when the pair is null', () => {
    const { el } = setup(null);
    expect(el.querySelector('aec-not-found')).toBeTruthy();
  });

  describe('connector byline (Built by / Powered by)', () => {
    const agaveVendor = {
      id: '00000000-0000-4000-8000-0000000000v1',
      name: 'Agave',
      slug: 'agave',
      logo_url: null,
      // `VendorLinkSchema` gained `verified` with the Stage 2 verified badge
      // (AECI-523); this fixture predates it. Unverified is the right default —
      // the badge cases live in the verified-badge specs.
      verified: false,
    };
    const agaveProduct = {
      id: '00000000-0000-4000-8000-0000000000p1',
      name: 'Agave ERP Sync',
      slug: 'agave-erp-sync',
      logo_url: null,
    };

    function buildPairWithProvenance(
      built_by_vendor: typeof agaveVendor | null,
      powered_by_product: typeof agaveProduct | null,
      via: typeof agaveProduct | null = null,
    ): ProductPairResponse {
      const base = buildPair();
      return {
        ...base,
        mechanisms: [{ ...base.mechanisms[0]!, built_by_vendor, powered_by_product, via }],
      };
    }

    it('links both the vendor and the connector product when both are set', () => {
      const { el } = setup(buildPairWithProvenance(agaveVendor, agaveProduct));

      expect(el.textContent).toContain('Built by');
      expect(el.textContent).toContain('Powered by');
      const vendorLink = el.querySelector('a[href="/vendors/agave"]');
      const productLink = el.querySelector('a[href="/products/agave-erp-sync"]');
      expect(vendorLink?.textContent).toContain('Agave');
      expect(productLink?.textContent).toContain('Agave ERP Sync');
      expect(el.textContent).toContain('·');
    });

    it('keeps a space between the label and its link', () => {
      // Angular strips the newline between `</ng-container>` and `<a>` under the
      // default `preserveWhitespaces: false`, which rendered "Built byAgave".
      // The `&ngsp;` entities in the template are what put the space back.
      const { el } = setup(buildPairWithProvenance(agaveVendor, agaveProduct));
      const text = el.textContent!.replace(/\s+/g, ' ');

      expect(text).toContain('Built by Agave');
      expect(text).toContain('Powered by Agave ERP Sync');
    });

    it('falls back to the vendor-only segment when powered_by_product is null', () => {
      const { el } = setup(buildPairWithProvenance(agaveVendor, null));

      expect(el.textContent).toContain('Built by');
      expect(el.querySelector('a[href="/vendors/agave"]')).toBeTruthy();
      expect(el.textContent).not.toContain('Powered by');
      expect(el.querySelector('a[href="/products/agave-erp-sync"]')).toBeNull();
    });

    it('renders the connector byline from `via` on a connector-evidenced pair (AECI-721)', () => {
      // After the migration these 19 production pairs live in
      // `connector_evidenced_pairs`, where the connector is `via` and
      // `powered_by_product` is null by construction. Reading only
      // `powered_by_product` would silently drop the byline — the pair page would
      // name no connector for an edge that exists ONLY because of one.
      const { el } = setup(buildPairWithProvenance(null, null, agaveProduct));

      expect(el.textContent).toContain('Powered by');
      expect(el.querySelector('a[href="/products/agave-erp-sync"]')).toBeTruthy();
      expect(el.textContent).not.toContain('Built by');
    });

    it('renders no byline when neither field is set', () => {
      const { el } = setup(buildPair());

      expect(el.textContent).not.toContain('Built by');
      expect(el.textContent).not.toContain('Powered by');
    });

    it('keeps the byline visible in Basic view (identity, not detail)', () => {
      const { el } = setup(buildPairWithProvenance(agaveVendor, agaveProduct), {
        view: 'basic',
      });

      expect(el.querySelector('a[href="/products/agave-erp-sync"]')).toBeTruthy();
      expect(el.textContent).toContain('Built by');
    });
  });

  describe('Basic/Detailed view toggle', () => {
    it('renders the toggle (Detailed pressed) when the pair has detail to hide', () => {
      const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));

      const group = el.querySelector('[role="group"]');
      expect(group).toBeTruthy();
      const buttons = group!.querySelectorAll('button');
      expect(buttons).toHaveLength(2);
      expect(buttons[0]!.textContent).toContain('Basic');
      expect(buttons[1]!.textContent).toContain('Detailed');
      // No ?view= → detailed default.
      expect(buttons[0]!.getAttribute('aria-pressed')).toBe('false');
      expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    });

    it('hides the claim lanes in Basic view but keeps the sync headline, description, and links', () => {
      const { el } = setup(
        buildPairWithClaims([
          claim('models', 'Models', 'outbound'),
          claim('rfis', 'RFIs', 'inbound'),
        ]),
        { view: 'basic' },
      );

      // The "data transfers" (Layer-B claim rows + lane headings) are gone.
      expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(0);
      expect(el.querySelectorAll('aec-claim-provenance')).toHaveLength(0);
      expect(el.querySelector('h3.aec-overline')).toBeNull();
      expect(el.textContent).not.toContain('Sends to Revit');
      expect(el.textContent).not.toContain('Receives from Revit');
      // The Overview essentials remain.
      expect(el.textContent).toContain('2 data objects sync');
      expect(el.textContent).toContain('The marketplace connector.');
      expect(el.querySelector('a[href="https://example.com/listing"]')).toBeTruthy();
      // Basic is the pressed segment.
      const buttons = el.querySelectorAll('[role="group"] button');
      expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
      expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
    });

    it('hides the standalone direction arrow in Basic view (no-claims mechanism)', () => {
      const { el } = setup(buildPair(), { view: 'basic' });
      // buildPair()'s mechanism has a direction but no claims → the Layer-A arrow
      // is Detailed-only, so Basic drops it while keeping the description.
      expect(el.textContent).not.toContain('Sends to Revit');
      expect(el.textContent).toContain('The marketplace connector.');
      expect(el.querySelector('[role="group"]')).toBeTruthy();
    });

    it('omits the toggle entirely when there is no detail to collapse', () => {
      const base = buildPair();
      const noDetail = buildPair({
        mechanisms: [{ ...base.mechanisms[0]!, direction: null, claims: [] }],
      });
      const { el } = setup(noDetail);
      expect(el.querySelector('[role="group"]')).toBeNull();
    });
  });

  describe('Remembered view (cookie persistence)', () => {
    // SSR cache-neutrality is structural: the cookie is read ONLY inside
    // `afterNextRender`, which never runs during SSR — so the cached HTML always
    // carries the `detailed` default and no visitor choice leaks into the shared
    // edge entry. The browser test harness fires afterNextRender synchronously on
    // the first CD (same as ConsentBanner), so there is no observable
    // "before reconciliation" frame to assert; we assert the reconciled result.
    it('defaults to the remembered Basic choice after hydration when the URL has no ?view=', async () => {
      setViewCookie('basic');
      const { fixture, el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
      await hydrate(fixture);

      // The remembered Basic choice takes over: lanes collapse and the Basic
      // segment becomes pressed — without any ?view= in the URL.
      expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(0);
      const buttons = el.querySelectorAll('[role="group"] button');
      expect(buttons[0]!.getAttribute('aria-pressed')).toBe('true');
      expect(buttons[1]!.getAttribute('aria-pressed')).toBe('false');
    });

    it('lets an explicit ?view= in the URL win over the remembered cookie', async () => {
      setViewCookie('basic');
      const { fixture, el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]), {
        view: 'detailed',
      });
      await hydrate(fixture);

      // The deep-linked (cache-forked) Detailed view is honored despite the Basic
      // cookie — the URL param is the source of truth when present.
      expect(el.querySelector('aec-agreement-badge')).toBeTruthy();
      const buttons = el.querySelectorAll('[role="group"] button');
      expect(buttons[1]!.getAttribute('aria-pressed')).toBe('true');
    });

    it('writes the cookie and applies the choice when the toggle is clicked', () => {
      const { fixture, el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
      // Stub the URL navigation (the fake ActivatedRoute can't back a real
      // relative navigation); we assert the cookie write + the in-memory apply.
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

      const basicButton = el.querySelectorAll('[role="group"] button')[0] as HTMLButtonElement;
      basicButton.click();
      fixture.detectChanges();

      expect(document.cookie).toContain(`${PAIR_VIEW_COOKIE}=basic`);
      expect(navigate).toHaveBeenCalledWith(
        [],
        expect.objectContaining({ queryParams: { view: 'basic' }, queryParamsHandling: 'merge' }),
      );
      // The click applies immediately via the in-memory mirror (no round-trip).
      expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(0);
    });
  });
});

// ─── The version selectors + diff markers (AECI-303 / §9) ────────────────────
//
// The first case is the acceptance criterion: with `version_diff: null` the page
// must render exactly as it did before AECI-303. Everything else only fires once
// a vendor has authored releases AND stamped an attestation, which is no pair in
// the catalog today.

const versionDiff = (
  overrides: Partial<NonNullable<ProductPairResponse['version_diff']>> = {},
) => ({
  context_versions: [
    { label: '2026.1', released_at: null },
    { label: '2026.9', released_at: null },
    { label: '2026.10', released_at: null },
  ],
  other_versions: [
    { label: 'v4', released_at: null },
    { label: 'v5', released_at: null },
  ],
  selected: { context: '2026.10', other: 'v5' },
  previous: { context: '2026.9', other: 'v4' },
  is_default: true,
  counts: { added: 0, removed: 0 },
  diff_access: 'full' as const,
  ...overrides,
});

describe('ProductsPairPage — version selectors (AECI-303)', () => {
  beforeEach(() => clearViewCookie());

  it('renders NO version chrome when the diff does not apply', async () => {
    // The AC, asserted directly: latest × latest renders identically to today for
    // claims with no version data.
    const { fixture, el } = setup(buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]));
    await hydrate(fixture);

    expect(el.querySelectorAll('aec-pair-version-select')).toHaveLength(0);
    expect(el.textContent).not.toContain('Show the latest versions');
    expect(el.textContent).not.toContain('New in');
    expect(el.textContent).not.toContain('Removed in');
    // …and the pre-existing claim furniture is untouched.
    expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(1);
    expect(el.querySelectorAll('aec-claim-provenance')).toHaveLength(1);
  });

  it('renders one selector per side, each labelled with its own product', async () => {
    const pair = buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]);
    const { fixture, el } = setup({ ...pair, version_diff: versionDiff() });
    await hydrate(fixture);

    const selects = el.querySelectorAll('aec-pair-version-select');
    expect(selects).toHaveLength(2);
    // The label is the product's own name, which is what the rail placement buys —
    // no "Version A" / "Source version" disambiguation needed.
    expect(el.textContent).toContain('Procore version');
    expect(el.textContent).toContain('Revit version');
  });

  it('omits a selector for a side with fewer than two releases', async () => {
    // A one-option combobox is a no-op control; a DISABLED one is worse than none.
    const pair = buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]);
    const { fixture, el } = setup({
      ...pair,
      version_diff: versionDiff({
        other_versions: [{ label: 'v5', released_at: null }],
      }),
    });
    await hydrate(fixture);

    expect(el.querySelectorAll('aec-pair-version-select')).toHaveLength(1);
    expect(el.textContent).toContain('Procore version');
    expect(el.textContent).not.toContain('Revit version');
  });

  it('renders the added marker with a glyph AND a text label, not colour alone', async () => {
    const added: ProductPairClaim = {
      ...claim('rfis', 'RFIs', 'outbound'),
      version_status: 'added',
    };
    const { fixture, el } = setup({
      ...buildPairWithClaims([added]),
      version_diff: versionDiff({ counts: { added: 1, removed: 0 } }),
    });
    await hydrate(fixture);

    // WCAG 1.4.1: the state is carried by text, not only by the border colour.
    expect(el.textContent).toContain('New in 2026.10 · v5');
    expect(el.textContent).toContain('+');
    expect(el.textContent).toContain('1 added');
  });

  it('renders the removed marker and strikes the name through', async () => {
    const removed: ProductPairClaim = {
      ...claim('rfis', 'RFIs', 'outbound'),
      version_status: 'removed',
    };
    const { fixture, el } = setup({
      ...buildPairWithClaims([removed]),
      version_diff: versionDiff({ counts: { added: 0, removed: 1 } }),
    });
    await hydrate(fixture);

    expect(el.textContent).toContain('Removed in 2026.10 · v5');
    expect(el.querySelector('.line-through')).not.toBeNull();
    expect(el.textContent).toContain('1 removed');
  });

  it('renders no marker for an unchanged claim — the majority state stays quiet', async () => {
    const unchanged: ProductPairClaim = {
      ...claim('rfis', 'RFIs', 'outbound'),
      version_status: 'unchanged',
    };
    const { fixture, el } = setup({
      ...buildPairWithClaims([unchanged]),
      version_diff: versionDiff(),
    });
    await hydrate(fixture);

    expect(el.textContent).not.toContain('New in');
    expect(el.textContent).not.toContain('Removed in');
    expect(el.querySelector('.line-through')).toBeNull();
  });

  it('names the pair the diff is measured against', async () => {
    const { fixture, el } = setup({
      ...buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]),
      version_diff: versionDiff(),
    });
    await hydrate(fixture);

    expect(el.textContent).toContain('Changes from 2026.9 · v4');
  });

  it('omits the summary at the earliest pair — a baseline, not a diff', async () => {
    const { fixture, el } = setup({
      ...buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]),
      version_diff: versionDiff({ previous: null }),
    });
    await hydrate(fixture);

    expect(el.textContent).not.toContain('Changes from');
  });

  it('writes the chosen label to the URL, MERGING so ?view= survives', async () => {
    const pair = buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]);
    const { fixture } = setup(
      { ...pair, version_diff: versionDiff({ is_default: false }) },
      { view: 'detailed' },
    );
    await hydrate(fixture);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);

    const page = fixture.componentInstance as unknown as {
      setVersion: (side: 'context' | 'other', label: string) => void;
    };
    page.setVersion('context', '2026.1');

    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { context_version: '2026.1' },
        queryParamsHandling: 'merge',
      }),
    );
  });

  it('offers "Show latest" only on a non-default selection, and clears BOTH params', async () => {
    const pair = buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]);
    const onDefault = setup({ ...pair, version_diff: versionDiff({ is_default: true }) });
    await hydrate(onDefault.fixture);
    // Without a selection there is nowhere to go home to.
    expect(onDefault.el.textContent).not.toContain('Show the latest versions');

    TestBed.resetTestingModule();
    const historical = setup({ ...pair, version_diff: versionDiff({ is_default: false }) });
    await hydrate(historical.fixture);
    expect(historical.el.textContent).toContain('Show the latest versions');

    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const button = [...historical.el.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Show the latest versions'),
    ) as HTMLButtonElement;
    button.click();

    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({
        queryParams: { context_version: null, other_version: null },
        queryParamsHandling: 'merge',
      }),
    );
  });
});
