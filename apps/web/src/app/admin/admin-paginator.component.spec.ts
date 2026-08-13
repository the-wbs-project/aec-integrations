/**
 * AECI-577 — `AdminPaginator`: prev/next paging for the admin panel.
 *
 * The behaviour worth pinning is the edges: it disappears when there is only one
 * page, it never emits out of range, and the position sentence reports the true
 * total (the operator has to know the size of what they are walking).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminPaginator } from './admin-paginator';

function render(page: number, perPage: number, total: number) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AdminPaginator);
  fixture.componentRef.setInput('page', page);
  fixture.componentRef.setInput('perPage', perPage);
  fixture.componentRef.setInput('total', total);
  const emitted: number[] = [];
  fixture.componentInstance.pageChange.subscribe((n: number) => emitted.push(n));
  fixture.detectChanges();
  return { fixture, emitted, el: fixture.nativeElement as HTMLElement };
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

describe('AdminPaginator', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders nothing when everything fits on one page', () => {
    expect(render(1, 50, 12).el.querySelector('nav')).toBeNull();
    expect(render(1, 50, 50).el.querySelector('nav')).toBeNull();
  });

  it('reports the position and the true total', () => {
    const { el } = render(2, 50, 120);
    expect(el.textContent).toContain('Page 2 of 3 · 120 rows');
  });

  it('emits the next and previous page', () => {
    const { el, emitted } = render(2, 50, 120);
    button(el, 'Next').click();
    button(el, 'Previous').click();
    expect(emitted).toEqual([3, 1]);
  });

  it('disables the edges and never emits out of range', () => {
    const first = render(1, 50, 120);
    expect(button(first.el, 'Previous').disabled).toBe(true);
    button(first.el, 'Previous').click();
    expect(first.emitted).toEqual([]);

    const last = render(3, 50, 120);
    expect(button(last.el, 'Next').disabled).toBe(true);
    button(last.el, 'Next').click();
    expect(last.emitted).toEqual([]);
  });

  it('names the navigation landmark', () => {
    const { el } = render(1, 50, 120);
    expect(el.querySelector('nav')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('survives a zero perPage rather than dividing by it', () => {
    const { el } = render(1, 0, 120);
    expect(el.textContent).toContain('Page 1 of 120 · 120 rows');
  });
});
