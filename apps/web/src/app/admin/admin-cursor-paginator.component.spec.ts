/**
 * AECI-2102: `AdminCursorPaginator` keeps focus. Its controls are aria-disabled,
 * never natively disabled, so a press that starts a fetch or reaches an edge does
 * not drop focus to `<body>`, and a press while busy does nothing.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminCursorPaginator } from './admin-cursor-paginator';

function render(opts: { hasPrev: boolean; hasNext: boolean; busy?: boolean }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(AdminCursorPaginator);
  fixture.componentRef.setInput('hasPrev', opts.hasPrev);
  fixture.componentRef.setInput('hasNext', opts.hasNext);
  fixture.componentRef.setInput('canFirst', opts.hasPrev);
  fixture.componentRef.setInput('perPage', 50);
  fixture.componentRef.setInput('pageSizes', [25, 50, 100]);
  fixture.componentRef.setInput('busy', opts.busy ?? false);
  const events: string[] = [];
  fixture.componentInstance.prev.subscribe(() => events.push('prev'));
  fixture.componentInstance.next.subscribe(() => events.push('next'));
  fixture.componentInstance.first.subscribe(() => events.push('first'));
  fixture.componentInstance.pageSizeChange.subscribe((n: number) => events.push(`size:${n}`));
  fixture.detectChanges();
  return { fixture, events, el: fixture.nativeElement as HTMLElement };
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const btn = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn as HTMLButtonElement;
}

describe('AdminCursorPaginator', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('emits Previous, Next and First page when each can act', () => {
    const { el, events } = render({ hasPrev: true, hasNext: true });
    button(el, 'Previous').click();
    button(el, 'Next').click();
    button(el, 'First page').click();
    expect(events).toEqual(['prev', 'next', 'first']);
  });

  it('marks an edge aria-disabled, keeps it focusable, and ignores its press', () => {
    const { el, events } = render({ hasPrev: false, hasNext: true });
    const prev = button(el, 'Previous');
    expect(prev.disabled).toBe(false);
    expect(prev.getAttribute('aria-disabled')).toBe('true');
    prev.click();
    expect(events).toEqual([]);
  });

  it('keeps focus on Next when the fetch it started makes the pager busy', () => {
    const { el, fixture, events } = render({ hasPrev: true, hasNext: true });
    document.body.appendChild(el);
    const next = button(el, 'Next');
    next.focus();
    next.click();
    fixture.componentRef.setInput('busy', true);
    fixture.detectChanges();
    expect(events).toEqual(['next']);
    // DESIGN.md: a busy state marks the nav aria-busy, not the button aria-disabled.
    expect(el.querySelector('nav')?.getAttribute('aria-busy')).toBe('true');
    expect(next.disabled).toBe(false);
    expect(document.activeElement).toBe(next);
    // A second press during the fetch does nothing.
    next.click();
    expect(events).toEqual(['next']);
    el.remove();
  });

  it('puts back a page-size change made during a fetch', () => {
    const { el, events } = render({ hasPrev: true, hasNext: true, busy: true });
    const select = el.querySelector('select') as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    select.value = '100';
    select.dispatchEvent(new Event('change'));
    expect(events).toEqual([]);
    expect(select.value).toBe('50');
  });
});
