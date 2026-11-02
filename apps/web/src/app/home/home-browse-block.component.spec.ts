import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { HomeBrowseBlock } from './home-browse-block';

function term(slug: string, name: string, product_count: number): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: 0, product_count };
}

function setup(
  inputs: {
    categories?: TaxonomyTermWithCount[];
    trades?: TaxonomyTermWithCount[];
    phases?: TaxonomyTermWithCount[];
    audiences?: TaxonomyTermWithCount[];
  } = {},
): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(HomeBrowseBlock);
  for (const [key, value] of Object.entries(inputs)) fixture.componentRef.setInput(key, value);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The nine curated roles and the audience page each links to, in editorial order. */
const EXPECTED_ROLES: ReadonlyArray<readonly [string, string]> = [
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

describe('HomeBrowseBlock', () => {
  it('is one section with the "Browse the directory" h2, labelled by it', () => {
    const root = setup();
    const section = root.querySelector('section');
    const h2s = root.querySelectorAll('h2');
    expect(h2s).toHaveLength(1);
    expect(h2s[0]?.textContent?.trim()).toBe('Browse the directory');
    expect(section?.getAttribute('aria-labelledby')).toBe(h2s[0]?.id);
  });

  it('renders four labelled rows in order: category, trade, project phase, audience', () => {
    const labels = Array.from(setup().querySelectorAll('h3')).map((h) => h.textContent?.trim());
    expect(labels).toEqual(['Category', 'Trade', 'Project phase', 'Audience']);
  });

  it('renders the trade terms it is given, linking to /trades/:slug, in the order given', () => {
    const root = setup({
      trades: [term('electrical', 'Electrical', 5), term('concrete', 'Concrete', 2)],
    });
    const trades = Array.from(root.querySelectorAll('ul a[href^="/trades/"]'));
    expect(trades.map((a) => a.getAttribute('href'))).toEqual([
      '/trades/electrical',
      '/trades/concrete',
    ]);
  });

  it('renders the category and phase terms it is given, in the order given', () => {
    const root = setup({
      categories: [term('bim', 'BIM', 7), term('estimating', 'Estimating', 3)],
      phases: [term('design', 'Design', 4), term('construction', 'Construction', 2)],
    });
    const cats = Array.from(root.querySelectorAll('ul a[href^="/categories/"]'));
    expect(cats.map((a) => a.getAttribute('href'))).toEqual([
      '/categories/bim',
      '/categories/estimating',
    ]);
    const phases = Array.from(root.querySelectorAll('ul a[href^="/phases/"]'));
    expect(phases.map((a) => a.getAttribute('href'))).toEqual([
      '/phases/design',
      '/phases/construction',
    ]);
  });

  it('links each of the nine curated roles to its audience page, in editorial order', () => {
    const chips = Array.from(setup().querySelectorAll('ul a[href^="/audiences/"]'));
    expect(chips.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual(
      EXPECTED_ROLES,
    );
  });

  it('drops "Technology directors", which has no taxonomy term', () => {
    expect(setup().textContent).not.toContain('Technology directors');
  });

  it('shows a role count from the live taxonomy only when it is above zero', () => {
    const root = setup({
      audiences: [term('architecture', 'Architecture', 14), term('estimator', 'Estimator', 0)],
    });
    const architects = root.querySelector('a[href="/audiences/architecture"]');
    expect(architects?.textContent).toContain('14');
    expect(architects?.getAttribute('aria-label')).toBe('Architects 14 products');
    const estimators = root.querySelector('a[href="/audiences/estimator"]');
    expect(estimators?.textContent?.trim()).toBe('Estimators');
  });

  it('carries the audience lede and the four "View all" links', () => {
    const root = setup();
    expect(root.textContent).toContain('justifying a decision to a steering committee');
    for (const href of ['/categories', '/trades', '/phases', '/audiences']) {
      expect(root.querySelectorAll(`a[href="${href}"]`)).toHaveLength(1);
    }
  });

  it('paints no ground of its own and no Bone or Clay accents', () => {
    const root = setup();
    expect(root.querySelector('[class*="--accent-warm"]')).toBeNull();
    expect(root.querySelector('[class*="--accent-secondary"]')).toBeNull();
    expect(root.querySelector('[class*="--accent-primary-soft"]')).toBeNull();
  });
});
