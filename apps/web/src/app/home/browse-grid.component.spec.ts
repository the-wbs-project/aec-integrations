import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { BrowseGrid, type HomeBrowseKind } from './browse-grid';

@Component({
  imports: [BrowseGrid],
  template: `<app-browse-grid [kind]="kind" [terms]="terms"
    ><p class="lede">Lede</p></app-browse-grid
  >`,
})
class BrowseGridHost {
  kind: HomeBrowseKind = 'category';
  terms: TaxonomyTermWithCount[] = [];
}

function term(slug: string, name: string, product_count: number): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count };
}

function renderHost(kind: HomeBrowseKind, terms: TaxonomyTermWithCount[]): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(BrowseGridHost);
  fixture.componentInstance.kind = kind;
  fixture.componentInstance.terms = terms;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('BrowseGrid', () => {
  it.each([
    ['category', 'Category', '/categories', 'View all categories'],
    ['audience', 'Audience', '/audiences', 'View all audiences'],
    ['phase', 'Project phase', '/phases', 'View all phases'],
  ] as const)(
    '%s: renders an h3 row label and a "View all" link to the facet index',
    (kind, label, indexHref, viewAllLabel) => {
      const root = renderHost(kind, [term('a', 'Alpha', 3)]);

      expect(root.querySelector('h3')?.textContent?.trim()).toBe(label);

      const viewAll = root.querySelector(`a[href="${indexHref}"]`);
      expect(viewAll).not.toBeNull();
      expect(viewAll?.textContent?.trim()).toBe(viewAllLabel);
    },
  );

  it('renders one count-chip per term, linking to its browse page with its count', () => {
    const root = renderHost('category', [
      term('bim-authoring', 'BIM Authoring', 12),
      term('estimating', 'Estimating', 5),
    ]);

    const chips = root.querySelectorAll('ul a[href^="/categories/"]');
    expect(chips).toHaveLength(2);
    expect(chips[0]?.getAttribute('href')).toBe('/categories/bim-authoring');
    expect(chips[0]?.textContent).toContain('12');
    expect(chips[0]?.getAttribute('aria-label')).toBe('BIM Authoring 12 products');
    expect(chips[1]?.getAttribute('href')).toBe('/categories/estimating');
  });

  it('suppresses a zero count, so a thin corpus never prints a bare "0"', () => {
    const root = renderHost('phase', [term('design', 'Design', 0)]);
    const chip = root.querySelector('ul a[href="/phases/design"]');
    expect(chip?.textContent?.trim()).toBe('Design');
    expect(chip?.hasAttribute('aria-label')).toBe(false);
  });

  it('renders terms in the order given (ranking is the caller’s job)', () => {
    const root = renderHost('audience', [term('z', 'Zeta', 9), term('a', 'Alpha', 1)]);
    const chips = Array.from(root.querySelectorAll('ul a[href^="/audiences/"]'));
    expect(chips.map((c) => c.getAttribute('href'))).toEqual(['/audiences/z', '/audiences/a']);
  });

  it('projects content (the audience lede) above the chips', () => {
    const root = renderHost('audience', [term('a', 'Alpha', 1)]);
    const lede = root.querySelector('p.lede');
    expect(lede).not.toBeNull();
    const ul = root.querySelector('ul');
    expect(lede!.compareDocumentPosition(ul!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the row frame (label + View all) with an empty note when there are no terms', () => {
    const root = renderHost('phase', []);
    expect(root.querySelector('h3')?.textContent?.trim()).toBe('Project phase');
    expect(root.querySelector('a[href="/phases"]')).not.toBeNull();
    expect(root.querySelectorAll('ul a[href^="/phases/"]')).toHaveLength(0);
    expect(root.textContent).toContain('No project phases to browse yet.');
  });

  it('uses a single h3 so it nests under the browse block h2', () => {
    const root = renderHost('category', [term('a', 'Alpha', 2)]);
    expect(root.querySelectorAll('h1, h2, h4, h5, h6')).toHaveLength(0);
    expect(root.querySelectorAll('h3')).toHaveLength(1);
  });
});
