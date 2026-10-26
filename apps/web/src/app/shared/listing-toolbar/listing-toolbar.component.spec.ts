import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it } from 'vitest';

import { ListingSortSelect } from './listing-sort-select';
import { ListingToolbar, type ListingView } from './listing-toolbar';
import { PRODUCT_SORT_KEYS, productSortOptions } from './product-sort-options';

@Component({
  imports: [ListingToolbar],
  template: `
    <aec-listing-toolbar
      [sortOptions]="options"
      [sort]="sort()"
      [view]="view()"
      (sortChange)="lastSort = $event"
      (viewChange)="lastView = $event"
    />
  `,
})
class Host {
  readonly options = productSortOptions();
  readonly sort = signal('created');
  readonly view = signal<ListingView>('cards');
  lastSort: string | null = null;
  lastView: ListingView | null = null;
}

const el = (fixture: ComponentFixture<Host>) => fixture.nativeElement as HTMLElement;

describe('ListingToolbar (AECI-657)', () => {
  let fixture: ComponentFixture<Host>;

  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [Host] });
    fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
  });

  // The listbox only exists while the popup is open (see
  // listing-sort-select.component.spec.ts), so the option set is asserted on the
  // input the toolbar hands the shared sort control.
  const sortSelect = () =>
    fixture.debugElement.query(By.directive(ListingSortSelect))
      .componentInstance as ListingSortSelect;
  const trigger = () => el(fixture).querySelector('button[role="combobox"]') as HTMLButtonElement;

  it('renders the shared sort control, not a native select (2026-10-26)', () => {
    expect(el(fixture).querySelector('aec-listing-sort-select')).not.toBeNull();
    expect(el(fixture).querySelector('select')).toBeNull();
  });

  it('hands the sort control one option per shared sort key, in order', () => {
    expect(
      sortSelect()
        .options()
        .map((o) => o.value),
    ).toEqual([...PRODUCT_SORT_KEYS]);
  });

  // §4.5 named alphabetical, most integrations and most reviewed. AECI-636 PR-B
  // retired "Most integrations", so exactly the other two remain from that list.
  it('offers alphabetical and most reviewed, and no longer "Most integrations"', () => {
    const labels = sortSelect()
      .options()
      .map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(['Name (A–Z)', 'Most reviewed']));
    expect(labels).not.toContain('Most integrations');
    expect(
      sortSelect()
        .options()
        .map((o) => o.value),
    ).not.toContain('integrations');
  });

  it('shows the active sort in the trigger rather than holding its own state', () => {
    expect(trigger().textContent).toContain('Newest');
    fixture.componentInstance.sort.set('reviews');
    fixture.detectChanges();
    expect(trigger().textContent).toContain('Most reviewed');
  });

  it('emits the chosen sort key and does NOT move on its own', () => {
    sortSelect().sortChange.emit('rating');
    fixture.detectChanges();

    expect(fixture.componentInstance.lastSort).toBe('rating');
    // Presentation-only: the host owns the truth, so the input is unchanged and
    // the rendered value follows the input, not the choice.
    expect(fixture.componentInstance.sort()).toBe('created');
    expect(trigger().textContent).toContain('Newest');
  });

  it('exposes the active view through aria-pressed on both buttons', () => {
    const pressed = () =>
      [...el(fixture).querySelectorAll('button[aria-pressed]')].map((b) =>
        b.getAttribute('aria-pressed'),
      );
    expect(pressed()).toEqual(['true', 'false']);

    fixture.componentInstance.view.set('table');
    fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'true']);
  });

  it('emits the requested view on toggle click', () => {
    el(fixture).querySelectorAll<HTMLButtonElement>('button[aria-pressed]')[1]!.click();
    expect(fixture.componentInstance.lastView).toBe('table');
  });

  it('names the sort trigger by its "Sort" label, so the control has an accessible name', () => {
    const labelId = trigger().getAttribute('aria-labelledby')!.split(' ')[0]!;
    expect(el(fixture).querySelector(`#${labelId}`)?.textContent?.trim()).toBe('Sort');
  });
});
