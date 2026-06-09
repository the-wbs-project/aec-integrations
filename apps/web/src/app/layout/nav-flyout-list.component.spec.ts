import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { NavFlyoutList } from './nav-flyout-list';

function term(slug: string, name: string): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count: 0 };
}

@Component({
  imports: [NavFlyoutList],
  template: `<aec-nav-flyout-list [items]="items" [kind]="kind" [viewAllLabel]="viewAllLabel" />`,
})
class Host {
  items: TaxonomyTermWithCount[] = [term('bim', 'BIM Authoring'), term('est', 'Estimating')];
  kind: TaxonomyKind = 'category';
  viewAllLabel = 'View all categories';
}

function render(kind: TaxonomyKind, viewAllLabel: string): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.kind = kind;
  fixture.componentInstance.viewAllLabel = viewAllLabel;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('NavFlyoutList', () => {
  it('renders one link per value to the facet browse page (no count text)', () => {
    const root = render('category', 'View all categories');
    const valueLinks = Array.from(root.querySelectorAll('ul a'));
    expect(valueLinks.map((a) => a.getAttribute('href'))).toEqual([
      '/categories/bim',
      '/categories/est',
    ]);
    expect(valueLinks[0]?.textContent?.trim()).toBe('BIM Authoring');
    // No counts surfaced in the flyout.
    expect(root.textContent).not.toMatch(/\d/);
  });

  it('renders the View-all link to the facet index using the localized label', () => {
    const root = render('category', 'View all categories');
    const viewAll = Array.from(root.querySelectorAll('a')).find(
      (a) => a.getAttribute('href') === '/categories',
    );
    expect(viewAll).toBeTruthy();
    expect(viewAll?.textContent?.trim()).toBe('View all categories');
  });

  it.each([
    ['audience', '/audiences/bim', '/audiences'],
    ['phase', '/phases/bim', '/phases'],
  ] as const)('maps kind %s to the correct path segment', (kind, valueHref, indexHref) => {
    const root = render(kind, 'View all');
    expect(root.querySelector(`ul a[href="${valueHref}"]`)).not.toBeNull();
    expect(root.querySelector(`a[href="${indexHref}"]`)).not.toBeNull();
  });
});
