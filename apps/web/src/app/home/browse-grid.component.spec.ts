import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { BrowseGrid } from './browse-grid';

@Component({
  imports: [BrowseGrid],
  template: `<app-browse-grid [kind]="kind" [terms]="terms" />`,
})
class BrowseGridHost {
  kind: TaxonomyKind = 'category';
  terms: TaxonomyTermWithCount[] = [];
}

function term(slug: string, name: string, product_count: number): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count };
}

function renderHost(kind: TaxonomyKind, terms: TaxonomyTermWithCount[]): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(BrowseGridHost);
  fixture.componentInstance.kind = kind;
  fixture.componentInstance.terms = terms;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('BrowseGrid', () => {
  it.each([
    ['category', 'Browse by category', '/categories', 'View all categories'],
    ['audience', 'Browse by audience', '/audiences', 'View all audiences'],
    ['phase', 'Browse by project phase', '/phases', 'View all phases'],
  ] as const)(
    '%s: renders an h2 heading and a "View all" link to the facet index',
    (kind, heading, indexHref, viewAllLabel) => {
      const root = renderHost(kind, [term('a', 'Alpha', 3)]);

      const h2 = root.querySelector('h2');
      expect(h2?.textContent?.trim()).toBe(heading);

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

  it('renders terms in the order given (ranking is the caller’s job)', () => {
    const root = renderHost('audience', [term('z', 'Zeta', 9), term('a', 'Alpha', 1)]);
    const chips = Array.from(root.querySelectorAll('ul a[href^="/audiences/"]'));
    expect(chips.map((c) => c.getAttribute('href'))).toEqual(['/audiences/z', '/audiences/a']);
  });

  it('renders the section frame (heading + View all) with an empty note when there are no terms', () => {
    const root = renderHost('phase', []);
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Browse by project phase');
    expect(root.querySelector('a[href="/phases"]')).not.toBeNull();
    expect(root.querySelectorAll('ul a[href^="/phases/"]')).toHaveLength(0);
    expect(root.querySelector('p')?.textContent?.trim()).toBe('No project phases to browse yet.');
  });

  it('uses a single h2 (no skipped heading level) for axe heading-order', () => {
    const root = renderHost('category', [term('a', 'Alpha', 2)]);
    expect(root.querySelectorAll('h1, h3, h4, h5, h6')).toHaveLength(0);
    expect(root.querySelectorAll('h2')).toHaveLength(1);
  });
});
