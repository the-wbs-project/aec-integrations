import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

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

  it('renders one option per shared sort key, in order', () => {
    const options = [...el(fixture).querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual([...PRODUCT_SORT_KEYS]);
  });

  // §4.5 named alphabetical, most integrations and most reviewed. AECI-636 PR-B
  // retired "Most integrations", so exactly the other two remain from that list.
  it('offers alphabetical and most reviewed, and no longer "Most integrations"', () => {
    const labels = [...el(fixture).querySelectorAll('option')].map((o) => o.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(['Name (A–Z)', 'Most reviewed']));
    expect(labels).not.toContain('Most integrations');
    const values = [...el(fixture).querySelectorAll('option')].map((o) => o.value);
    expect(values).not.toContain('integrations');
  });

  it('marks the active sort selected rather than holding its own state', () => {
    fixture.componentInstance.sort.set('reviews');
    fixture.detectChanges();
    expect(el(fixture).querySelector('select')!.value).toBe('reviews');
  });

  it('emits the chosen sort key and does NOT move on its own', () => {
    const select = el(fixture).querySelector('select')!;
    select.value = 'rating';
    select.dispatchEvent(new Event('change'));
    fixture.detectChanges();

    expect(fixture.componentInstance.lastSort).toBe('rating');
    // Presentation-only: the host owns the truth, so the input is unchanged and
    // the rendered value follows the input, not the click.
    expect(fixture.componentInstance.sort()).toBe('created');
  });

  it('exposes the active view through aria-pressed on both buttons', () => {
    const pressed = () =>
      [...el(fixture).querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed'));
    expect(pressed()).toEqual(['true', 'false']);

    fixture.componentInstance.view.set('table');
    fixture.detectChanges();
    expect(pressed()).toEqual(['false', 'true']);
  });

  it('emits the requested view on toggle click', () => {
    el(fixture).querySelectorAll('button')[1]!.click();
    expect(fixture.componentInstance.lastView).toBe('table');
  });

  it('associates the label with the select, so the control has an accessible name', () => {
    const label = el(fixture).querySelector('label')!;
    const select = el(fixture).querySelector('select')!;
    expect(label.getAttribute('for')).toBe(select.id);
    expect(select.id).toBeTruthy();
  });
});
