import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { HomeAudience } from './home-audience';

function term(slug: string, name: string, product_count: number): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count };
}

function setup(audiences: TaxonomyTermWithCount[] = []): HTMLElement {
  // Reset first so a single test can build the component more than once.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HomeAudience);
  fixture.componentRef.setInput('audiences', audiences);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The ten curated recognition roles, in the landing's editorial order. */
const EXPECTED_LABELS = [
  'Architects',
  'Structural engineers',
  'MEP engineers',
  'General contractors',
  'Estimators',
  'Project managers',
  'Owners & developers',
  'Subcontractors',
  'Facilities managers',
  'Technology directors',
];

/** The nine roles that map to an audience term → `/audiences/:slug`. */
const EXPECTED_LINKS: ReadonlyArray<readonly [string, string]> = [
  ['Architects', '/audiences/architecture'],
  ['Structural engineers', '/audiences/structural-engineering'],
  ['MEP engineers', '/audiences/mep-engineering'],
  ['General contractors', '/audiences/general-contracting'],
  ['Estimators', '/audiences/estimator'],
  ['Project managers', '/audiences/project-manager'],
  ['Owners & developers', '/audiences/owner-developer'],
  ['Subcontractors', '/audiences/specialty-contracting'],
  ['Facilities managers', '/audiences/facilities-management'],
];

function roleItems(el: HTMLElement): string[] {
  return [...el.querySelectorAll('ul li')].map(
    (li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

describe('HomeAudience', () => {
  it('renders all ten recognition roles, in editorial order', () => {
    // With no taxonomy counts, each chip's text is just its recognition label.
    expect(roleItems(setup())).toEqual(EXPECTED_LABELS);
  });

  it('links the nine mapped roles to their /audiences/:slug browse page', () => {
    const el = setup();
    for (const [label, href] of EXPECTED_LINKS) {
      const link = el.querySelector(`ul a[href="${href}"]`);
      expect(link, `${label} should link to ${href}`).not.toBeNull();
      expect(link?.textContent).toContain(label);
    }
    // Exactly nine chip links (the view-all link is `/audiences`, not `/audiences/...`).
    expect(el.querySelectorAll('ul a[href^="/audiences/"]')).toHaveLength(9);
  });

  it('renders a non-mapping role (Technology directors) as plain text, never a dead link', () => {
    const el = setup();
    const plain = [...el.querySelectorAll('ul li')].find((li) =>
      li.textContent?.includes('Technology directors'),
    );
    expect(plain).toBeTruthy();
    expect(plain?.querySelector('a')).toBeNull();
    // And no link anywhere announces the non-mapping role.
    const links = [...el.querySelectorAll('a')];
    expect(links.some((a) => a.textContent?.includes('Technology directors'))).toBe(false);
  });

  it('shows the live product count on a mapped chip when it is > 0', () => {
    const el = setup([term('architecture', 'Architecture', 7)]);
    const chip = el.querySelector('ul a[href="/audiences/architecture"]');
    expect(chip?.textContent).toContain('7');
    // Accessible name uses the recognition label + count, not the taxonomy name.
    expect(chip?.getAttribute('aria-label')).toBe('Architects 7 products');
  });

  it('suppresses the count at 0 or when the term is not in the taxonomy (no bare "0")', () => {
    const el = setup([term('estimator', 'Estimator', 0)]);
    const chip = el.querySelector('ul a[href="/audiences/estimator"]');
    expect(chip?.textContent?.trim()).toBe('Estimators');
    expect(chip?.textContent).not.toContain('0');
    // count omitted → TaxonomyBadge drops the explicit aria-label.
    expect(chip?.getAttribute('aria-label')).toBeNull();
  });

  it('renders every role with no counts when the taxonomy input is empty (null-resolver path)', () => {
    const el = setup([]);
    expect(roleItems(el)).toEqual(EXPECTED_LABELS);
    expect(el.querySelectorAll('ul a[href^="/audiences/"]')).toHaveLength(9);
    expect(el.textContent).not.toMatch(/\d/); // no stray counts
  });

  it('uses a single h2 (valid heading order) labelling the section', () => {
    const el = setup();
    expect(el.querySelectorAll('h1, h3, h4, h5, h6')).toHaveLength(0);
    const h2 = el.querySelector('h2');
    expect(h2?.textContent?.trim()).toBe('Built for the people who choose and use AEC software');
    expect(el.querySelector('section')?.getAttribute('aria-labelledby')).toBe(
      'home-audience-heading',
    );
    expect(h2?.id).toBe('home-audience-heading');
  });

  it('marks the decorative eyebrow dot aria-hidden', () => {
    const el = setup();
    expect(el.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it('keeps a "View all audiences" link to the audience index', () => {
    const el = setup();
    const viewAll = el.querySelector('a[href="/audiences"]');
    expect(viewAll).not.toBeNull();
    expect(viewAll?.textContent?.trim()).toBe('View all audiences');
  });
});
