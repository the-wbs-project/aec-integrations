import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { IndexLayout } from './index-layout';

@Component({
  imports: [IndexLayout],
  template: `
    <aec-index-layout>
      <header slot="header" data-testid="header">Header marker</header>
      <ng-container slot="table-header">
        <tr data-testid="thead-row">
          <th scope="col">Name</th>
        </tr>
      </ng-container>
      <ng-container slot="table-body">
        <tr data-testid="tbody-row">
          <td>Row marker</td>
        </tr>
      </ng-container>
      <nav slot="pagination" data-testid="pagination">Pagination marker</nav>
    </aec-index-layout>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class IndexLayoutHost {}

describe('IndexLayout', () => {
  it('projects all four named slots into the correct table structure', () => {
    const fixture = TestBed.createComponent(IndexLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid=header]')?.textContent).toContain('Header marker');
    expect(root.querySelector('thead [data-testid=thead-row]')).not.toBeNull();
    expect(root.querySelector('tbody [data-testid=tbody-row]')?.textContent).toContain(
      'Row marker',
    );
    expect(root.querySelector('[data-testid=pagination]')?.textContent).toContain(
      'Pagination marker',
    );
  });

  it('renders a table with an i18n aria-label and pagination nav', () => {
    const fixture = TestBed.createComponent(IndexLayoutHost);
    fixture.detectChanges();

    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('table[aria-label]')).not.toBeNull();
    expect(root.querySelector('nav[aria-label]')).not.toBeNull();
  });
});
