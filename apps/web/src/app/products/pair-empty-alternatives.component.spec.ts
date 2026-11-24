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
    connector_kind: null,
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
  /** Press "Table" in the list row's shared Cards and Table toggle. */
  const clickTable = () => {
    const table = Array.from(
      el.querySelectorAll<HTMLButtonElement>('[data-testid="pair-matches-view"] button'),
    ).find((b) => b.textContent?.includes('Table'))!;
    table.click();
    fixture.detectChanges();
  };
  return { fixture, el, click, clickTable };
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
    expect(text(matches.querySelector('h2'))).toBe('Keep one product and swap the other');
    // The intro names the product to swap and the one kept, for whichever lane is shown.
    expect(text(el.querySelector('[data-testid="pair-matches-intro"]'))).toBe(
      'These products are similar to Sage 300 CRE and have an integration with Bluebeam Revu on record. Open one to see what moves between them.',
    );
  });

  it('drops the marks beside "Both exchange" and says what the list shows', () => {
    const { el, click } = setup();
    const both = el.querySelector('[data-testid="pair-moving-both"] h3')!;
    expect(both.querySelector('aec-logo-or-initial')).toBeNull();
    expect(
      el.querySelector('[data-testid="pair-moving-context-only"] h3 aec-logo-or-initial'),
    ).toBeTruthy();
    const status = el.querySelector('[data-testid="pair-moving-picked"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(text(status)).toBe('Showing every match. Pick the data you need to narrow the list.');
    click('[data-testid="pair-moving-object-rfis"]');
    expect(text(status)).toContain('Showing only matches that move RFIs.');
  });

  it('searches product and vendor names, keeps the order, and clears back to the search box', async () => {
    const lanes = ALTERNATIVES.lanes;
    const { el, fixture } = setup({
      ...ALTERNATIVES,
      lanes: {
        ...lanes,
        context: {
          ...lanes.context,
          matches: [
            { ...lanes.context.matches[0]!, vendor_name: 'Zeta Corp' },
            lanes.context.matches[1]!,
          ],
        },
      },
    });
    document.body.appendChild(el);
    try {
      const input = el.querySelector<HTMLInputElement>('#pair-matches-filter')!;
      expect(input.closest('form')).toBeNull();
      expect(el.querySelector('label[for="pair-matches-filter"]')!.textContent?.trim()).toBe(
        'Search these matches',
      );
      expect(input.placeholder).toBe('Filter by product or vendor');
      const type = (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event('input'));
        fixture.detectChanges();
      };
      type('corp');
      expect(cardNames(el)).toEqual(['zeta Books']);
      expect(text(el.querySelector('[data-testid="pair-matches-count"]'))).toBe('Showing 1 of 2');
      type('ledger');
      expect(cardNames(el)).toEqual(['Alpha Ledger']);
      type('nothing like it');
      const empty = el.querySelector('[data-testid="pair-matches-empty"]')!;
      expect(empty.getAttribute('data-empty')).toBe('no-query');
      const clear = el.querySelector<HTMLButtonElement>(
        '[data-testid="pair-matches-filter-clear"]',
      )!;
      clear.click();
      fixture.detectChanges();
      await fixture.whenStable();
      expect(cardNames(el)).toEqual(['zeta Books', 'Alpha Ledger']);
      expect(input.value).toBe('');
      expect(document.activeElement).toBe(input);
      expect(el.querySelector('[data-testid="pair-matches-filter-clear"]')).toBeNull();
    } finally {
      el.remove();
    }
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
    expect(text(el.querySelector('[data-testid="pair-matches-count"]'))).toBe('Showing 2 of 2');
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
    expect(text(el.querySelector('[data-testid="pair-matches-count"]'))).toBe('Showing 1 of 2');
    expect(text(el.querySelector('[data-testid="pair-matches-picked-note"]'))).toContain(
      'Products with no data objects on record are left out.',
    );
    expect(text(el.querySelector('[data-testid="pair-moving-picked"]'))).toContain(
      'Showing only matches that move RFIs.',
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
    // The lane's heading names the lane, whatever the categories (AECI-1835).
    expect(text(el.querySelector('[data-testid="pair-matches-lane-heading"]'))).toBe(
      'Bluebeam Revu integrations',
    );
    click('[data-testid="pair-matches-anchor-accounting"]');
    expect(el.querySelector('[data-testid="pair-matches-empty"]')!.getAttribute('data-empty')).toBe(
      'all-off',
    );
  });

  it('says the categories emptied the list, not the data, when nothing is picked', () => {
    const { el, click } = setup({
      ...ALTERNATIVES,
      lanes: {
        ...ALTERNATIVES.lanes,
        context: {
          ...ALTERNATIVES.lanes.context,
          matches: [ALTERNATIVES.lanes.context.matches[1]!],
        },
      },
    });
    click('[data-testid="pair-matches-anchor-accounting"]');
    const empty = el.querySelector('[data-testid="pair-matches-empty"]')!;
    expect(empty.getAttribute('data-empty')).toBe('no-shared');
    expect(text(empty)).toContain('No match shares a category you left on with Sage 300 CRE.');
    expect(text(empty)).not.toContain('data object');
    click('[data-testid="pair-matches-empty"] button');
    expect(cardNames(el)).toEqual(['Alpha Ledger']);
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

  it('moves focus to the pressed keep toggle when the no-lane state switches the lane', async () => {
    const { fixture, el } = setup({
      ...ALTERNATIVES,
      lanes: {
        context: { anchors: ALTERNATIVES.lanes.context.anchors, matches: [] },
        other: ALTERNATIVES.lanes.context,
      },
    });
    document.body.appendChild(el);
    try {
      const empty = el.querySelector('[data-testid="pair-matches-empty"]')!;
      expect(empty.getAttribute('data-empty')).toBe('no-lane');
      const button = empty.querySelector<HTMLButtonElement>('button')!;
      expect(text(button)).toBe('Keep Sage 300 CRE');
      button.focus();
      button.click();
      await fixture.whenStable();
      // The message and its button are gone; focus is on the toggle now pressed, not the body.
      expect(el.querySelector('[data-testid="pair-matches-empty"]')).toBeNull();
      const toggle = el.querySelector('[data-testid="pair-matches-keep-other"]')!;
      expect(toggle.getAttribute('aria-pressed')).toBe('true');
      expect(document.activeElement).toBe(toggle);
    } finally {
      el.remove();
    }
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
    const { el, clickTable } = setup();
    clickTable();
    const rows = Array.from(el.querySelectorAll('[data-testid="pair-matches-table"] tbody tr'));
    expect(rows.map((r) => text(r.querySelector('th a')))).toEqual(['zeta Books', 'Alpha Ledger']);
    expect(text(el.querySelector('[data-testid="pair-matches-table"] thead'))).toContain(
      'Instead of Sage 300 CRE',
    );
  });

  it('words direction and scores with the shared labels (AECI-1720 restore C)', () => {
    const lanes = ALTERNATIVES.lanes;
    const { el, clickTable } = setup({
      ...ALTERNATIVES,
      lanes: {
        ...lanes,
        context: {
          ...lanes.context,
          matches: [
            { ...lanes.context.matches[0]!, direction: 'outbound' },
            { ...lanes.context.matches[1]!, direction: 'both' },
          ],
        },
      },
    });
    const cards = el.querySelectorAll('[data-testid="pair-matches-cards"] article');
    // The match is the partner: Revu sends to it.
    expect(text(cards[0])).toContain('Sends to zeta Books');
    expect(text(cards[1])).toContain('Syncs both ways');
    expect(text(cards[0])).not.toMatch(/Outbound|Inbound/);
    clickTable();
    const head = text(el.querySelector('[data-testid="pair-matches-table"] thead'));
    expect(head).toContain('Product quality');
    expect(head).toContain('Onboarding experience');
    const firstRow = el.querySelector('[data-testid="pair-matches-table"] tbody tr');
    expect(text(firstRow)).toContain('Sends to zeta Books');
  });

  it('orders the section: lane switch, filter panel, list row with the view toggle, then cards', () => {
    const { el } = setup();
    const section = el.querySelector('[data-testid="pair-empty-matches"]')!;
    const order = [
      'pair-matches-intro',
      'pair-matches-lane-switch',
      'pair-matches-filter-panel',
      'pair-matches-list-row',
      'pair-matches-order',
      'pair-matches-cards',
    ].map((id) => section.querySelector(`[data-testid="${id}"]`)!);
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    // The lane switch names the lanes; its pressed option and the hidden h3 agree.
    const lanes = el.querySelectorAll('[data-testid="pair-matches-lane-switch"] button');
    expect(Array.from(lanes).map((b) => text(b.querySelector('.break-words')))).toEqual([
      'Bluebeam Revu integrations',
      'Sage 300 CRE integrations',
    ]);
    expect(lanes[0]!.getAttribute('aria-pressed')).toBe('true');
    const heading = el.querySelector('[data-testid="pair-matches-lane-heading"]')!;
    expect(heading.tagName).toBe('H3');
    expect(heading.className).toContain('sr-only');
    // One Bone panel holds the search and the categories, and no toggle.
    const panel = el.querySelector('[data-testid="pair-matches-filter-panel"]')!;
    expect(panel.className).toContain('bg-(--accent-warm)');
    expect(panel.querySelector('#pair-matches-filter')).toBeTruthy();
    expect(panel.querySelector('[data-testid="pair-matches-anchors"]')).toBeTruthy();
    expect(panel.querySelector('[aria-pressed][data-testid^="pair-matches-keep"]')).toBeNull();
    // The list row: the announced count, then the shared Cards and Table toggle.
    const row = el.querySelector('[data-testid="pair-matches-list-row"]')!;
    const count = row.querySelector('[data-testid="pair-matches-count"]')!;
    expect(text(count)).toBe('Showing 2 of 2');
    expect(count.getAttribute('aria-live')).toBe('polite');
    expect(row.querySelector('aec-listing-view-toggle')).toBeTruthy();
    // The old count line beside the intro is gone.
    expect(el.querySelector('[data-testid="pair-matches-count-badge"]')).toBeNull();
  });

  it('draws the card from the match card recipe', () => {
    const { el } = setup();
    const card = el.querySelector('[data-testid="pair-matches-cards"] article')!;
    // Mock-up 5's .mini chip: the sunken pill, 13px at 600, its glyph where the map has one.
    const chip = card.querySelector('[data-testid="pair-match-objects"] > span')!;
    expect(chip.className).toContain('bg-(--surface-sunken)');
    expect(chip.className).toContain('py-[5px]');
    expect(chip.querySelector('aec-icon')).toBeTruthy();
    expect(card.className).toContain('gap-5');
    expect(card.className).toContain('md:p-8');
    expect(card.querySelector('h4')!.className).toContain('text-t-24');
    const scores = card.querySelector('[data-testid="pair-match-scores"]')!;
    expect(scores.className).toContain('border');
    expect(scores.className).toContain('p-4');
    expect(scores.className).toContain('bg-(--surface-raised)');
    // A score label never wraps; a narrow box stacks the stars under every label alike.
    expect(scores.querySelector('dt')!.className).toContain('whitespace-nowrap');
    expect(scores.querySelector('dl > div')!.className).toContain('max-sm:flex-col');
    // The foot keeps its words as the link's name. The round button is a chevron, hidden.
    const link = card.querySelector<HTMLAnchorElement>('[data-testid="pair-match-link-zeta"]')!;
    expect(text(link)).toBe('Bluebeam Revu and zeta Books');
    const go = link.querySelector('[data-testid="pair-match-go"]')!;
    expect(go.getAttribute('aria-hidden')).toBe('true');
    expect(go.className).toContain('rounded-full');
  });

  it('states the real order, not the mock-up text', () => {
    const { el } = setup();
    const order = text(el.querySelector('[data-testid="pair-matches-order"]'));
    expect(order).toContain('Products run A to Z by name.');
    expect(order).not.toMatch(/Merit only|common with your picks come first/);
    // AECI-1894: the ranking page's words, approved 2026-11-20 (STAGE_1_5_SPEC.md 11.3).
    expect(order).toContain('Searching narrows the list. It does not change the order.');
    expect(order).toContain(
      "The order never reads a vendor's plan. Who appears depends only on the integrations and data on record. A vendor on any plan can add data to its own integrations, so its product can match a data filter it would not match otherwise.",
    );
    expect(order).not.toContain('Plan or license status has no effect');
    // The legal agent's second pass of 2026-11-20.
    expect(order).toContain('No paid positions');
    expect(order).toContain('No vendor pays for a position in this list.');
    expect(order).not.toMatch(/No paid places|pays for a place here/);
  });
});
