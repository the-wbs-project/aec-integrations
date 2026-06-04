import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { TaxonomyBadge, type TaxonomyKind } from './taxonomy-badge';

@Component({
  imports: [TaxonomyBadge],
  template: `<aec-taxonomy-badge [kind]="kind" [slug]="slug" [name]="name" />`,
})
class TaxonomyBadgeHost {
  kind: TaxonomyKind = 'category';
  slug = 'project-management';
  name = 'Project Management';
}

function renderHost(kind: TaxonomyKind, slug: string, name: string) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(TaxonomyBadgeHost);
  fixture.componentInstance.kind = kind;
  fixture.componentInstance.slug = slug;
  fixture.componentInstance.name = name;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('TaxonomyBadge', () => {
  it.each([
    ['category', 'project-management', '/categories/project-management'],
    ['discipline', 'structural', '/disciplines/structural'],
    ['phase', 'preconstruction', '/phases/preconstruction'],
  ] as const)('renders a link to the %s browse page', (kind, slug, expectedHref) => {
    const root = renderHost(kind, slug, 'irrelevant');
    const link = root.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(expectedHref);
  });

  it('renders the name as the visible label', () => {
    const root = renderHost('category', 'design', 'Design Review');
    expect(root.querySelector('a')?.textContent?.trim()).toBe('Design Review');
  });
});
