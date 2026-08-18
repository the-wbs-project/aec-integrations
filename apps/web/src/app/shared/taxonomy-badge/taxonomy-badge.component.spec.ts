import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import { TaxonomyBadge, type TaxonomyKind } from './taxonomy-badge';

@Component({
  imports: [TaxonomyBadge],
  template: `<aec-taxonomy-badge [kind]="kind" [slug]="slug" [name]="name" [count]="count" />`,
})
class TaxonomyBadgeHost {
  kind: TaxonomyKind = 'category';
  slug = 'project-management';
  name = 'Project Management';
  count: number | undefined = undefined;
}

function renderHost(opts: {
  kind: TaxonomyKind;
  slug: string;
  name: string;
  count?: number;
}): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(TaxonomyBadgeHost);
  fixture.componentInstance.kind = opts.kind;
  fixture.componentInstance.slug = opts.slug;
  fixture.componentInstance.name = opts.name;
  fixture.componentInstance.count = opts.count;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('TaxonomyBadge', () => {
  it.each([
    ['category', 'project-management', '/categories/project-management'],
    ['audience', 'structural', '/audiences/structural'],
    ['phase', 'preconstruction', '/phases/preconstruction'],
    ['trade', 'electrical', '/trades/electrical'],
  ] as const)('renders a link to the %s browse page', (kind, slug, expectedHref) => {
    const root = renderHost({ kind, slug, name: 'irrelevant' });
    const link = root.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe(expectedHref);
  });

  it('renders the name as the visible label', () => {
    const root = renderHost({ kind: 'category', slug: 'design', name: 'Design Review' });
    expect(root.querySelector('a')?.textContent?.trim()).toBe('Design Review');
  });

  it('omits the count and aria-label when [count] is not provided', () => {
    const root = renderHost({ kind: 'category', slug: 'design', name: 'Design Review' });
    const link = root.querySelector('a');
    expect(link?.hasAttribute('aria-label')).toBe(false);
    expect(link?.textContent?.trim()).toBe('Design Review');
  });

  it('renders the product count and a clean link accessible name when [count] is provided', () => {
    const root = renderHost({
      kind: 'category',
      slug: 'bim-authoring',
      name: 'BIM Authoring',
      count: 12,
    });
    const link = root.querySelector('a');
    // Visible count numeral is shown (its own span; whitespace is collapsed by Angular).
    expect(link?.textContent).toContain('12');
    // Accessible name is the un-smushed, count-bearing string (visible label is a substring).
    expect(link?.getAttribute('aria-label')).toBe('BIM Authoring 12 products');
  });

  it('renders a zero count (pre-launch) rather than hiding it', () => {
    const root = renderHost({ kind: 'phase', slug: 'design', name: 'Design', count: 0 });
    const link = root.querySelector('a');
    expect(link?.textContent).toContain('0');
    expect(link?.getAttribute('aria-label')).toBe('Design 0 products');
  });
});
