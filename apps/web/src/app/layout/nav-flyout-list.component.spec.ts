import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

import { NavFlyoutList } from './nav-flyout-list';

function term(slug: string, name: string): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count: 0 };
}

@Component({
  imports: [NavFlyoutList],
  template: `<aec-nav-flyout-list
    [items]="items"
    [kind]="kind"
    [viewAllLabel]="viewAllLabel"
    (navigate)="navCount = navCount + 1"
  />`,
})
class Host {
  items: TaxonomyTermWithCount[] = [term('bim', 'BIM Authoring'), term('est', 'Estimating')];
  kind: TaxonomyKind = 'category';
  viewAllLabel = 'View all categories';
  navCount = 0;
}

function setup(kind: TaxonomyKind, viewAllLabel: string) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.kind = kind;
  fixture.componentInstance.viewAllLabel = viewAllLabel;
  fixture.detectChanges();
  return fixture;
}

function render(kind: TaxonomyKind, viewAllLabel: string): HTMLElement {
  return setup(kind, viewAllLabel).nativeElement as HTMLElement;
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

  it('emits (navigate) when a value or the View-all link is activated', () => {
    const fixture = setup('category', 'View all categories');
    // The links are real RouterLinks; stub navigation so clicking them only
    // exercises the (navigate) output (no unmatched-route rejection on teardown).
    vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    const root = fixture.nativeElement as HTMLElement;

    root.querySelector<HTMLAnchorElement>('ul a[href="/categories/bim"]')!.click();
    expect(fixture.componentInstance.navCount).toBe(1);

    root.querySelector<HTMLAnchorElement>('a[href="/categories"]')!.click();
    expect(fixture.componentInstance.navCount).toBe(2);
  });
});
