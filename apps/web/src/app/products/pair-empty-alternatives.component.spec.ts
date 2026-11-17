/**
 * AECI-1829 and AECI-1830: the empty pair page's "What you would be moving" and closest
 * matches. Named `.component.spec.ts` for `ng test`.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { PairAlternativeMatch, PairAlternatives, ProductPairSubject } from '@aeci/shared';

import { PairEmptyAlternatives } from './pair-empty-alternatives';

const subject = (slug: string, name: string): ProductPairSubject =>
  ({
    claim_status: 'claimed',
    id: `id-${slug}`,
    slug,
    name,
    logo_url: null,
    product_role: 'application',
    vendor: null,
    integration_count: 3,
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
  }) as ProductPairSubject;

const match = (
  slug: string,
  name: string,
  over: Partial<PairAlternativeMatch> = {},
): PairAlternativeMatch => ({
  product: { id: `id-${slug}`, slug, name, logo_url: null },
  vendor_name: null,
  review_count: 0,
  rating_overall_avg: null,
  rating_onboarding_avg: null,
  shared_categories: [{ slug: 'erp', name: 'ERP' }],
  data_objects: [],
  direction: null,
  confirmed: false,
  ...over,
});

/** The API's order: the component never re-sorts it. "zeta" sits first on purpose. */
const ALTERNATIVES: PairAlternatives = {
  moving: {
    context_only: [{ slug: 'drawings', name: 'Drawings' }],
    both: [{ slug: 'rfis', name: 'RFIs' }],
    other_only: [],
  },
  lanes: {
    context: {
      anchors: [
        { id: 'c1', slug: 'erp', name: 'ERP' },
        { id: 'c2', slug: 'accounting', name: 'Accounting' },
      ],
      matches: [
        match('zeta', 'zeta Books', {
          data_objects: [{ slug: 'rfis', name: 'RFIs' }],
          confirmed: true,
          rating_overall_avg: 4.2,
          rating_onboarding_avg: 3.9,
          review_count: 7,
        }),
        match('alpha', 'Alpha Ledger', {
          shared_categories: [{ slug: 'accounting', name: 'Accounting' }],
        }),
      ],
    },
    other: { anchors: [], matches: [] },
  },
};

function setup(alternatives: PairAlternatives = ALTERNATIVES) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(PairEmptyAlternatives);
  fixture.componentRef.setInput('context', subject('revu', 'Bluebeam Revu'));
  fixture.componentRef.setInput('other', subject('sage', 'Sage 300 CRE'));
  fixture.componentRef.setInput('alternatives', alternatives);
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const click = (selector: string) => {
    el.querySelector<HTMLElement>(selector)!.click();
    fixture.detectChanges();
  };
  return { fixture, el, click };
}

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
const cardNames = (el: HTMLElement) =>
  Array.from(el.querySelectorAll('[data-testid="pair-matches-cards"] h4')).map((h) => text(h));

describe('PairEmptyAlternatives (AECI-1829, AECI-1830)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('uses the mock-up kickers and headings', () => {
    const { el } = setup();
    const moving = el.querySelector('[data-testid="pair-empty-moving"]')!;
    expect(text(moving.querySelector('.aec-overline'))).toBe('What you would be moving');
    expect(text(moving.querySelector('h2'))).toBe('The data each product already exchanges');
    const matches = el.querySelector('[data-testid="pair-empty-matches"]')!;
    expect(text(matches.querySelector('.aec-overline'))).toBe('Closest matches on record');
    expect(text(matches.querySelector('h2'))).toBe(
      'Keep one product. See what it already connects to.',
    );
  });

  it('groups the data in three, with a designed line for an empty group', () => {
    const { el } = setup();
    expect(text(el.querySelector('[data-testid="pair-moving-context-only"] h3'))).toContain(
      'Only Bluebeam Revu',
    );
    expect(text(el.querySelector('[data-testid="pair-moving-both"]'))).toContain('RFIs');
    expect(text(el.querySelector('[data-testid="pair-moving-other-only"]'))).toContain(
      'None on record yet',
    );
  });

  it('keeps the API order (A to Z is the server order) and renders the first lane on first paint', () => {
    const { el } = setup();
    expect(cardNames(el)).toEqual(['zeta Books', 'Alpha Ledger']);
    expect(text(el.querySelector('[data-testid="pair-matches-count"]'))).toBe('2 of 2 match');
    expect(el.querySelector('[data-testid="pair-matches-count"]')!.getAttribute('aria-live')).toBe(
      'polite',
    );
    expect(
      el.querySelector('[data-testid="pair-matches-keep-context"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('narrows to products that move every picked data object, and announces the count', () => {
    const { el, click } = setup();
    click('[data-testid="pair-moving-object-rfis"]');
    expect(
      el.querySelector('[data-testid="pair-moving-object-rfis"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(cardNames(el)).toEqual(['zeta Books']);
    expect(text(el.querySelector('[data-testid="pair-matches-count"]'))).toBe('1 of 2 match');
    expect(text(el.querySelector('[data-testid="pair-matches-picked-note"]'))).toContain(
      'Products with no data objects on record are left out.',
    );
    expect(text(el.querySelector('[data-testid="pair-moving-picked"]'))).toContain(
      'Matches must move RFIs',
    );
    click('[data-testid="pair-moving-object-drawings"]');
    expect(el.querySelector('[data-testid="pair-matches-empty"]')!.getAttribute('data-empty')).toBe(
      'no-object',
    );
  });

  it('turns categories off, and shows a designed state when none is on', () => {
    const { el, click } = setup();
    click('[data-testid="pair-matches-anchor-erp"]');
    expect(cardNames(el)).toEqual(['Alpha Ledger']);
    expect(text(el.querySelector('[data-testid="pair-matches-lane-heading"]'))).toBe(
      'Accounting products that Bluebeam Revu connects to',
    );
    click('[data-testid="pair-matches-anchor-accounting"]');
    expect(el.querySelector('[data-testid="pair-matches-empty"]')!.getAttribute('data-empty')).toBe(
      'all-off',
    );
  });

  it('switches the lane with the keep toggle, with a designed state for a lane with no anchors', () => {
    const { el, click } = setup();
    click('[data-testid="pair-matches-keep-other"]');
    expect(
      el.querySelector('[data-testid="pair-matches-keep-other"]')!.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(el.querySelector('[data-testid="pair-matches-empty"]')!.getAttribute('data-empty')).toBe(
      'no-anchors',
    );
  });

  it('labels a confirmed match, links each card to its pair page and gates ratings', () => {
    const { el } = setup();
    const cards = el.querySelectorAll('[data-testid="pair-matches-cards"] article');
    expect(text(cards[0])).toContain('Confirmed by both companies');
    expect(text(cards[1])).not.toContain('Confirmed by both companies');
    expect(text(cards[1])).toContain('Not yet rated');
    const link = el.querySelector<HTMLAnchorElement>('[data-testid="pair-match-link-zeta"]')!;
    expect(link.getAttribute('href')).toBe('/products/revu/integrations/zeta');
    expect(text(link)).toBe('Bluebeam Revu and zeta Books');
  });

  it('shows the same matches as a table', () => {
    const { el, click } = setup();
    click('[data-testid="pair-matches-view-table"]');
    const rows = Array.from(el.querySelectorAll('[data-testid="pair-matches-table"] tbody tr'));
    expect(rows.map((r) => text(r.querySelector('th a')))).toEqual(['zeta Books', 'Alpha Ledger']);
    expect(text(el.querySelector('[data-testid="pair-matches-table"] thead'))).toContain(
      'Instead of Sage 300 CRE',
    );
  });

  it('states the real order, not the mock-up text', () => {
    const { el } = setup();
    const order = text(el.querySelector('[data-testid="pair-matches-order"]'));
    expect(order).toContain('Products run A to Z by name.');
    expect(order).not.toMatch(/Merit only|common with your picks come first/);
  });
});
