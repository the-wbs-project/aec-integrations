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
import { ActivatedRoute, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ContextDirection, ProductPairClaim, ProductPairResponse } from '@aeci/shared';

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
  attestations: [
    { source: 'aeci', asserted: true, note, introduced_at: null, deprecated_at: null },
  ],
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
        claims: [],
      },
    ],
    sync_headline: { total: 0, confirmed: 0 },
    ...overrides,
  };
}

/** A pair whose single mechanism carries claims (Layer B). */
function buildPairWithClaims(claims: ProductPairClaim[]): ProductPairResponse {
  const base = buildPair();
  return {
    ...base,
    mechanisms: [{ ...base.mechanisms[0]!, claims }],
    sync_headline: { total: claims.length, confirmed: 0 },
  };
}

function setup(pair: ProductPairResponse | null) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: ActivatedRoute,
        useValue: { data: of({ pair }), snapshot: { data: { pair } } },
      },
    ],
  });
  const fixture = TestBed.createComponent(ProductsPairPage);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('ProductsPairPage', () => {
  beforeEach(() => TestBed.resetTestingModule());

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

  it('shows the empty-mechanisms message when the pair has no integrations', () => {
    const { el } = setup(buildPair({ mechanisms: [] }));
    expect(el.textContent).toContain('don’t have any integrations documented');
  });

  it('renders the NotFound shell when the pair is null', () => {
    const { el } = setup(null);
    expect(el.querySelector('aec-not-found')).toBeTruthy();
  });
});
