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

import type { ProductPairResponse } from '@aeci/shared';

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
      },
    ],
    sync_headline: { total: 0, confirmed: 0 },
    ...overrides,
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

  it('renders the empty data-flow band (Layer A has no claims)', () => {
    const { el } = setup(buildPair());
    expect(el.textContent).toContain('Data flows');
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
