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
import { ClaimDialogService } from '../shared/claim-dialog/claim-dialog.service';
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

  // Chris, 2026-10-13: connector-delivered integrations are not a plan benefit.
  it('sells no connector integrations', () => {
    expect(rows.some((entry) => /connector/i.test(entry.label))).toBe(false);
  });

  // E8.2 (2026-10-19): both list prices, and billing names the term, not a payment method.
  it('prints both list prices and the billing term', () => {
    expect(row('Price')).toMatchObject({
      free: '$0',
      managed: '$25 USD a month or $250 USD a year per product',
    });
    expect(row('Billing')).toMatchObject({
      free: 'Nothing to pay',
      managed: 'By card, monthly or yearly',
    });
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
    expect(cards[0].textContent).toContain('Available for all products');
    expect(cards[1].textContent).toContain('$25');
    // AECI-1293: both cards open the claim dialog; no-JS lands on the search page.
    expect(cards[1].querySelector('a')?.textContent?.trim()).toBe('Claim your listing');
    expect(cards[1].querySelector('a')?.getAttribute('href')).toBe('/search');
    expect(cards[0].querySelector('a')?.textContent?.trim()).toBe('Claim your listing');
    expect(cards[0].querySelector('a')?.getAttribute('href')).toBe('/search');
  });

  // AECI-1293: the Managed card opens the claim dialog. E8.2: it reads "Claim your listing".
  it('opens the claim dialog from the Managed card, tracked as the card', () => {
    const planCtaClicked = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Analytics, useValue: { planCtaClicked } }],
    });
    const claim = TestBed.inject(ClaimDialogService);
    claim.attachHost();
    const fixture = TestBed.createComponent(DocsPlansComparisonComponent);
    fixture.detectChanges();
    const link = (fixture.nativeElement as HTMLElement)
      .querySelectorAll('.aec-plan-card')[1]
      .querySelector('a')!;
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(claim.opening()).toEqual({ page: 'docs_plans', entry: 'card' });
    expect(planCtaClicked).toHaveBeenCalledWith({
      plan: 'managed',
      placement: 'card',
      page: 'docs_plans',
    });
  });

  // The trust point is the sort rule, never a promise that Managed ranks higher.
  it('states the sort rule under the cards', () => {
    expect(render().querySelector('.aec-plan-note')?.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'Every listing is sorted by the same published rules. Your plan is not part of that.',
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
