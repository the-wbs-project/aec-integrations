import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { SortableColumnHeader } from './sortable-column-header';

@Component({
  imports: [SortableColumnHeader],
  template: `
    <table>
      <thead>
        <tr>
          <aec-sortable-column-header
            [key]="key"
            [direction]="direction"
            [currentSort]="currentSort()"
            [label]="label"
            (sortChange)="emitted.set($event)"
          />
        </tr>
      </thead>
    </table>
  `,
})
class Host {
  key = 'name';
  label = 'Name';
  direction: 'ascending' | 'descending' = 'ascending';
  currentSort = signal('created');
  emitted = signal<string | null>(null);
}

describe('SortableColumnHeader', () => {
  it('emits the column key on click', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button')!;
    button.click();
    fixture.detectChanges();

    expect(fixture.componentInstance.emitted()).toBe('name');
  });

  it('reflects active state with aria-sort="ascending" when direction is ascending', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.direction = 'ascending';
    fixture.componentInstance.currentSort.set('name');
    fixture.detectChanges();

    const th = (fixture.nativeElement as HTMLElement).querySelector('th')!;
    expect(th.getAttribute('aria-sort')).toBe('ascending');
  });

  it('reflects active state with aria-sort="descending" when direction is descending', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.direction = 'descending';
    fixture.componentInstance.currentSort.set('name');
    fixture.detectChanges();

    const th = (fixture.nativeElement as HTMLElement).querySelector('th')!;
    expect(th.getAttribute('aria-sort')).toBe('descending');
  });

  it('renders aria-sort="none" when the column is inactive', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const th = (fixture.nativeElement as HTMLElement).querySelector('th')!;
    expect(th.getAttribute('aria-sort')).toBe('none');
  });

  it('wraps a real <button> (keyboard activation works without extra ARIA)', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();

    const button = (fixture.nativeElement as HTMLElement).querySelector('button');
    expect(button).not.toBeNull();
    expect(button!.getAttribute('type')).toBe('button');
  });
});
