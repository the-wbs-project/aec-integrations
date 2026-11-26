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
  ProductPairMechanism,
  AgreementState,
  ContextDirection,
  PairClaimAttestation,
  ProductPairClaim,
  ProductPairResponse,
  SyncHeadline,
} from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { ProductsPairPage } from './products-pair';
import { trail } from '../shared/breadcrumb/breadcrumb-trail.harness';

const productListItem = (slug: string, name: string, overrides = {}) => ({
  claim_status: 'claimed' as const,
  categories: [],
  audiences: [],
  phases: [],
  trades: [],
  api_docs_url: null,
  tool_integrations_url: null,
  listed_integration_count: 0,
  id: `00000000-0000-4000-8000-${slug.padEnd(12, '0')}`,
  slug,
  name,
  logo_url: null,
  product_role: 'application' as const,
  connector_kind: null,
  vendor: null,
  integration_count: 1,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-02T00:00:00.000Z',
  ...overrides,
});

const aeciSeed = (): PairClaimAttestation => ({
  source: 'aeci',
  attestor: 'aeci',
  asserted: true,
  note: null,
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

const claim = (slug: string, name: string, direction: ContextDirection): ProductPairClaim => ({
  data_object_slug: slug,
  data_object_name: name,
  direction,
  agreement: 'unverified',
  attestations: [aeciSeed()],
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
        effective_direction: 'outbound',
        description: 'The marketplace connector.',
        listing_url: 'https://example.com/listing',
        docs_url: null,
        built_by_vendor: null,
        powered_by_product: null,
        via: null,
        origin: 'aeci',
        vendor_links: { context: null, other: null },
        claims: [],
      },
    ],
    sync_headline: { total: 0, confirmed: 0, single_source: 0 },
    // The unreviewed baseline (AECI-616): bare attribution, no date.
    maintenance: { maintained_by: 'aeci', last_reviewed_at: null },
    // AECI-303: `null` = the §9 diff does not apply, which is the whole browser-side
    // suppression rule — no selectors, no markers, no history affordance.
    version_diff: null,
    moved_to: null,
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
    // AECI-1835: only the empty pair hosts the correction drawer; this page is unchanged.
    expect(el.querySelector('aec-request-drawer')).toBeNull();
  });

  // AECI-1007: each endpoint vendor's own links, labelled by product (AECI-1141),
  // with AECi's curated link as the per-kind fallback.
  describe('per-side vendor links (AECI-1007)', () => {
    const withLinks = (vendor_links: ProductPairResponse['mechanisms'][number]['vendor_links']) => {
      const pair = buildPair({
        context_product: productListItem('procore', 'Procore', {
          vendor: {
            id: 'v1',
            name: 'Procore Technologies',
            slug: 'procore-tech',
            logo_url: null,
          },
        }),
      });
      pair.mechanisms[0] = {
        ...pair.mechanisms[0]!,
        vendor_links,
        docs_url: 'https://aeci.example/docs',
      };
      return pair;
    };
    const links = (el: HTMLElement) =>
      [...el.querySelectorAll('article a[target="_blank"]')].map((a) => ({
        href: a.getAttribute('href'),
        // The first span is the label; the new-tab icon adds its own hidden text.
        text: a.querySelector('span')?.textContent?.trim(),
        rel: a.getAttribute('rel'),
      }));

    const linkFrom = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-testid="pair-link-from"]')].map((n) => n.textContent?.trim());

    it("marks an endpoint vendor's own link with that vendor (AECI-1614)", () => {
      const { el } = setup(
        withLinks({
          context: { listing_url: 'https://procore.example/l', docs_url: null },
          other: null,
        }),
      );
      expect(linkFrom(el)).toEqual(['Link from Procore Technologies']);
    });

    // AECI-1666: the card no longer carries a caption naming the vendor, so the mark stays.
    it('keeps the mark when the card caption names that vendor', () => {
      const pair = withLinks({
        context: { listing_url: 'https://procore.example/l', docs_url: null },
        other: null,
      });
      pair.mechanisms[0] = {
        ...pair.mechanisms[0]!,
        caption: {
          form: 'updated',
          vendor_names: ['Procore Technologies'],
          date: '2026-10-04T00:00:00.000Z',
        },
      };
      expect(linkFrom(setup(pair).el)).toEqual(['Link from Procore Technologies']);
    });

    it('labels each side by its product name, not its vendor', () => {
      const { el } = setup(
        withLinks({
          context: { listing_url: 'https://procore.example/l', docs_url: null },
          other: { listing_url: 'https://revit.example/l', docs_url: null },
        }),
      );
      const found = links(el);
      expect(found.map((l) => [l.href, l.text])).toEqual([
        // The context side's vendor is "Procore Technologies"; the label is the product.
        ['https://procore.example/l', 'Procore listing'],
        ['https://revit.example/l', 'Revit listing'],
        // No vendor set a docs link, so AECi's curated one stays, unlabelled.
        ['https://aeci.example/docs', 'Documentation'],
      ]);
      // The curated listing link is replaced, not shown beside the vendors' own.
      expect(el.querySelector('a[href="https://example.com/listing"]')).toBeNull();
      for (const l of found) expect(l.rel).toBe('noopener nofollow');
    });

    // AECI-1141: one company owning both products used to label both links
    // "Autodesk listing", so the reader could not tell them apart (WCAG 2.4.4).
    it('gives distinct labels when one vendor owns both products', () => {
      const autodesk = {
        vendor: { id: 'v2', name: 'Autodesk', slug: 'autodesk', logo_url: null },
      };
      const pair = buildPair({
        context_product: productListItem('acad-arch', 'AutoCAD Architecture', autodesk),
        other_product: productListItem('navisworks', 'Navisworks', autodesk),
      });
      pair.mechanisms[0] = {
        ...pair.mechanisms[0]!,
        vendor_links: {
          context: { listing_url: 'https://acad.example/l', docs_url: 'https://acad.example/d' },
          other: { listing_url: 'https://navis.example/l', docs_url: 'https://navis.example/d' },
        },
      };
      const { el } = setup(pair);
      const found = links(el);
      expect(found.map((l) => [l.href, l.text])).toEqual([
        ['https://acad.example/l', 'AutoCAD Architecture listing'],
        ['https://navis.example/l', 'Navisworks listing'],
        ['https://acad.example/d', 'AutoCAD Architecture documentation'],
        ['https://navis.example/d', 'Navisworks documentation'],
      ]);
      expect(new Set(found.map((l) => l.text)).size).toBe(found.length);
      expect(el.textContent).not.toContain('Autodesk listing');
    });

    it('keeps the legacy links when no vendor has set any', () => {
      const { el } = setup(withLinks({ context: null, other: null }));
      expect(links(el).map((l) => l.text)).toEqual(['View listing', 'Documentation']);
    });
  });

  // AECI-919. The rail separator used to be a literal "\u21C4" \u2014 the same character
  // `directionGlyph('both')` emits \u2014 rendered at text-3xl between the two logos.
  // One page, one character, two unrelated meanings, and the non-directional one
  // was the louder. It is now a hairline rule, which carries no vocabulary.
  // AECI-1569: Bing counts an empty alt as missing, on every pair page.
  it('gives both hero logos a real alt', () => {
    const { el } = setup(
      buildPair({
        context_product: productListItem('procore', 'Procore', {
          logo_url: 'https://example.com/procore.png',
        }),
        other_product: productListItem('revit', 'Revit', {
          logo_url: 'https://example.com/revit.png',
        }),
      }),
    );

    const alts = Array.from(el.querySelectorAll('aec-logo-or-initial img')).map((img) =>
      img.getAttribute('alt'),
    );
    expect(alts).toEqual(['Procore logo', 'Revit logo']);
  });

  it('renders the rail separator as a rule, not a glyph', () => {
    const { el } = setup(buildPair());
    // Nothing on this fixture is bidirectional, so the character must be absent
    // from the WHOLE page, not merely from the rail.
    expect(el.textContent).not.toContain('\u21C4');
  });

  it("emits \u21C4 only from directionGlyph('both')", () => {
    const base = buildPair();
    const { el } = setup({
      ...base,
      mechanisms: [{ ...base.mechanisms[0]!, direction: 'both' }],
    });
    // Now it IS on the page \u2014 once, from the mechanism's own direction, beside
    // the copy that explains it.
    expect(el.textContent).toContain('\u21C4');
    expect(el.textContent).toContain('Syncs both ways');
  });

  it('renders the context-relative direction for the mechanism', () => {
    const { el } = setup(buildPair());
    // Context = Procore, integration outbound → "Sends to Revit".
    expect(el.textContent).toContain('Sends to Revit');
  });

  // AECI-919. The band counts Layer-B claims, so it goes empty while the Layer-A
  // direction arrow renders directly beneath it. The default fixture is exactly
  // that shape (`direction: 'outbound'`, no claims), and it used to read "Data
  // flows aren't documented yet" six lines above "Sends to Revit". The direction
  // IS documented; the records that cross are not, and the copy now says so.
  it('renders the DIRECTIONAL empty band when a Layer-A arrow renders under it', () => {
    const { el } = setup(buildPair());
    expect(el.textContent).toContain('We haven’t listed the types of data yet');
    expect(el.textContent).toContain('The direction is shown below');
    expect(el.textContent).not.toContain('We haven’t listed what’s shared yet');
    // The arrow the subline promises is genuinely on the page.
    expect(el.textContent).toContain('Sends to Revit');
  });

  it('keeps the original empty-band copy when no mechanism carries a direction', () => {
    const base = buildPair();
    const { el } = setup({
      ...base,
      mechanisms: [{ ...base.mechanisms[0]!, direction: null }],
    });
    expect(el.textContent).toContain('We haven’t listed what’s shared yet');
    expect(el.textContent).not.toContain('We haven’t listed the types of data yet');
  });

  it('replaces the data band copy with the empty pair body for an unconnected pair', () => {
    const { el } = setup({ ...buildPair(), mechanisms: [] });
    expect(el.textContent).not.toContain('We haven’t listed what’s shared yet');
    expect(el.querySelector('aec-pair-empty-sections')).toBeTruthy();
  });

  // Basic (Overview) hides the standalone Layer-A arrow, so "documented below"
  // would name nothing there. The gate is on the VIEW as well as the data.
  it('falls back to the original empty-band copy in Basic view', () => {
    const { el } = setup(buildPair(), { view: 'basic' });
    expect(el.textContent).toContain('We haven’t listed what’s shared yet');
    expect(el.textContent).not.toContain('The direction is shown below');
  });

  it('renders the sync headline + claim rows grouped by direction (Layer B)', () => {
    const { el } = setup(
      buildPairWithClaims([
        claim('models', 'Models', 'outbound'),
        claim('rfis', 'RFIs', 'inbound'),
      ]),
    );

    // Sync headline leads with breadth; the empty band is gone.
    expect(el.textContent).toContain('2 types of data shared');
    expect(el.textContent).not.toContain('We haven’t listed what’s shared yet');
    // Data-object rows, one per claim, each with a neutral badge + provenance.
    expect(el.textContent).toContain('Models');
    expect(el.textContent).toContain('RFIs');
    expect(el.querySelectorAll('aec-agreement-badge')).toHaveLength(2);
    expect(el.querySelectorAll('aec-claim-provenance')).toHaveLength(2);
    expect(el.textContent).toContain('Listed by AEC Integrations');
    // Grouped into context-relative lanes (headings), not a standalone arrow.
    expect(el.textContent).toContain('Sends to Revit');
    expect(el.textContent).toContain('Receives from Revit');
  });

  it('suppresses the standalone mechanism arrow when the mechanism has claims', () => {
    const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
    // "Sends to Revit" is the lane heading and, since AECI-1720 restore C, the header
    // chip's words too (mock-up 12 draws both). It is never also the standalone
    // mechanism arrow line, so outside the chip it appears exactly once.
    const chipText = el.querySelector('[data-testid="pair-depth-direction"]')?.textContent ?? '';
    const occurrences =
      (el.textContent ?? '').split('Sends to Revit').length -
      chipText.split('Sends to Revit').length;
    expect(occurrences).toBe(1);
    const laneHeadings = Array.from(el.querySelectorAll('h4.aec-overline')).map(
      (h) => h.textContent ?? '',
    );
    expect(laneHeadings.some((t) => t.includes('Sends to Revit'))).toBe(true);
  });

  // AECI-1720 restore C (mock-up 12, .rows): a lane's claim rows are one column, each
  // the full lane wide, whether the card has one lane or two.
  it('lays every claim row across the full lane, one per line', () => {
    // One lane is the case that used to split its rows in two columns from sm.
    const { el } = setup(
      buildPairWithClaims([
        claim('models', 'Models', 'outbound'),
        claim('rfis', 'RFIs', 'outbound'),
      ]),
    );
    const lists = [...el.querySelectorAll('[data-testid="pair-lane-rows"]')];
    expect(lists).toHaveLength(1);
    expect(lists[0]!.className).not.toMatch(/grid-cols-2/);
    expect(lists[0]!.querySelectorAll(':scope > li')).toHaveLength(2);
  });

  describe('depth axis in the mechanism card header (AECI-711)', () => {
    const header = (el: HTMLElement) => el.querySelector('article header')!;
    /** A second, claim-less mechanism. With one mechanism the band headline
     *  carries the count and the card chip is hidden (ruled 2026-09-23), so the
     *  object-chip cases need two. */
    const withSecond = (pair: ProductPairResponse): ProductPairResponse => ({
      ...pair,
      mechanisms: [
        ...pair.mechanisms,
        {
          ...buildPair().mechanisms[0]!,
          id: '00000000-0000-4000-8000-0000000000bb',
          mechanism_name: 'Second mechanism',
        },
      ],
    });

    it('renders the direction chip with an sr-only prefix and an aria-hidden glyph', () => {
      const { el } = setup(buildPair(), { view: 'basic' });
      const chip = header(el).querySelector('[data-testid="pair-depth-direction"]');
      expect(chip).not.toBeNull();
      expect(chip!.querySelector('.sr-only')?.textContent).toContain('Direction:');
      const glyph = chip!.querySelector('[aria-hidden="true"]');
      expect(glyph?.textContent).toBe('\u2192');
      // Mock-up 6's words, naming the partner (AECI-1720 restore C).
      expect(chip!.textContent).toContain('Sends to Revit');
      expect(chip!.textContent).not.toContain('Outbound');
    });

    it('renders the chips in Basic view too', () => {
      const { el } = setup(
        withSecond(buildPairWithClaims([claim('models', 'Models', 'outbound')])),
        {
          view: 'basic',
        },
      );
      expect(header(el).querySelector('[data-testid="pair-depth-direction"]')).not.toBeNull();
      expect(header(el).querySelector('[data-testid="pair-depth-objects"]')?.textContent).toContain(
        '1 type of data',
      );
    });

    it('counts distinct objects across directions (the AECI-1042 rule)', () => {
      const { el } = setup(
        withSecond(
          buildPairWithClaims([
            claim('models', 'Models', 'outbound'),
            claim('models', 'Models', 'inbound'),
            claim('rfis', 'RFIs', 'inbound'),
          ]),
        ),
      );
      expect(
        header(el).querySelector('[data-testid="pair-depth-objects"]')?.textContent?.trim(),
      ).toBe('2 types of data');
    });

    it('does not count a removed claim', () => {
      const { el } = setup(
        withSecond(
          buildPairWithClaims([
            claim('models', 'Models', 'outbound'),
            { ...claim('rfis', 'RFIs', 'inbound'), version_status: 'removed' },
          ]),
        ),
      );
      expect(
        header(el).querySelector('[data-testid="pair-depth-objects"]')?.textContent?.trim(),
      ).toBe('1 type of data');
    });

    // AECI-1140: the card counts like the headline, which drops refuted claims.
    it('does not count a refuted claim', () => {
      const { el } = setup(
        withSecond(
          buildPairWithClaims([
            claim('models', 'Models', 'outbound'),
            { ...claim('rfis', 'RFIs', 'inbound'), refuted: true },
          ]),
        ),
      );
      expect(
        header(el).querySelector('[data-testid="pair-depth-objects"]')?.textContent?.trim(),
      ).toBe('1 type of data');
    });

    it('reads the claims-aware direction, never the stored one', () => {
      // Stored one-way, but the claims sync both ways. The product row reads
      // `both` for this edge, so the chip must too, not the stored `outbound`.
      const base = buildPairWithClaims([
        claim('models', 'Models', 'outbound'),
        claim('rfis', 'RFIs', 'both'),
      ]);
      const { el } = setup({
        ...base,
        mechanisms: [
          { ...base.mechanisms[0]!, direction: 'outbound', effective_direction: 'both' },
        ],
      });
      const chip = header(el).querySelector('[data-testid="pair-depth-direction"]');
      expect(chip?.querySelector('[aria-hidden="true"]')?.textContent).toBe('\u21C4');
      expect(chip?.textContent).toContain('Syncs both ways');
    });

    it('leaves the direction to the Layer-A line in Detailed view when there are no claims', () => {
      const { el } = setup(buildPair());
      expect(header(el).querySelector('[data-testid="pair-depth-direction"]')).toBeNull();
      // The Layer-A line still states it, once.
      expect((el.textContent ?? '').split('Sends to Revit').length - 1).toBe(1);
    });

    it('renders the object chip without a direction chip when neither direction is known', () => {
      const base = buildPairWithClaims([claim('models', 'Models', 'outbound')]);
      const { el } = setup(
        withSecond({
          ...base,
          mechanisms: [{ ...base.mechanisms[0]!, direction: null, effective_direction: null }],
        }),
      );
      expect(header(el).querySelector('[data-testid="pair-depth-direction"]')).toBeNull();
      expect(header(el).querySelector('[data-testid="pair-depth-objects"]')).not.toBeNull();
    });

    it('renders the connector-evidenced arm the same way', () => {
      const base = buildPairWithClaims([claim('models', 'Models', 'both')]);
      const { el } = setup(
        withSecond({
          ...base,
          mechanisms: [
            {
              ...base.mechanisms[0]!,
              mechanism_kind: null,
              direction: 'both',
              effective_direction: 'both',
              via: { id: 'z1', slug: 'zapier', name: 'Zapier', logo_url: null },
            },
          ],
        }),
      );
      const chip = header(el).querySelector('[data-testid="pair-depth-direction"]');
      expect(chip?.querySelector('[aria-hidden="true"]')?.textContent).toBe('\u21C4');
      expect(header(el).querySelector('[data-testid="pair-depth-objects"]')).not.toBeNull();
    });

    it('hides the object chip when one mechanism and the headline already carry the count', () => {
      const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
      expect(el.textContent).toContain('1 type of data shared');
      expect(header(el).querySelector('[data-testid="pair-depth-objects"]')).toBeNull();
      // The direction chip is unaffected: the headline does not state a direction.
      expect(header(el).querySelector('[data-testid="pair-depth-direction"]')).not.toBeNull();
    });
  });

  it('renders the singular sync headline for one claim', () => {
    const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
    expect(el.textContent).toContain('1 type of data shared');
  });

  it('keeps a mechanism-card h3 when the mechanism is unnamed but has claims (no h2→h4 skip)', () => {
    const pair = buildPairWithClaims([claim('models', 'Models', 'outbound')]);
    const { el } = setup({
      ...pair,
      mechanisms: [{ ...pair.mechanisms[0]!, mechanism_name: null }],
    });
    // Detailed view (the default) renders the Layer-B lane <h4>s. Without a card
    // <h3> the hierarchy would jump data <h2> → lane <h4>. The kind label is
    // promoted into the heading as the fallback (ruling 10 of 2026-11-16: h2/h3/h4).
    const cardHeadings = Array.from(el.querySelectorAll('article h3')).map((h) =>
      h.textContent?.trim(),
    );
    expect(cardHeadings.some((t) => t?.includes('Marketplace app'))).toBe(true);
    expect(el.querySelector('article h4.aec-overline')).toBeTruthy();
  });

  it('drops the old empty-mechanisms sentence for the statement (AECI-1827)', () => {
    const { el } = setup(buildPair({ mechanisms: [] }));
    expect(el.textContent).not.toContain('don’t have any integrations documented');
    expect(el.textContent).toContain('We have no integration between Procore and Revit on record.');
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
        },
      },
      other_product: {
        ...pair.other_product,
        vendor: { id: 'v2', name: 'Globex', slug: 'globex', logo_url: null },
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

    it('shows no account label beside an active vendor (AECI-1131)', () => {
      const el = renderState('unverified', [aeciSeed()]);
      expect(el.textContent).toContain('Acme Software');
      expect(el.querySelector('aec-vendor-account-badge')).toBeNull();
      expect(el.textContent).not.toContain('Account active');
    });

    it('renders 0 voters as the neutral unverified chip', () => {
      expect(renderState('unverified', [aeciSeed()]).textContent).toContain(
        'Listed by AEC Integrations',
      );
    });

    it('renders a denied-only claim as "A company says no", never as a conflict', () => {
      const el = setup(
        withVendors(
          buildPairWithClaims([
            {
              ...claimInState('rfis', 'RFIs', 'unverified', [
                aeciSeed(),
                vendorVote('context', false),
              ]),
              refuted: true,
            },
          ]),
        ),
      ).el;
      expect(el.textContent).toContain('A company says no');
      expect(el.textContent).not.toContain('Listed by AEC Integrations');
      expect(el.textContent).not.toContain('Companies disagree');
    });

    // AECI-1140: nothing counts, so the heading is empty, but it must not say
    // "haven't listed" above the row it lists.
    it('gives a pair whose only claim is refuted the refuted heading', () => {
      const pair = withVendors(
        buildPairWithClaims(
          [
            {
              ...claimInState('rfis', 'RFIs', 'unverified', [
                aeciSeed(),
                vendorVote('context', false),
              ]),
              refuted: true,
            },
          ],
          { total: 0 },
        ),
      );
      for (const view of ['detailed', 'basic'] as const) {
        TestBed.resetTestingModule();
        const heading = setup(pair, { view }).el.querySelector('[data-testid="pair-data-heading"]');
        expect(heading?.textContent).toContain('No type of data is confirmed');
        expect(heading?.textContent).not.toContain('We haven’t listed');
      }
    });

    // An older API sends no `refuted`. The badge falls back to today's reading.
    it('renders the neutral chip when the API sends no refuted flag', () => {
      const el = renderState('unverified', [aeciSeed(), vendorVote('context', false)]);
      expect(el.textContent).toContain('Listed by AEC Integrations');
    });

    it('renders single_source attributed to the affirming vendor', () => {
      const el = renderState('single_source', [aeciSeed(), vendorVote('context', true)], {
        single_source: 1,
      });
      expect(el.textContent).toContain('Confirmed by Acme Software');
      // Never the bilateral wording.
      expect(el.textContent).not.toContain('Confirmed by both companies');
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
      expect(el.textContent).toContain('Confirmed by both companies');
    });

    it('renders conflict as a disagreement between vendors', () => {
      const el = renderState('conflict', [vendorVote('context', true), vendorVote('other', false)]);
      expect(el.textContent).toContain('Companies disagree');
    });

    // AECI-1142. Ruling 2026-09-28 (Chris): the summary band and ratio line are
    // replaced by the per-card At a glance row. The per-row badges carry the state.
    it('renders no ratio line and no summary subline, whatever the counts', () => {
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
      const text = el.textContent ?? '';
      expect(text).toContain('2 types of data shared');
      expect(text).not.toContain('of 2 confirmed');
      expect(text).not.toContain('confirmed by one company only');
      expect(text).not.toContain('compiled these from public sources');
      expect(el.querySelector('aec-confirmed-ratio-info')).toBeNull();
      // The badges still say who confirmed what, row by row.
      expect(text).toContain('Confirmed by both companies');
      // AECI-781: the vendor portal shipped 2026-09-03. No surface on this page
      // may describe it as forthcoming again.
      expect(text).not.toContain('vendor portal');
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
      expect(el.textContent).not.toContain('Companies disagree');
      // The headline survives — Basic hides granularity, not breadth.
      expect(el.textContent).toContain('1 type of data shared');
    });
  });

  it('renders the NotFound shell when the pair is null', () => {
    const { el } = setup(null);
    expect(el.querySelector('aec-not-found')).toBeTruthy();
  });

  // AECI-1142 moved the Stage 1 §4.4 byline into the At a glance strip's
  // "How you get it" fact, worded "Offered by" / "Through".
  describe('connector byline in At a glance (Offered by / Through)', () => {
    const agaveVendor = {
      id: '00000000-0000-4000-8000-0000000000v1',
      name: 'Agave',
      slug: 'agave',
      logo_url: null,
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

      const glance = el.querySelector('[data-testid="pair-glance"]')!;
      expect(glance.textContent).toContain('Offered by');
      expect(glance.textContent).toContain('through');
      const vendorLink = glance.querySelector('a[href="/vendors/agave"]');
      const productLink = glance.querySelector('a[href="/products/agave-erp-sync"]');
      expect(vendorLink?.textContent).toContain('Agave');
      expect(productLink?.textContent).toContain('Agave ERP Sync');
    });

    it('keeps a space between the label and its link', () => {
      // Angular strips the newline between `</ng-container>` and `<a>` under the
      // default `preserveWhitespaces: false`, which rendered "Offered byAgave".
      // The `&ngsp;` entities in the template are what put the space back.
      const { el } = setup(buildPairWithProvenance(agaveVendor, agaveProduct));
      const text = el.textContent!.replace(/\s+/g, ' ');

      expect(text).toContain('Offered by Agave, through Agave ERP Sync');
    });

    it('falls back to the vendor-only segment when powered_by_product is null', () => {
      const { el } = setup(buildPairWithProvenance(agaveVendor, null));

      expect(el.textContent).toContain('Offered by');
      expect(el.querySelector('a[href="/vendors/agave"]')).toBeTruthy();
      expect(el.textContent).not.toContain('through');
      expect(el.querySelector('a[href="/products/agave-erp-sync"]')).toBeNull();
    });

    it('renders the connector byline from `via` on a connector-evidenced pair (AECI-721)', () => {
      // After the migration these 19 production pairs live in
      // `connector_evidenced_pairs`, where the connector is `via` and
      // `powered_by_product` is null by construction. Reading only
      // `powered_by_product` would silently drop the byline — the pair page would
      // name no connector for an edge that exists ONLY because of one.
      const { el } = setup(buildPairWithProvenance(null, null, agaveProduct));

      expect(el.textContent?.replace(/\s+/g, ' ')).toContain('Through Agave ERP Sync');
      expect(el.querySelector('a[href="/products/agave-erp-sync"]')).toBeTruthy();
      expect(el.textContent).not.toContain('Offered by');
    });

    it('renders no byline when neither field is set', () => {
      const { el } = setup(buildPair());

      expect(el.textContent).not.toContain('Offered by');
      expect(el.textContent).not.toContain('Through');
    });

    it('says a vendor-created row was added by the vendor, naming nobody (AECI-1011)', () => {
      const base = buildPairWithProvenance(agaveVendor, null);
      const pair = { ...base, mechanisms: [{ ...base.mechanisms[0]!, origin: 'vendor' as const }] };
      const { el } = setup(pair);

      expect(el.querySelector('[data-testid="pair-vendor-added"]')?.textContent).toContain(
        'Added by the vendor',
      );
    });

    it('adds no provenance note to an AECi-seeded row', () => {
      const { el } = setup(buildPairWithProvenance(agaveVendor, null));

      expect(el.querySelector('[data-testid="pair-vendor-added"]')).toBeNull();
    });

    it('keeps the byline visible in Basic view (identity, not detail)', () => {
      const { el } = setup(buildPairWithProvenance(agaveVendor, agaveProduct), {
        view: 'basic',
      });

      expect(el.querySelector('a[href="/products/agave-erp-sync"]')).toBeTruthy();
      expect(el.textContent).toContain('Offered by');
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
      // The only overline h4 left is the At a glance strip's, never a lane heading.
      const h4s = Array.from(el.querySelectorAll('h4.aec-overline')).map((h) =>
        h.textContent?.trim(),
      );
      expect(h4s).toEqual(['At a glance']);
      expect(el.textContent).not.toContain('Receives from Revit');
      // The Overview essentials remain.
      expect(el.textContent).toContain('2 types of data shared');
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
      // The header chip still names the direction in Basic (AECI-711), so the Layer-A
      // line is the one statement left out.
      const occurrences = (el.textContent ?? '').split('Sends to Revit').length - 1;
      expect(occurrences).toBe(1);
      expect(el.querySelector('[data-testid="pair-depth-direction"]')!.textContent).toContain(
        'Sends to Revit',
      );
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

// ─── AECI-1142: reader wording, the section heading and At a glance ──────────
//
// Ruling 2026-09-28 (Chris): the summary band and ratio line are replaced by the
// per-card At a glance row.
describe('ProductsPairPage: plain wording and At a glance (AECI-1142)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearViewCookie();
  });

  const withFacts = (overrides: Partial<ProductPairResponse['mechanisms'][number]> = {}) => {
    const base = buildPairWithClaims(
      [claim('models', 'Models', 'outbound'), claim('rfis', 'RFIs', 'inbound')],
      { confirmed: 0 },
    );
    return {
      ...base,
      maintenance: {
        maintained_by: 'vendor' as const,
        last_reviewed_at: '2026-09-20T10:00:00.000Z',
      },
      mechanisms: [
        {
          ...base.mechanisms[0]!,
          built_by_vendor: {
            id: '00000000-0000-4000-8000-000000000b01',
            slug: 'procore',
            name: 'Procore Technologies',
            logo_url: null,
          },
          pricing_model: 'Free with a Procore subscription',
          maturity: 'Generally available',
          last_reviewed_at: '2026-09-20T10:00:00.000Z',
          ...overrides,
        },
      ],
    };
  };

  it('uses no data-model jargon anywhere on the rendered page', () => {
    const { el } = setup(withFacts());
    const text = el.textContent ?? '';
    for (const word of [
      'Provenance',
      'asserts',
      'data object',
      'Unverified',
      'Vendor-maintained',
      'a company involved',
      'Maintained by AEC Integrations',
      'Kept up to date by',
    ]) {
      expect(text).not.toContain(word);
    }
  });

  it('states the count as a section heading, with no band, ratio or "i"', () => {
    const { el } = setup(withFacts());
    const heading = el.querySelector('[data-testid="pair-data-heading"] h2');
    expect(heading?.textContent?.trim()).toBe('2 types of data shared');
    expect(el.textContent).not.toContain('confirmed by both companies ·');
    expect(el.textContent).not.toContain('of 2 confirmed');
    expect(el.querySelector('aec-confirmed-ratio-info')).toBeNull();
  });

  it('has no data heading when the pair has no integration (AECI-1827)', () => {
    const { el } = setup({ ...buildPair(), mechanisms: [] });
    expect(el.querySelector('[data-testid="pair-data-heading"]')).toBeNull();
  });

  it('tints the At a glance strip Bone, as a nested fill with no border and no shadow', () => {
    const { el } = setup(withFacts());
    const strip = el.querySelector('[data-testid="pair-glance"]')!;
    expect(strip.className).toContain('bg-(--accent-warm)');
    expect(strip.className).toContain('rounded-panel');
    expect(strip.className.split(/\s+/)).not.toContain('border');
    expect(strip.className).not.toContain('shadow');
    // The strip only: the card around it is the white shared card (AECI-1798).
    expect(strip.closest('article')!.className).toContain('bg-(--surface-base)');
    expect(strip.closest('article')!.className).toContain('shadow-card');
  });

  // AECI-1666: the header chip is retired; the record line opens the panel.
  it('names no company on the record line, and drops its date', () => {
    const { el } = setup(withFacts());
    expect(el.querySelector('header aec-maintenance-marker')).toBeNull();
    const line = el
      .querySelector('[data-testid="listing-provenance"] aec-maintenance-marker')
      ?.textContent?.trim();
    expect(line).toBe('Vendor maintained');
  });

  it('reads the AECi record line when neither product is claimed (ruling 3)', () => {
    const pair = withFacts();
    const { el } = setup({
      ...pair,
      context_product: { ...pair.context_product, claim_status: 'unclaimed' },
      other_product: { ...pair.other_product, claim_status: 'unclaimed' },
    });
    expect(el.textContent).not.toContain('Vendor maintained');
  });

  it('renders At a glance on the card with all four facts', () => {
    const { el } = setup(withFacts());
    const glance = el.querySelector('[data-testid="pair-glance"]');
    expect(glance).toBeTruthy();
    const text = glance!.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('At a glance');
    expect(text).toContain('Price Free with a Procore subscription');
    expect(text).toContain('Release stage Generally available');
    expect(text).toContain('How you get it Marketplace app');
    expect(text).toContain('Offered by Procore Technologies');
    expect(text).toContain('Last checked September 20, 2026');
    expect(glance!.querySelector('a[href="/vendors/procore"]')).toBeTruthy();
  });

  it('moves the kind and byline into the facts instead of repeating them', () => {
    const { el } = setup(withFacts());
    const text = el.textContent ?? '';
    expect(text.split('Marketplace app').length - 1).toBe(1);
    expect(text.split('Offered by').length - 1).toBe(1);
    // The card states its own date, so the header marker keeps attribution only.
    expect(el.querySelector('aec-maintenance-marker')?.textContent).not.toMatch(/\d{4}/);
  });

  it('leaves out a fact with no value, and the strip when none has one', () => {
    const partial = setup(withFacts({ pricing_model: null, maturity: '  ' }));
    const text = partial.el.querySelector('[data-testid="pair-glance"]')?.textContent ?? '';
    expect(text).not.toContain('Price');
    expect(text).not.toContain('Release stage');
    expect(text).toContain('How you get it');
    TestBed.resetTestingModule();

    const empty = setup(
      withFacts({
        mechanism_name: null,
        built_by_vendor: null,
        pricing_model: undefined,
        maturity: undefined,
        last_reviewed_at: undefined,
      }),
    );
    expect(empty.el.querySelector('[data-testid="pair-glance"]')).toBeNull();
  });

  // AECI-1158 (STAGE_2_VENDOR_PORTAL_SPEC.md §6.17.11): the Price fact links to the
  // owner's pricing page.
  const PRICING = 'https://procore.example/pricing';
  const priceFact = (el: HTMLElement) =>
    [...el.querySelectorAll('[data-testid="pair-glance"] dt')]
      .find((dt) => dt.textContent?.trim() === 'Price')
      ?.parentElement?.querySelector('dd') ?? null;

  it('links the price text to the pricing page when both are set', () => {
    const { el } = setup(withFacts({ pricing_url: PRICING }));
    const link = priceFact(el)?.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe(PRICING);
    expect(link?.textContent).toContain('Free with a Procore subscription');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener nofollow');
    expect(link?.querySelector('aec-new-tab-icon')).toBeTruthy();
  });

  it('shows "See pricing" when only the pricing page is set', () => {
    const { el } = setup(withFacts({ pricing_model: null, pricing_url: PRICING }));
    const link = priceFact(el)?.querySelector<HTMLAnchorElement>('a');
    expect(link?.getAttribute('href')).toBe(PRICING);
    expect(link?.textContent).toContain('See pricing');
  });

  it('keeps a price with no pricing page as plain text', () => {
    const { el } = setup(withFacts({ pricing_url: null }));
    const dd = priceFact(el);
    expect(dd?.textContent?.trim()).toBe('Free with a Procore subscription');
    expect(dd?.querySelector('a')).toBeNull();
  });

  it('hides the Price fact when neither the price nor the page is set', () => {
    const { el } = setup(withFacts({ pricing_model: null, pricing_url: undefined }));
    expect(priceFact(el)).toBeNull();
    expect(el.querySelector('[data-testid="pair-glance-price-link"]')).toBeNull();
  });

  it('never links a pricing page that is not http(s)', () => {
    const withPrice = setup(withFacts({ pricing_url: 'javascript:alert(1)' }));
    expect(priceFact(withPrice.el)?.querySelector('a')).toBeNull();
    expect(priceFact(withPrice.el)?.textContent?.trim()).toBe('Free with a Procore subscription');
    TestBed.resetTestingModule();

    const noPrice = setup(withFacts({ pricing_model: null, pricing_url: 'javascript:alert(1)' }));
    expect(priceFact(noPrice.el)).toBeNull();
  });

  it('names the connector on a connector-evidenced pair', () => {
    const { el } = setup(
      withFacts({
        mechanism_kind: null,
        built_by_vendor: null,
        via: { id: 'c1', slug: 'agave-erp-sync', name: 'Agave ERP Sync', logo_url: null },
      }),
    );
    const glance = el.querySelector('[data-testid="pair-glance"]');
    expect(glance?.textContent?.replace(/\s+/g, ' ')).toContain('Through Agave ERP Sync');
    expect(glance?.querySelector('a[href="/products/agave-erp-sync"]')).toBeTruthy();
  });
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
    // The edge colour is the unlayered class. A border-colour utility rendered grey
    // until AECI-2088 moved the `* { border-color }` rule into `@layer base`.
    const row = el.querySelector('aec-agreement-badge')?.closest('li');
    expect(row?.classList).toContain('aec-diff-added');
    expect(row?.classList).toContain('border-s-2');
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
    expect(el.querySelector('aec-agreement-badge')?.closest('li')?.classList).toContain(
      'aec-diff-removed',
    );
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

// AECI-933: every outbound click on the pair page records whose site it leads to
// and whose link it is. The owner rules are the spec's §3.2 table.
describe('ProductsPairPage: outbound click ownership (AECI-933)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearViewCookie();
  });

  const vendor = (id: string, name: string) => ({
    id,
    name,
    slug: name.toLowerCase(),
    logo_url: null,
  });
  const PROCORE_INC = '00000000-0000-4000-8000-000000000c01';
  const AUTODESK = '00000000-0000-4000-8000-000000000c02';
  const BUILDER = '00000000-0000-4000-8000-000000000c03';
  const ZAPIER_INC = '00000000-0000-4000-8000-000000000c04';
  const PROCORE_ID = productListItem('procore', 'Procore').id;
  const REVIT_ID = productListItem('revit', 'Revit').id;
  // Lower id first, BINARY: "procore…" sorts before "revit…".
  const PAIR_KEY = `${PROCORE_ID}:${REVIT_ID}`;

  type Mechanism = ProductPairResponse['mechanisms'][number];

  /** Procore (context) by Procore Inc, Revit (other) by Autodesk, one mechanism. */
  function pairWith(overrides: Partial<Mechanism> = {}, swap = false): ProductPairResponse {
    const procore = productListItem('procore', 'Procore', {
      vendor: vendor(PROCORE_INC, 'Procore Inc'),
    });
    const revit = productListItem('revit', 'Revit', { vendor: vendor(AUTODESK, 'Autodesk') });
    const base = buildPair({
      context_product: swap ? revit : procore,
      other_product: swap ? procore : revit,
    });
    return { ...base, mechanisms: [{ ...base.mechanisms[0]!, ...overrides }] };
  }

  function render(pair: ProductPairResponse) {
    const analytics = { externalLinkClicked: vi.fn(), integrationViewed: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: Analytics, useValue: analytics }] });
    const { el } = setup(pair);
    // Keep the test runner on the page: the tracker's own listener still runs.
    el.addEventListener('click', (e) => e.preventDefault());
    const click = (href: string) => {
      const anchor = el.querySelector(`a[href="${href}"]`) as HTMLAnchorElement | null;
      expect(anchor, href).not.toBeNull();
      anchor!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return analytics.externalLinkClicked.mock.lastCall?.[0];
    };
    return { analytics, click };
  }

  describe("AECi's curated fallback links (link_origin aeci)", () => {
    it('are owned by the vendor that built the row first', () => {
      const { click } = render(
        pairWith({
          built_by_vendor: vendor(BUILDER, 'Builder'),
          connector_vendor_id: ZAPIER_INC,
          docs_url: 'https://aeci.example/docs',
        }),
      );
      expect(click('https://example.com/listing')).toEqual({
        destination: 'https://example.com/listing',
        source: 'pair_detail',
        owner_vendor_id: BUILDER,
        link_origin: 'aeci',
        source_entity_type: 'pair',
        source_entity_id: PAIR_KEY,
        link_purpose: 'listing',
      });
      expect(click('https://aeci.example/docs')).toMatchObject({
        owner_vendor_id: BUILDER,
        link_origin: 'aeci',
        link_purpose: 'docs',
      });
    });

    it("fall back to the powered_by connector's vendor when no vendor built the row", () => {
      const { click } = render(
        pairWith({
          built_by_vendor: null,
          powered_by_product: {
            id: '00000000-0000-4000-8000-0000000000z1',
            name: 'Zapier',
            slug: 'zapier',
            logo_url: null,
          },
          connector_vendor_id: ZAPIER_INC,
        }),
      );
      expect(click('https://example.com/listing')).toMatchObject({
        owner_vendor_id: ZAPIER_INC,
        link_origin: 'aeci',
      });
    });

    it("fall back to the via connector's vendor on a connector-evidenced pair", () => {
      const { click } = render(
        pairWith({
          mechanism_kind: null,
          built_by_vendor: null,
          via: {
            id: '00000000-0000-4000-8000-0000000000z1',
            name: 'Zapier',
            slug: 'zapier',
            logo_url: null,
          },
          connector_vendor_id: ZAPIER_INC,
        }),
      );
      expect(click('https://example.com/listing')).toMatchObject({
        owner_vendor_id: ZAPIER_INC,
        link_origin: 'aeci',
      });
    });

    it('send a null owner when there is neither a builder nor a connector vendor', () => {
      // `connector_vendor_id` absent, as an API Worker older than AECI-933 sends it.
      const { click } = render(pairWith({ built_by_vendor: null }));
      const call = click('https://example.com/listing');
      expect(call).toHaveProperty('owner_vendor_id', null);
      expect(call).toMatchObject({ link_origin: 'aeci', link_purpose: 'listing' });
    });
  });

  it("owns a side's own link by that side's vendor, with link_origin vendor", () => {
    const { click } = render(
      pairWith({
        // A builder is set, and must NOT take credit for a side's own link.
        built_by_vendor: vendor(BUILDER, 'Builder'),
        vendor_links: {
          context: { listing_url: null, docs_url: 'https://procore.example/d' },
          other: { listing_url: 'https://revit.example/l', docs_url: null },
        },
      }),
    );
    expect(click('https://revit.example/l')).toEqual({
      destination: 'https://revit.example/l',
      source: 'pair_detail',
      owner_vendor_id: AUTODESK,
      link_origin: 'vendor',
      source_entity_type: 'pair',
      source_entity_id: PAIR_KEY,
      link_purpose: 'listing',
    });
    expect(click('https://procore.example/d')).toMatchObject({
      owner_vendor_id: PROCORE_INC,
      link_origin: 'vendor',
      link_purpose: 'docs',
    });
  });

  it('owns the price link by the row builder, with purpose pricing', () => {
    const { click } = render(
      pairWith({
        built_by_vendor: vendor(BUILDER, 'Builder'),
        connector_vendor_id: ZAPIER_INC,
        pricing_url: 'https://builder.example/pricing',
      }),
    );
    expect(click('https://builder.example/pricing')).toEqual({
      destination: 'https://builder.example/pricing',
      source: 'pair_detail',
      owner_vendor_id: BUILDER,
      link_origin: 'vendor',
      source_entity_type: 'pair',
      source_entity_id: PAIR_KEY,
      link_purpose: 'pricing',
    });
  });

  it('sends a null price owner when no vendor built the row, never the connector', () => {
    const { click } = render(
      pairWith({
        built_by_vendor: null,
        connector_vendor_id: ZAPIER_INC,
        pricing_url: 'https://example.com/pricing',
      }),
    );
    expect(click('https://example.com/pricing')).toHaveProperty('owner_vendor_id', null);
  });

  it('reports the same pair key from both URL orientations', () => {
    const forward = render(pairWith()).click('https://example.com/listing');
    TestBed.resetTestingModule();
    const reverse = render(pairWith({}, true)).click('https://example.com/listing');
    expect(forward?.source_entity_id).toBe(PAIR_KEY);
    expect(reverse?.source_entity_id).toBe(PAIR_KEY);
  });
});

describe('ProductsPairPage unclaimed wording (AECI-1618)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('gives each unclaimed product its own wording, beside its own logo', () => {
    const { fixture } = setup(
      buildPair({
        context_product: { ...productListItem('procore', 'Procore'), claim_status: 'unclaimed' },
        other_product: { ...productListItem('revit', 'Revit'), claim_status: 'unclaimed' },
      }),
    );
    const notes = (fixture.nativeElement as HTMLElement).querySelectorAll('aec-unclaimed-note');
    expect(notes.length).toBe(2);
    notes.forEach((note) =>
      expect(note.previousElementSibling?.tagName.toLowerCase()).toBe('aec-logo-or-initial'),
    );
  });

  // AECI-1769: both subjects carry a logo. The unclaimed side shows it only beside its
  // note, at 32px. The claimed side keeps its 64px logo.
  it('shows the unclaimed side logo only beside its note in a mixed pair', () => {
    const { fixture } = setup(
      buildPair({
        context_product: {
          ...productListItem('procore', 'Procore'),
          logo_url: 'https://cdn.example.com/procore.png',
          claim_status: 'claimed',
        },
        other_product: {
          ...productListItem('revit', 'Revit'),
          logo_url: 'https://cdn.example.com/revit.png',
          claim_status: 'unclaimed',
        },
      }),
    );
    const el = fixture.nativeElement as HTMLElement;
    const imgs = (src: string) =>
      [...el.querySelectorAll('img')].filter((i) => i.getAttribute('src') === src);
    const revit = imgs('https://cdn.example.com/revit.png');
    expect(revit).toHaveLength(1);
    expect(revit[0]!.getAttribute('width')).toBe('32');
    expect(revit[0]!.closest('aec-logo-or-initial')?.nextElementSibling?.tagName).toBe(
      'AEC-UNCLAIMED-NOTE',
    );
    const procore = imgs('https://cdn.example.com/procore.png');
    expect(procore).toHaveLength(1);
    expect(procore[0]!.getAttribute('width')).toBe('64');
  });

  it('marks only the unclaimed side of a mixed pair', () => {
    const { fixture } = setup(
      buildPair({
        other_product: { ...productListItem('revit', 'Revit'), claim_status: 'unclaimed' },
      }),
    );
    const notes = (fixture.nativeElement as HTMLElement).querySelectorAll('aec-unclaimed-note');
    expect(notes.length).toBe(1);
    // AECI-1798: only the name is a link now, so the note sits in the side's card,
    // whose name links to the unclaimed product.
    const card = notes[0]!.closest('[data-testid^="pair-side-"]')!;
    expect(card.getAttribute('data-testid')).toBe('pair-side-other');
    expect(card.querySelector('a')?.getAttribute('href')).toContain('/products/revit');
  });
});

// AECI-1666: every caption and correction moved off the cards into one "About this
// listing" panel after them.
describe('ProductsPairPage: provenance panel (AECI-1666)', () => {
  const CAPTION = {
    form: 'updated' as const,
    vendor_names: ['Autodesk'],
    date: '2026-10-04T00:00:00.000Z',
  };
  const correction = (field: string, cleared = false, source_url: string | null = null) => ({
    field,
    date: '2026-09-15T00:00:00.000Z',
    source_url,
    cleared,
  });
  const lines = (el: Element, id: string) =>
    Array.from(el.querySelectorAll(`[data-testid="${id}"]`)).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );
  const render = (mechanisms: Partial<ProductPairMechanism>[]) => {
    const base = buildPair().mechanisms[0]!;
    const { fixture } = setup(
      buildPair({
        mechanisms: mechanisms.map((m, i) => ({ ...base, id: `m${i}`, ...m })),
      }),
    );
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };
  const panel = (el: HTMLElement) => el.querySelector('[data-testid="listing-provenance"]')!;

  it('puts no caption or correction on a card', () => {
    const el = render([
      {
        caption: CAPTION,
        corrections: [
          correction('description'),
          correction('pricing_model'),
          correction('docs_url', true),
          correction('direction'),
        ],
        pricing_model: 'Free',
      },
    ]);
    const card = el.querySelector('article')!;
    expect(card.querySelector('aec-field-caption')).toBeNull();
    expect(card.querySelector('[data-testid="pair-header-corrections"]')).toBeNull();
    expect(card.querySelector('[data-testid="pair-removed-links"]')).toBeNull();
    for (const caption of Array.from(el.querySelectorAll('aec-field-caption'))) {
      expect(caption.closest('aec-listing-provenance')).not.toBeNull();
    }
  });

  it('mounts the panel after the cards, card and disclosure, one test id', () => {
    const el = render([{ caption: CAPTION }]);
    const copies = el.querySelectorAll('aec-listing-provenance');
    expect(copies).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="listing-provenance"]')).toHaveLength(1);
    const lastCard = el.querySelectorAll('article')[0]!;
    expect(
      lastCard.compareDocumentPosition(panel(el)) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('lists one mechanism by field alone', () => {
    const el = render([
      {
        caption: CAPTION,
        maturity: 'GA',
        corrections: [
          correction('docs_url', true),
          correction('maturity', false, 'https://s.example'),
        ],
      },
    ]);
    expect(lines(panel(el), 'field-caption')).toEqual([
      'Maintained by Autodesk · updated October 4, 2026',
    ]);
    const found = lines(panel(el), 'field-correction');
    expect(found[0]).toBe('Documentation link: Removed by AEC Integrations on September 15, 2026');
    expect(found[1]).toMatch(
      /^Release stage: Corrected by AEC Integrations on September 15, 2026 · Source/,
    );
  });

  // AECI-2139 (P10a): AECi's correction of one data flow names no data type.
  it('lists a data flow removal and a direction correction, with no slot rule', () => {
    const el = render([
      {
        corrections: [
          correction('data_flow', true, 'https://s.example'),
          correction('data_flow', false, 'https://s.example'),
        ],
      },
    ]);
    const found = lines(panel(el), 'field-correction');
    expect(found[0]).toMatch(
      /^A data flow: Removed by AEC Integrations on September 15, 2026 · Source/,
    );
    expect(found[1]).toMatch(
      /^A data flow: Corrected by AEC Integrations on September 15, 2026 · Source/,
    );
  });

  it('prefixes each line with the card heading when there is more than one mechanism', () => {
    const el = render([
      { mechanism_name: 'Bridge', caption: CAPTION },
      { mechanism_name: null, mechanism_kind: 'api', corrections: [correction('direction')] },
      { caption: { ...CAPTION, form: 'until', vendor_names: ['Autodesk', 'Procore'] } },
    ]);
    expect(lines(panel(el), 'field-caption')).toEqual([
      'Bridge: Maintained by Autodesk · updated October 4, 2026',
      'Procore + Autodesk Construction Cloud: Maintained by Autodesk and Procore until October 4, 2026',
    ]);
    expect(lines(panel(el), 'field-correction')).toEqual([
      'API, Direction: Corrected by AEC Integrations on September 15, 2026',
    ]);
  });

  // §4.5.8: a removed or corrected curated link whose slot a vendor's own link fills
  // shows no line, because the card renders the vendor's link instead.
  it('drops a curated-link correction when a vendor link of that kind fills the slot', () => {
    const el = render([
      {
        listing_url: 'https://example.com/listing',
        docs_url: null,
        vendor_links: {
          context: { listing_url: 'https://vendor.example/listing', docs_url: null },
          other: { listing_url: null, docs_url: 'https://vendor.example/docs' },
        },
        corrections: [correction('listing_url'), correction('docs_url', true)],
      },
    ]);
    expect(lines(panel(el), 'field-correction')).toEqual([]);
  });

  it('lists a curated-link correction and removal when no vendor link fills the slot', () => {
    const el = render([
      {
        listing_url: 'https://example.com/listing',
        docs_url: null,
        vendor_links: { context: null, other: null },
        corrections: [correction('listing_url'), correction('docs_url', true)],
      },
    ]);
    expect(lines(panel(el), 'field-correction')).toEqual([
      'Listing link: Corrected by AEC Integrations on September 15, 2026',
      'Documentation link: Removed by AEC Integrations on September 15, 2026',
    ]);
  });

  it('drops a correction on a field the card never renders, or on a value it does not show', () => {
    const el = render([
      {
        pricing_model: null,
        corrections: [
          correction('website'),
          correction('mechanism_url', true),
          correction('pricing_model'),
          correction('description', true),
        ],
      },
    ]);
    expect(lines(panel(el), 'field-correction')).toEqual([]);
  });

  it('counts the values under review across the cards', () => {
    const el = render([
      { description: null, under_review: ['description'] },
      { docs_url: null, under_review: ['docs_url'] },
    ]);
    expect(lines(panel(el), 'provenance-under-review')).toEqual([
      '2 values on this page are under review.',
    ]);
  });

  // Ruling 2026-11-17: every listing shows the panel, including one AECi maintains alone.
  it('shows the panel with the AECi record line when nothing else applies', () => {
    const el = render([{}]);
    expect(panel(el).hasAttribute('hidden')).toBe(false);
    expect(panel(el).querySelector('li')?.textContent?.trim()).toBe('AEC Integrations maintained');
    expect(panel(el).querySelectorAll('li')).toHaveLength(1);
  });

  // §4.5.8: "No page hides the panel". An empty pair has no card to follow, so both copies
  // end its last band, after the API note.
  it('shows the panel on an empty pair, at the end of its last band', () => {
    const el = render([]);
    const lookItUp = el.querySelector('[data-testid="pair-empty-look-it-up"]')!;
    const card = lookItUp.querySelector('[data-testid="listing-provenance"]')!;
    expect(card).toBeTruthy();
    expect(card.hasAttribute('hidden')).toBe(false);
    expect(card.querySelector('li')?.textContent?.trim()).toBe('AEC Integrations maintained');
    expect(lookItUp.querySelectorAll('aec-listing-provenance')).toHaveLength(2);
    const note = lookItUp.querySelector('[data-testid="pair-look-api-note"]')!;
    expect(note.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('drops a price or stage whose value AECi removed from At a glance', () => {
    const el = render([
      {
        pricing_model: null,
        maturity: null,
        built_by_vendor: null,
        corrections: [correction('pricing_model', true), correction('maturity', true)],
      },
    ]);
    const glance = el.querySelector('[data-testid="pair-glance"]');
    expect(glance?.textContent ?? '').not.toContain('Price');
    expect(glance?.textContent ?? '').not.toContain('Release stage');
  });
});

// AECI-1238 (§11d.7): a mechanism value AECi hid while it checks it.
describe('ProductsPairPage: values under review (AECI-1238)', () => {
  const markers = (el: Element) =>
    Array.from(el.querySelectorAll('[data-testid="field-under-review"]')).map((n) =>
      n.textContent?.replace(/\s+/g, ' ').trim(),
    );
  const render = (mechanisms: Partial<ProductPairMechanism>[]) => {
    const base = buildPair().mechanisms[0]!;
    const { fixture } = setup(
      buildPair({
        mechanisms: mechanisms.map((m, i) => ({ ...base, id: `m${i}`, ...m })),
      }),
    );
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('puts the marker in the description slot and names the other hidden values', () => {
    const el = render([
      { description: null, docs_url: null, under_review: ['description', 'docs_url'] },
      {},
    ]);
    const cards = el.querySelectorAll('article');
    expect(
      cards[0]!.querySelector('[data-testid="mechanism-description-under-review"]'),
    ).not.toBeNull();
    expect(markers(cards[0]!)).toContain('Under review. AEC Integrations is checking this detail.');
    expect(
      markers(cards[0]!).some((t) =>
        t?.endsWith(': Under review. AEC Integrations is checking this detail.'),
      ),
    ).toBe(true);
    expect(markers(cards[1]!)).toEqual([]);
  });
});

// AECI-935 (VENDOR_PERFORMANCE_SPEC §3.4): one consented `integration_viewed` per
// pair-page render, ids in canonical order whichever way the URL is oriented.
describe('ProductsPairPage — integration_viewed', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const procore = productListItem('procore', 'Procore');
  const revit = productListItem('revit', 'Revit');
  const [lowId, highId] = [procore.id, revit.id].sort();

  async function renderWith(pair: ProductPairResponse | null) {
    const analytics = { externalLinkClicked: vi.fn(), integrationViewed: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: Analytics, useValue: analytics }] });
    const { fixture } = setup(pair);
    await hydrate(fixture);
    return analytics.integrationViewed;
  }

  it.each([
    ['procore → revit', procore, revit],
    ['revit → procore', revit, procore],
  ])('fires once with canonical ids from %s', async (_label, context, other) => {
    const spy = await renderWith(buildPair({ context_product: context, other_product: other }));
    expect(spy).toHaveBeenCalledTimes(1);
    // Identifiers only: two product ids and nothing else.
    expect(spy).toHaveBeenCalledWith(lowId, highId);
  });

  it('does not fire when the pair did not resolve', async () => {
    const spy = await renderWith(null);
    expect(spy).not.toHaveBeenCalled();
  });
});

// AECI-1777: the trail is Home, the context product, Integrations, the other product.
// Swapping the middle two reads as "the other product belongs to the context
// product", so the order and both link targets are pinned.
describe('ProductsPairPage breadcrumb (AECI-1777)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('reads Home, context product, Integrations, other product', () => {
    const { el } = setup(buildPair());
    expect(trail(el)).toEqual([
      { label: 'Home', href: '/', current: false },
      { label: 'Procore', href: '/products/procore', current: false },
      { label: 'Integrations', href: '/products/procore#integrations', current: false },
      { label: 'Revit', href: null, current: true },
    ]);
  });

  it('marks only the last item as the current page', () => {
    const { el } = setup(buildPair());
    expect(el.querySelectorAll('nav[aria-label="Breadcrumb"] [aria-current="page"]')).toHaveLength(
      1,
    );
  });
});

// AECI-1798: mock-up 12. The Forest hero carries the statement and the two products as
// its diagram, the toggle sits beside the data h2, and headings nest h2, h3, h4. These
// pin behaviour that a regression would change, not class names alone.
describe('ProductsPairPage: the mock-up 12 layout (AECI-1798)', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    clearViewCookie();
  });

  const ARROWS = /[→←⇄↔]/;

  it('renders one h1 in the hero band, with the same words as before', () => {
    const { el } = setup(buildPair());
    const h1s = el.querySelectorAll('h1');
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.closest('aec-hero-band')).toBeTruthy();
    expect(h1s[0]!.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'How Procore and Revit exchange data',
    );
    // The Statement size sits on the band's inner span, not on the h1 (the unlayered
    // h1 rule beats a size utility).
    expect(h1s[0]!.querySelector('span')!.className).toContain('text-t-statement');
  });

  it('nests the headings h2, h3, h4: data heading, card title, lane and At a glance', () => {
    const { el } = setup(
      buildPairWithClaims([
        claim('models', 'Models', 'outbound'),
        claim('rfis', 'RFIs', 'inbound'),
      ]),
    );
    const levels = Array.from(el.querySelectorAll('h1, h2, h3, h4'))
      .filter((h) => !h.closest('aec-mailing-list-signup'))
      .map((h) => `${h.tagName}:${h.textContent?.replace(/\s+/g, ' ').trim()}`);
    expect(levels).toEqual([
      'H1:How Procore and Revit exchange data',
      'H2:2 types of data shared',
      'H3:Procore + Autodesk Construction Cloud',
      'H4:At a glance',
      'H4:Sends to Revit',
      'H4:Receives from Revit',
      // AECI-1666: the provenance panel's card copy closes the data band.
      'H2:About this listing',
    ]);
  });

  it('puts the context product first and the other second in the hero diagram', () => {
    const { el } = setup(buildPair());
    const rail = el.querySelector('[data-testid="pair-rail"]')!;
    expect(rail.closest('aec-hero-band')).toBeTruthy();
    const names = Array.from(rail.querySelectorAll('[data-testid^="pair-side-"] a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(names).toEqual(['/products/procore', '/products/revit']);
  });

  it('shows the hero badge with the counted heading, aria-hidden, and draws no arrow', () => {
    const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
    const ribbon = el.querySelector('[data-testid="pair-ribbon"]')!;
    expect(ribbon.getAttribute('aria-hidden')).toBe('true');
    const badge = el.querySelector('[data-testid="pair-hero-badge"]')!;
    expect(badge.textContent?.trim()).toBe(
      el.querySelector('[data-testid="pair-data-heading"] h2')!.textContent?.trim(),
    );
    // The hero states no direction: no arrow character anywhere in the diagram.
    expect(el.querySelector('[data-testid="pair-rail"]')!.textContent).not.toMatch(ARROWS);
  });

  it('drops the hero badge when the heading counts nothing, and the ribbon with no integration', () => {
    const counted = setup(buildPair());
    expect(counted.el.querySelector('[data-testid="pair-ribbon"]')).toBeTruthy();
    expect(counted.el.querySelector('[data-testid="pair-hero-badge"]')).toBeNull();
    TestBed.resetTestingModule();
    const empty = setup(buildPair({ mechanisms: [] }));
    expect(empty.el.querySelector('[data-testid="pair-ribbon"]')).toBeNull();
    // AECI-1835: the empty pair draws mock-up 5's diagram instead of the rail.
    expect(empty.el.querySelector('[data-testid="pair-empty-stage"]')).toBeTruthy();
  });

  it('moves the toggle out of the hero, beside the data heading', () => {
    const { el } = setup(buildPairWithClaims([claim('models', 'Models', 'outbound')]));
    const group = el.querySelector('[role="group"][aria-label="Choose a view"]')!;
    expect(group.closest('aec-hero-band')).toBeNull();
    expect(group.parentElement).toBe(
      el.querySelector('[data-testid="pair-data-heading"]')!.parentElement,
    );
    // The pressed segment carries a tick, so its state is not colour alone.
    const pressed = group.querySelector('button[aria-pressed="true"]')!;
    expect(pressed.textContent).toContain('Detailed');
    expect(pressed.querySelector('aec-icon')).toBeTruthy();
    expect(group.querySelector('button[aria-pressed="false"] aec-icon')).toBeNull();
  });

  it('keeps every claim row and Sources trigger in the default render', () => {
    const { el } = setup(
      buildPairWithClaims([
        claim('models', 'Models', 'outbound'),
        claim('rfis', 'RFIs', 'inbound'),
      ]),
    );
    expect(el.querySelectorAll('[data-testid="pair-lanes"] li')).toHaveLength(2);
    expect(el.querySelectorAll('aec-claim-provenance')).toHaveLength(2);
  });

  it('puts each version selector in its own side card, outside any link', async () => {
    const pair = buildPairWithClaims([claim('rfis', 'RFIs', 'outbound')]);
    const { fixture, el } = setup({ ...pair, version_diff: versionDiff() });
    await hydrate(fixture);
    const selects = Array.from(el.querySelectorAll('aec-pair-version-select'));
    expect(
      selects.map((s) => s.closest('[data-testid^="pair-side-"]')?.getAttribute('data-testid')),
    ).toEqual(['pair-side-context', 'pair-side-other']);
    for (const s of selects) expect(s.closest('a')).toBeNull();
  });

  it('shows a 64px tile for an unclaimed side and keeps its 32px logo beside the note', () => {
    const { el } = setup(
      buildPair({
        other_product: {
          ...productListItem('revit', 'Revit'),
          logo_url: 'https://cdn.example.com/revit.png',
          claim_status: 'unclaimed',
        },
      }),
    );
    const side = el.querySelector('[data-testid="pair-side-other"]')!;
    const imgs = Array.from(side.querySelectorAll('img'));
    expect(imgs.map((i) => i.getAttribute('width'))).toEqual(['32']);
    expect(imgs[0]!.closest('aec-logo-or-initial')!.nextElementSibling!.tagName).toBe(
      'AEC-UNCLAIMED-NOTE',
    );
    // The large mark is the initial tile: no image above 32px on an unclaimed side.
    expect(side.querySelector('aec-logo-or-initial span[aria-hidden="true"]')?.textContent).toBe(
      'R',
    );
  });
});

// AECI-1827, restyled to mock-up 5 by AECI-1835: the empty pair page (STAGE_1_5_SPEC.md
// §11.4). The pair has no integration and no connector-evidenced pair, so the API returns
// no mechanism.
describe('ProductsPairPage — the empty pair (AECI-1827, AECI-1835)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const DATE = '2026-06-01T00:00:00.000Z';
  const vendor = (id: string, name: string) => ({
    id,
    name,
    slug: name.toLowerCase(),
    logo_url: null,
  });

  /** An empty pair. Both sides keep the shared fixture's defaults unless overridden. */
  const emptyPair = (
    context: Record<string, unknown> = {},
    other: Record<string, unknown> = {},
  ): ProductPairResponse =>
    buildPair({
      mechanisms: [],
      context_product: productListItem('procore', 'Procore', context),
      other_product: productListItem('revit', 'Revit', other),
    });

  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
  const cells = (el: HTMLElement, id: string) =>
    Array.from(el.querySelectorAll(`[data-testid="${id}"] [role="cell"]`)).map((c) => text(c));

  it('states the legal statement as the h1, with the caveat, the pill and the correction entry', () => {
    const { el } = setup(emptyPair());
    // Ruling 98: no "Integration" overline above the statement. AECI-1666 retired the
    // header chip: its words open "About this listing" at the end of the body instead.
    const kicker = el.querySelector('aec-hero-band [heroKicker]');
    expect(text(kicker)).not.toMatch(/^Integration\b/);
    expect(kicker?.querySelector('aec-maintenance-marker')).toBeNull();
    expect(text(kicker?.querySelector('[data-testid="pair-empty-status"]'))).toBe('Not on record');
    expect(text(el.querySelector('h1'))).toBe(
      'We have no integration between Procore and Revit on record.',
    );
    const caveat = el.querySelector('[data-testid="pair-empty-caveat"]');
    expect(text(caveat)).toBe(
      'Not on record means we have not found one. It is not proof that none exists.',
    );
    expect(text(caveat?.querySelector('strong'))).toBe(
      'Not on record means we have not found one.',
    );
    expect(caveat!.closest('aec-hero-band')).toBe(el.querySelector('h1')!.closest('aec-hero-band'));
    // The correction entry: §11.4's words, the existing correction request.
    const know = el.querySelector('[data-testid="pair-empty-know"]')!;
    expect(text(know)).toContain('Know of one?');
    expect(text(know)).toContain('Tell us where you saw it and we will look at it.');
    const button = know.querySelector<HTMLAnchorElement>('[data-testid="pair-empty-correction"]')!;
    expect(text(button)).toBe('It does exist');
    expect(button.getAttribute('href')).toBe('/products/procore/correction');
    // The page hosts the drawer the trigger opens. Without it a click is cancelled and
    // nothing opens.
    expect(el.querySelector('aec-request-drawer')).toBeTruthy();
    expect(text(el.querySelector('[data-testid="pair-empty-look-it-up-intro"]'))).toBe(
      'Linked as each vendor publishes them. What they say about building a connection is theirs, not ours.',
    );
    // Never a wording that asserts absence.
    expect(el.textContent).not.toMatch(/does not integrate|not compatible|no integration exists/i);
  });

  it('adds the mock-up continuation to the caveat only while the alternatives are on the page', () => {
    const without = setup(emptyPair());
    expect(without.el.querySelector('[data-testid="pair-empty-lede-more"]')).toBeNull();
    TestBed.resetTestingModule();
    const alternatives = {
      moving: { context_only: [], both: [], other_only: [] },
      lanes: { context: { anchors: [], matches: [] }, other: { anchors: [], matches: [] } },
    };
    const { el } = setup({ ...emptyPair(), alternatives } as ProductPairResponse);
    expect(text(el.querySelector('[data-testid="pair-empty-caveat"]'))).toBe(
      'Not on record means we have not found one. It is not proof that none exists.',
    );
    expect(text(el.querySelector('[data-testid="pair-empty-lede-more"]'))).toBe(
      'Below are the closest pairs we do have, what you would be moving, and where to look yourself.',
    );
    expect(el.querySelector('h1 > span')!.className).toContain('text-t-statement-wide');
  });

  it('draws the diagram with the medallion label and no arrow or data-type bead', () => {
    const { el } = setup(emptyPair());
    const stage = el.querySelector('[data-testid="pair-empty-stage"]')!;
    expect(stage.closest('aec-hero-band')).toBeTruthy();
    expect(text(stage.querySelector('[data-testid="pair-empty-medallion"]'))).toBe(
      'No integration on record',
    );
    expect(stage.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(stage.querySelector('svg marker, svg [marker-end]')).toBeNull();
    expect(stage.textContent).not.toMatch(/[→←↔⇄]/);
    // The cards' tags and names; each name a real link.
    expect(Array.from(stage.querySelectorAll('h2 a')).map((a) => a.getAttribute('href'))).toEqual([
      '/products/procore',
      '/products/revit',
    ]);
    expect(text(stage.querySelector('[data-testid="pair-side-context"]'))).toContain('Product one');
    expect(text(stage.querySelector('[data-testid="pair-side-other"]'))).toContain('Product two');
  });

  it('keeps the products in URL order, context first, in every section', () => {
    const { el } = setup(emptyPair());
    const heads = Array.from(
      el.querySelectorAll('[data-testid="pair-empty-facts"] [role="columnheader"] a'),
    );
    expect(heads.map((h) => text(h))).toEqual(['Procore', 'Revit']);
    expect(text(el.querySelector('[data-testid="pair-empty-look-context"] h3'))).toBe('Procore');
    expect(text(el.querySelector('[data-testid="pair-empty-look-other"] h3'))).toBe('Revit');
  });

  it('uses the mock-up kickers and headings', () => {
    const { el } = setup(emptyPair());
    const sbs = el.querySelector('[data-testid="pair-empty-side-by-side"]')!;
    expect(text(sbs.querySelector('.aec-overline'))).toBe('Side by side');
    expect(text(sbs.querySelector('h2'))).toBe('How the two products compare');
    const look = el.querySelector('[data-testid="pair-empty-look-it-up"]')!;
    expect(text(look.querySelector('.aec-overline'))).toBe('Look it up yourself');
    expect(text(look.querySelector('h2'))).toBe("Each vendor's own pages");
  });

  it('drops the reviews row and both rating rows when neither side has a review', () => {
    const { el } = setup(emptyPair());
    const rows = Array.from(
      el.querySelectorAll('[data-testid="pair-empty-facts"] [role="row"][data-testid]'),
    );
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'pair-empty-facts-integrations',
    ]);
  });

  it('shows each side its own rating, gated at five reviews, never blended', () => {
    const { el } = setup(
      emptyPair(
        { review_count: 7, rating_overall_avg: 4.2, rating_onboarding_avg: 3.5 },
        { review_count: 2, rating_overall_avg: null, rating_onboarding_avg: null },
      ),
    );
    expect(cells(el, 'pair-empty-facts-reviews')).toEqual(['7', '2']);
    expect(cells(el, 'pair-empty-facts-overall')[0]).toContain('4.2');
    expect(cells(el, 'pair-empty-facts-overall')[1]).toBe('Not yet rated');
    expect(cells(el, 'pair-empty-facts-onboarding')[0]).toContain('3.5');
    // No cell holds a mean of the two sides.
    expect(el.querySelector('[data-testid="pair-empty-facts"]')!.textContent).not.toContain('3.9');
  });

  it('prints the integration count, and "None on record yet" at zero (ruling 96)', () => {
    const { el } = setup(emptyPair({ integration_count: 12 }, { integration_count: 0 }));
    expect(cells(el, 'pair-empty-facts-integrations')).toEqual(['12', 'None on record yet']);
  });

  it('keeps a short product name on one line in the statement, and lets a long one break', () => {
    const { el } = setup(
      emptyPair({}, { name: 'Sage Intacct Construction Financial Management Suite' }),
    );
    const names = el.querySelectorAll('[data-testid="pair-empty-statement"] .font-semibold');
    expect(names[0]!.className).toContain('md:whitespace-nowrap');
    expect(names[1]!.className).not.toContain('whitespace-nowrap');
  });

  it('marks a term both products carry as Both, keeps each product order, and lists the captions in the panel', () => {
    const { el } = setup(
      emptyPair(
        {
          vendor: vendor('v1', 'Acme'),
          audiences: [
            { id: 'a2', slug: 'gc', name: 'General contractors' },
            { id: 'a1', slug: 'arch', name: 'Architects' },
          ],
          captions: {
            managed: { form: 'updated', vendor_names: ['Acme'], date: DATE },
            corrections: [{ field: 'phase_slugs', date: DATE, source_url: null, cleared: true }],
          },
        },
        {
          audiences: [
            { id: 'a3', slug: 'owners', name: 'Owners' },
            { id: 'a1', slug: 'arch', name: 'Architects' },
          ],
        },
      ),
    );
    const audiences = el.querySelector('[data-testid="pair-empty-who-audiences"]')!;
    // What a screen reader hears: the marks are aria-hidden.
    const spoken = (c: Element) => {
      const copy = c.cloneNode(true) as Element;
      copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
      return copy.textContent?.replace(/\s+/g, ' ').replace(/\s*\(/, ' (').trim();
    };
    const chips = Array.from(audiences.querySelectorAll('aec-chip:not([density])')).map(spoken);
    expect(chips).toEqual([
      'General contractors (Procore only)',
      'Architects appears on both products',
      'Owners (Revit only)',
    ]);
    // A term on both leads with the word "Both" in place of the two tiles, and no tag trails it.
    const both = audiences.querySelectorAll('aec-chip:not([density])')[1]!;
    expect(both.querySelector('aec-logo-or-initial')).toBeNull();
    expect(text(both)?.startsWith('Both')).toBe(true);
    expect(both.querySelector('aec-chip[density]')).toBeNull();
    // AECI-1666: nothing inline. The removal empties the group, so it is absent, and the
    // panel at the end of the page lists it and the Managed caption, each named for Procore.
    expect(el.querySelector('[data-testid="pair-empty-who-phases"]')).toBeNull();
    const who = el.querySelector('[data-testid="pair-empty-who"]')!;
    expect(who.querySelector('aec-field-caption')).toBeNull();
    const panel = text(el.querySelector('[data-testid="listing-provenance"]'))!;
    expect(panel).toContain('Procore, Audiences, trades, phases and resources');
    expect(panel).toContain('Maintained by Acme');
    expect(panel).toMatch(/Procore, [^:]+: Removed by AEC Integrations/);
    // The legend line is gone: each chip carries its own meaning.
    expect(el.querySelector('[data-testid="pair-empty-who"] h3 + p')).toBeNull();
  });

  it('stacks the ledger and "Who each product is for", each the full row', () => {
    const { el } = setup(
      emptyPair({
        audiences: [{ id: 'a1', slug: 'arch', name: 'Architects' }],
      }),
    );
    const grid = el
      .querySelector('[data-testid="pair-empty-facts"]')!
      .closest('[aecCard]')!.parentElement!;
    expect(grid.className).not.toMatch(/grid-cols/);
    expect(grid.querySelector('[data-testid="pair-empty-who"]')).toBeTruthy();
  });

  it('links each vendor page in a new tab, and lists its corrections in the panel', () => {
    const { el } = setup(
      emptyPair(
        {
          vendor: vendor('v1', 'Acme'),
          integration_count: 3,
          tool_integrations_url: 'https://acme.example/integrations',
          api_docs_url: null,
          under_review: ['api_docs_url'],
          captions: {
            managed: { form: 'updated', vendor_names: ['Acme'], date: DATE },
            corrections: [
              { field: 'tool_integrations_url', date: DATE, source_url: null, cleared: false },
            ],
          },
        },
        {
          vendor: vendor('v2', 'Globex'),
          integration_count: 0,
          api_docs_url: 'https://globex.example/api',
          tool_integrations_url: null,
          captions: {
            managed: null,
            corrections: [
              { field: 'tool_integrations_url', date: DATE, source_url: null, cleared: true },
            ],
          },
        },
      ),
    );
    const ctx = el.querySelector('[data-testid="pair-empty-look-context"]')!;
    const link = ctx.querySelector<HTMLAnchorElement>(
      '[data-testid="pair-look-integrations-context"]',
    )!;
    expect(link.getAttribute('href')).toBe('https://acme.example/integrations');
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener nofollow');
    // AECi corrected this link, so it keeps the neutral label and the head drops
    // "Published by": a corrected value is AECi's, not the vendor's.
    expect(text(link)).toContain('Integrations page');
    expect(text(link)).not.toContain('Acme integrations directory');
    expect(ctx.querySelector('[data-testid="pair-look-published-by"]')).toBeNull();
    expect(text(ctx.querySelector('[data-testid="pair-look-by"]'))).toBe('by Acme');
    expect(text(link)).toContain('acme.example/integrations');
    expect(link.parentElement!.textContent).not.toContain('Corrected by');
    expect(text(ctx.querySelector('[data-testid="pair-look-all-context"]'))).toContain(
      'All 3 Procore integrations',
    );
    // Hidden for checking: the marker, no link.
    expect(ctx.querySelector('[data-testid="pair-look-api-context"]')).toBeNull();
    expect(text(ctx.querySelector('[data-testid="pair-look-api-under-review-context"]'))).toContain(
      'Under review',
    );
    expect(ctx.querySelector('aec-field-caption')).toBeNull();
    const other = el.querySelector('[data-testid="pair-empty-look-other"]')!;
    expect(text(other.querySelector('[data-testid="pair-look-published-by"]'))).toBe(
      'Published by Globex',
    );
    expect(other.querySelector('[data-testid="pair-look-integrations-other"]')).toBeNull();
    // A removal empties the slot and takes no line there (AECI-1666, ruling 1).
    expect(other.textContent).not.toContain('Removed by');
    const panel = el.querySelector('[data-testid="listing-provenance"]')!;
    expect(text(panel)).toContain('Maintained by Acme');
    expect(text(panel)).toMatch(/Procore, [^:]+: Corrected by AEC Integrations/);
    expect(text(panel)).toMatch(/Revit, [^:]+: Removed by AEC Integrations/);
    // Procore's hidden API link is the one marker on the page.
    expect(text(panel)).toMatch(/1 value on this page is under review/);
    expect(other.querySelector('[data-testid="pair-look-no-directory-other"]')).toBeNull();
    expect(other.querySelector('[data-testid="pair-look-api-other"]')).toBeTruthy();
    // No "All 0" link: a product with none on record has no list to open.
    expect(other.querySelector('[data-testid="pair-look-all-other"]')).toBeNull();
    expect(text(el.querySelector('[data-testid="pair-look-api-note"]'))).toBe(
      'An API is not an integration. We list an integration only when we can show that one exists.',
    );
  });

  it('lists only what a vendor has: no line says something is missing', () => {
    const { el } = setup(
      emptyPair({ vendor: vendor('v1', 'Acme'), integration_count: 3 }, { integration_count: 2 }),
    );
    const card = el.querySelector('[data-testid="pair-empty-look-context"]')!;
    expect(text(card)).not.toMatch(/not found|None found|have not found/i);
    // With no link, the card holds the product's own list on AEC Integrations only.
    expect(card.querySelectorAll('li')).toHaveLength(1);
    expect(card.querySelector('[data-testid="pair-look-all-context"]')).toBeTruthy();
    // A card with no link never heads itself "Published by".
    expect(card.querySelector('[data-testid="pair-look-published-by"]')).toBeNull();
    expect(text(card.querySelector('[data-testid="pair-look-by"]'))).toBe('by Acme');
  });

  it('leaves out a vendor card with nothing to list, and the other takes the row', () => {
    const { el } = setup(
      emptyPair(
        { vendor: vendor('v1', 'Acme'), integration_count: 0, listed_integration_count: 0 },
        { integration_count: 2 },
      ),
    );
    expect(el.querySelector('[data-testid="pair-empty-look-context"]')).toBeNull();
    const other = el.querySelector('[data-testid="pair-empty-look-other"]')!;
    expect(other.parentElement!.className).not.toMatch(/grid-cols/);
  });

  it("names the vendor's directory and says Published by only on the vendor's own links", () => {
    const { el } = setup(
      emptyPair({
        vendor: vendor('v1', 'Acme'),
        tool_integrations_url: 'https://acme.example/integrations',
        api_docs_url: 'https://acme.example/api',
      }),
    );
    const card = el.querySelector('[data-testid="pair-empty-look-context"]')!;
    expect(text(card.querySelector('[data-testid="pair-look-published-by"]'))).toBe(
      'Published by Acme',
    );
    expect(text(card.querySelector('[data-testid="pair-look-integrations-context"]'))).toContain(
      'Acme integrations directory',
    );
  });

  it('names the two scores as the product page does, Product quality and Onboarding experience', () => {
    const { el } = setup(
      emptyPair(
        { review_count: 7, rating_overall_avg: 4.2, rating_onboarding_avg: 3.5 },
        { review_count: 6, rating_overall_avg: 3.1, rating_onboarding_avg: 2.9 },
      ),
    );
    const head = (id: string) => text(el.querySelector(`[data-testid="${id}"] [role="rowheader"]`));
    expect(head('pair-empty-facts-overall')).toBe('Product quality');
    expect(head('pair-empty-facts-onboarding')).toBe('Onboarding experience');
    const facts = el.querySelector('[data-testid="pair-empty-facts"]')!.textContent!;
    // One name per score on every public page: the old short names are gone.
    expect(facts).not.toMatch(/\bOverall\b/);
    expect(facts).not.toMatch(/Onboarding(?! experience)/);
  });

  it('shows an unclaimed side as an initial tile with the Unclaimed note, never its logo above 32px', () => {
    const { el } = setup(
      emptyPair(
        { claim_status: 'claimed', logo_url: 'https://cdn.example/procore.png' },
        { claim_status: 'unclaimed', logo_url: 'https://cdn.example/revit.png' },
      ),
    );
    const card = el.querySelector(
      '[data-testid="pair-empty-stage"] [data-testid="pair-side-other"]',
    )!;
    expect(card.querySelector('[data-testid="unclaimed-note"]')?.textContent).toContain(
      'Unclaimed · not affiliated with or endorsed by this vendor',
    );
    expect(
      el.querySelector('[data-testid="pair-empty-look-other"] [data-testid="unclaimed-note"]'),
    ).toBeTruthy();
    // Nowhere on the page does the unclaimed logo render above 32px.
    for (const img of Array.from(el.querySelectorAll<HTMLImageElement>('img[src*="revit"]'))) {
      expect(Number(img.getAttribute('width'))).toBeLessThanOrEqual(32);
    }
    // The claimed product's logo does show in its card's large mark.
    expect(
      el.querySelector(
        '[data-testid="pair-empty-stage"] [data-testid="pair-side-context"] img[src*="procore"]',
      ),
    ).toBeTruthy();
  });

  it('shows no second initial tile beside the note when an unclaimed product has no logo', () => {
    const { el } = setup(emptyPair({}, { claim_status: 'unclaimed', logo_url: null }));
    const card = el.querySelector(
      '[data-testid="pair-empty-stage"] [data-testid="pair-side-other"]',
    )!;
    expect(card.querySelectorAll('aec-logo-or-initial')).toHaveLength(1);
  });

  it('keeps the "Integration" overline on a pair with integrations (ruling 98)', () => {
    const { el } = setup(buildPair());
    expect(text(el.querySelector('aec-hero-band [heroKicker] .aec-overline'))).toBe('Integration');
    expect(el.querySelector('[data-testid="pair-empty-stage"]')).toBeNull();
    expect(el.querySelector('[data-testid="pair-rail"]')).toBeTruthy();
  });
});

describe('ProductsPairPage: the Sync Service "Not offered or endorsed by" line (AECI-2043)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const rivets = {
    id: '00000000-0000-4000-8000-0000000000c1',
    name: 'Rivets',
    slug: 'rivets',
    logo_url: null,
  };
  const rivetsSync = {
    id: '00000000-0000-4000-8000-0000000000c2',
    name: 'Rivets Sync',
    slug: 'rivets-sync',
    logo_url: null,
  };
  const vendor = (n: string, name: string) => ({
    id: `00000000-0000-4000-8000-0000000000${n}`,
    name,
    slug: name.toLowerCase(),
    logo_url: null,
  });

  function pairWith(
    connector_kind: 'sync_service' | 'integration_platform' | null,
    arm: 'via' | 'powered_by_product' | 'native' = 'via',
  ): ProductPairResponse {
    const base = buildPair({
      context_product: productListItem('procore', 'Procore', {
        vendor: vendor('d1', 'Procore Technologies'),
      }),
      other_product: productListItem('acumatica', 'Acumatica', {
        vendor: vendor('d2', 'Acumatica'),
      }),
    });
    return {
      ...base,
      mechanisms: [
        {
          ...base.mechanisms[0]!,
          built_by_vendor: rivets,
          via: arm === 'via' ? rivetsSync : null,
          powered_by_product: arm === 'powered_by_product' ? rivetsSync : null,
          connector_vendor_id: arm === 'native' ? null : rivets.id,
          connector_kind,
        },
      ],
    };
  }

  const line = (el: HTMLElement) =>
    el
      .querySelector('[data-testid="pair-not-endorsed"]')
      ?.textContent?.replace(/\s+/g, ' ')
      .trim() ?? null;

  it('shows the line on a Sync Service card, from either table, naming both endpoint vendors', () => {
    for (const arm of ['via', 'powered_by_product'] as const) {
      TestBed.resetTestingModule();
      const { el } = setup(pairWith('sync_service', arm));
      expect(line(el), arm).toBe(
        'Offered by Rivets. Not offered or endorsed by Procore Technologies or Acumatica.',
      );
    }
  });

  it('shows no line on an Integration platform, an unclassified connector or a native card', () => {
    for (const [kind, arm] of [
      ['integration_platform', 'via'],
      [null, 'via'],
      [null, 'native'],
    ] as const) {
      TestBed.resetTestingModule();
      const { el } = setup(pairWith(kind, arm));
      expect(line(el), `${kind} ${arm}`).toBeNull();
    }
  });

  it('shows no line when an older API leaves the kind out', () => {
    const pair = pairWith('sync_service');
    const { connector_kind: _dropped, ...rest } = pair.mechanisms[0]!;
    const { el } = setup({ ...pair, mechanisms: [rest] });
    expect(line(el)).toBeNull();
  });
  // AECI-2046: the Sync Service's own rating beside the card it delivers.
  const withRating = (
    kind: 'sync_service' | 'integration_platform' | null,
    rating: { review_count: number; rating_overall_avg: number | null } | undefined,
  ): ProductPairResponse => {
    const pair = pairWith(kind);
    return { ...pair, mechanisms: [{ ...pair.mechanisms[0]!, connector_rating: rating }] };
  };
  const rating = (el: HTMLElement) => el.querySelector('[data-testid="pair-connector-rating"]');

  it('shows the Sync Service rating on its card, with the endpoint cards accessible name', () => {
    const { el } = setup(withRating('sync_service', { review_count: 7, rating_overall_avg: 4.25 }));
    const r = rating(el)!;
    expect(r.textContent!.replace(/\s+/g, ' ').trim()).toBe('Rivets Sync★4.3· 7 reviews');
    expect(r.getAttribute('aria-label')).toBe('Rivets Sync rated 4.3 out of 5 from 7 reviews');
  });

  it('shows no rating below the review floor, on another kind, or from an older API', () => {
    for (const [kind, value] of [
      ['sync_service', { review_count: 3, rating_overall_avg: null }],
      ['integration_platform', { review_count: 7, rating_overall_avg: 4.2 }],
      ['sync_service', undefined],
    ] as const) {
      TestBed.resetTestingModule();
      const { el } = setup(withRating(kind, value));
      expect(rating(el), String(kind)).toBeNull();
    }
  });
});
