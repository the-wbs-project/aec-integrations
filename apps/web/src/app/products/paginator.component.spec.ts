import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { Paginator } from './paginator';

@Component({
  imports: [Paginator],
  template: `
    <aec-paginator
      [page]="page()"
      [perPage]="perPage()"
      [total]="total()"
      (pageChange)="emitted.set($event)"
    />
  `,
})
class Host {
  page = signal(1);
  perPage = signal(24);
  total = signal(50);
  emitted = signal<number | null>(null);
}

function buttons(fixture: ReturnType<typeof TestBed.createComponent<Host>>): {
  prev: HTMLButtonElement;
  next: HTMLButtonElement;
} {
  const list = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
  return { prev: list[0] as HTMLButtonElement, next: list[1] as HTMLButtonElement };
}

describe('Paginator', () => {
  it('disables Previous on the first page', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const { prev } = buttons(fixture);
    expect(prev.disabled).toBe(true);
  });

  it('disables Next on the last page', () => {
    const fixture = TestBed.createComponent(Host);
    // 50 / 24 = 3 pages (24, 24, 2). Page 3 is last.
    fixture.componentInstance.page.set(3);
    fixture.detectChanges();
    const { next } = buttons(fixture);
    expect(next.disabled).toBe(true);
  });

  it('emits next page number when Next is clicked', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const { next } = buttons(fixture);
    next.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.emitted()).toBe(2);
  });

  it('emits previous page number when Previous is clicked', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.page.set(2);
    fixture.detectChanges();
    const { prev } = buttons(fixture);
    prev.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.emitted()).toBe(1);
  });

  it('renders zero-state range when total is 0', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.total.set(0);
    fixture.detectChanges();
    const summary = (fixture.nativeElement as HTMLElement).querySelector('p')!.textContent ?? '';
    expect(summary).toContain('Showing 0–0 of 0');
  });

  it('caps rangeEnd at total on the last partial page', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.page.set(3);
    fixture.detectChanges();
    const summary = (fixture.nativeElement as HTMLElement).querySelector('p')!.textContent ?? '';
    // perPage=24, total=50, page=3 → start=49, end=50
    expect(summary).toContain('Showing 49–50 of 50');
  });
});
