import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { HomeCredibilityStrip } from './home-credibility-strip';

type Inputs = {
  totalProducts: number;
  totalVendors: number;
  totalIntegrations: number;
  totalReviews: number;
  totalContributingFirms: number;
};

const DEFAULTS: Inputs = {
  totalProducts: 43,
  totalVendors: 33,
  totalIntegrations: 90,
  totalReviews: 12,
  totalContributingFirms: 8,
};

const ALL_ZERO: Inputs = {
  totalProducts: 0,
  totalVendors: 0,
  totalIntegrations: 0,
  totalReviews: 0,
  totalContributingFirms: 0,
};

function setup(overrides: Partial<Inputs> = {}) {
  const inputs = { ...DEFAULTS, ...overrides };
  // Reset first so a single test can build the component more than once.
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(HomeCredibilityStrip);
  fixture.componentRef.setInput('totalProducts', inputs.totalProducts);
  fixture.componentRef.setInput('totalVendors', inputs.totalVendors);
  fixture.componentRef.setInput('totalIntegrations', inputs.totalIntegrations);
  fixture.componentRef.setInput('totalReviews', inputs.totalReviews);
  fixture.componentRef.setInput('totalContributingFirms', inputs.totalContributingFirms);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** Visible count items live in the <ul>; the independence marker is outside it. */
function metricLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('li')].map(
    (li) => li.textContent?.replace(/\s+/g, ' ').trim() ?? '',
  );
}

describe('HomeCredibilityStrip', () => {
  it('renders every non-zero coverage count with a pluralized noun, in order', () => {
    const labels = metricLabels(setup());
    expect(labels).toEqual([
      '43 products',
      '33 vendors',
      '90 integrations',
      '12 reviews',
      '8 contributing firms',
    ]);
  });

  it('always renders the static independence marker', () => {
    const el = setup();
    expect(el.textContent).toContain('Independent · no pay-for-placement');
    // It survives even when every count is suppressed (sparse cache).
    const empty = setup(ALL_ZERO);
    expect(empty.textContent).toContain('Independent · no pay-for-placement');
  });

  it('suppresses a metric at 0 rather than showing a bare zero', () => {
    const el = setup({ totalVendors: 0 });
    const labels = metricLabels(el);
    expect(labels).toEqual([
      '43 products',
      '90 integrations',
      '12 reviews',
      '8 contributing firms',
    ]);
    expect(el.textContent).not.toContain('0 vendors');
  });

  it('keeps reviews hidden until meaningful (no "0 reviews")', () => {
    const el = setup({ totalReviews: 0 });
    expect(metricLabels(el).some((l) => l.includes('review'))).toBe(false);
    expect(el.textContent).not.toContain('0 reviews');
  });

  it('keeps contributing firms hidden until meaningful (no "0 contributing firms")', () => {
    const el = setup({ totalContributingFirms: 0 });
    expect(metricLabels(el).some((l) => l.includes('firm'))).toBe(false);
    expect(el.textContent).not.toContain('0 contributing firms');
  });

  it('collapses to a single honest empty-state line when every count is 0', () => {
    const el = setup(ALL_ZERO);
    expect(el.querySelector('ul')).toBeNull();
    expect(el.querySelectorAll('li')).toHaveLength(0);
    expect(el.textContent).toContain('Indexing in progress');
  });

  it('uses the singular noun for a count of 1', () => {
    const labels = metricLabels(
      setup({ totalProducts: 1, totalReviews: 1, totalContributingFirms: 1 }),
    );
    expect(labels).toContain('1 product');
    expect(labels).toContain('1 review');
    expect(labels).toContain('1 contributing firm');
    expect(labels).not.toContain('1 products');
    expect(labels).not.toContain('1 contributing firms');
  });

  it('exposes the strip as a labelled region', () => {
    const el = setup();
    const section = el.querySelector('section');
    expect(section?.getAttribute('aria-label')).toBeTruthy();
  });
});
