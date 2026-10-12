/**
 * The Plans page's pricing cards and comparison table
 * (`docs-plans-comparison.ts`). The cards themselves are pinned in
 * `shared/plan-cta/plan-cards.component.spec.ts`. The page-level placement is pinned in
 * `docs-page.component.spec.ts`.
 *
 * `*.component.spec.ts` because the component reads `$localize`, which only the
 * Angular `ng test` tier sets up.
 */
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import { TIER_CAPABILITIES } from '@aeci/shared/entitlements';

import { Analytics } from '../analytics/analytics';
import { PlanInquiryService } from '../shared/plan-inquiry/plan-inquiry.service';
import { DocsPlansComparisonComponent, planComparisonGroups } from './docs-plans-comparison';

function render(): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(DocsPlansComparisonComponent);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const rows = planComparisonGroups('en-US').flatMap((group) => group.rows);
const row = (label: string) => rows.find((entry) => entry.label === label)!;

describe('planComparisonGroups', () => {
  // The table must never promise what the API refuses.
  it('reads every capability row from the registry', () => {
    expect(row('Product description, website, logo and categories').free).toBe(
      TIER_CAPABILITIES.unclaimed.includes('product.categories.edit'),
    );
    expect(row('Confirm which data each integration moves')).toMatchObject({
      free: false,
      managed: true,
    });
    expect(row('Answer reviews in public')).toMatchObject({ free: false, managed: true });
    expect(row('"How teams use it", in your own words')).toMatchObject({
      free: false,
      managed: true,
    });
  });

  // Managed holds everything Free holds: no row may be Free-only.
  it('has no row Free includes and Managed does not', () => {
    for (const entry of rows) {
      if (entry.free === true) expect(entry.managed, entry.label).toBe(true);
    }
  });

  // Marketing review 2026-10-12: portal how-tos and unshipped work stay out of the table.
  it('names neither "Looks right" nor checklists nor unshipped work', () => {
    const labels = planComparisonGroups('en-US').map((group) => group.label);
    expect(labels).not.toContain('Coming soon');
    expect(rows.some((entry) => /Looks right|checklist/i.test(entry.label))).toBe(false);
  });

  it('prints the list price', () => {
    expect(row('Price')).toMatchObject({ free: '$0', managed: '$25 a month per product' });
  });
});

describe('DocsPlansComparisonComponent', () => {
  it('renders the Free and Managed cards, the Managed one featured', () => {
    const host = render();
    const cards = host.querySelectorAll('.aec-plan-card');
    expect([...cards].map((card) => card.querySelector('h3')?.textContent?.trim())).toEqual([
      'Free',
      'Managed',
    ]);
    expect(cards[1].classList).toContain('aec-plan-card-featured');
    expect(cards[0].textContent).toContain('$0');
    expect(cards[1].textContent).toContain('$25');
    expect(cards[1].querySelector('a')?.getAttribute('href')).toBe('/contact?topic=managed');
    expect(cards[1].querySelector('a')?.textContent?.trim()).toBe('Talk to us about Managed');
    // The docs card keeps its shipped wording and target (AECI-1289: no visual change).
    expect(cards[0].querySelector('a')?.textContent?.trim()).toBe('Claim your listing');
    expect(cards[0].querySelector('a')?.getAttribute('href')).toBe(
      '/docs/vendors/claiming-your-listing',
    );
  });

  // AECI-1279: the card's button opens the page's one inquiry dialog in place.
  it('opens the inquiry dialog from the Managed card, tracked as the card', () => {
    const planCtaClicked = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Analytics, useValue: { planCtaClicked } }],
    });
    const inquiry = TestBed.inject(PlanInquiryService);
    inquiry.attachHost();
    const fixture = TestBed.createComponent(DocsPlansComparisonComponent);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement)
      .querySelectorAll('.aec-plan-card')[1]
      .querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(inquiry.placement()).toBe('card');
    expect(inquiry.page()).toBe('docs_plans');
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'managed',
      placement: 'card',
      page: 'docs_plans',
    });
  });

  // The trust point is the sort rule, never a promise that Managed ranks higher.
  it('states the sort rule under the cards', () => {
    expect(render().querySelector('.aec-plan-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Every listing is sorted the same way: how well it matches the search, then how complete it is. Your plan is not part of that.',
    );
  });

  it('names every check and dash in words, and scopes the headers', () => {
    const host = render();
    const table = host.querySelector('table')!;
    expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(3);
    expect(table.querySelectorAll('th[scope="colgroup"]').length).toBeGreaterThan(0);
    for (const cell of table.querySelectorAll('td')) {
      if (cell.querySelector('svg')) {
        expect(cell.querySelector('.sr-only')?.textContent?.trim()).toMatch(
          /^(Included|Not included)$/,
        );
      }
    }
  });
});
