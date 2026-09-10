import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { IntegrationListFilter } from './integration-list-filter';

/**
 * AECI-841 — the section filter box.
 *
 * Two things are worth a test rather than a comment. The status paragraph is a
 * WCAG 4.1.3 status message, so it must be in the DOM before it has text (a live
 * region created at the same moment its text arrives is frequently not announced
 * at all). And the input is labelled, because the visible section heading is an
 * `<h2>` and is not a label.
 */
@Component({
  imports: [IntegrationListFilter],
  template: `
    <aec-integration-list-filter
      inputId="test-filter"
      label="Search these integrations"
      placeholder="Filter by product name"
      [(query)]="query"
      [shown]="shown()"
      [total]="total()"
    />
  `,
})
class Host {
  query = signal('');
  shown = signal(37);
  total = signal(37);
}

function setup() {
  const fixture = TestBed.createComponent(Host);
  fixture.detectChanges();
  return { fixture, host: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
}

describe('IntegrationListFilter', () => {
  it('labels the input, and uses a search input so the browser supplies clear', () => {
    const { el } = setup();
    const input = el.querySelector<HTMLInputElement>('input#test-filter')!;
    expect(input.type).toBe('search');
    expect(input.getAttribute('placeholder')).toBe('Filter by product name');
    const label = el.querySelector<HTMLLabelElement>('label[for="test-filter"]')!;
    expect(label.textContent).toContain('Search these integrations');
  });

  it('renders the status region from first paint, with no text while idle', () => {
    const { el } = setup();
    const status = el.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status!.textContent?.trim()).toBe('');
  });

  it('reports the filtered count once a query is present', () => {
    const { fixture, host, el } = setup();
    host.query.set('sage');
    host.shown.set(4);
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')!.textContent).toContain('Showing 4 of 37');
  });

  it('writes every keystroke back through the two-way query', () => {
    const { fixture, host, el } = setup();
    const input = el.querySelector<HTMLInputElement>('input')!;
    input.value = 'proc';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(host.query()).toBe('proc');
  });

  it('says nothing for a whitespace-only query', () => {
    const { fixture, host, el } = setup();
    host.query.set('   ');
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')!.textContent?.trim()).toBe('');
  });
});
