import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it } from 'vitest';

import type { AlgoliaProductRecord } from '@aeci/shared/algolia-records';

import { SearchProductCard } from './search-product-card';

const baseRecord: AlgoliaProductRecord = {
  objectID: '00000000-0000-4000-8000-000000020001',
  name: 'Procore',
  slug: 'procore',
  description: 'Construction management platform.',
  vendor_name: 'Procore Technologies',
  vendor_slug: 'procore-technologies',
  categories: ['Project Management', 'Document Control'],
  audiences: ['Construction Management'],
  phases: ['Construction'],
  trades: [],
  trade_aliases: [],
  name_sort: 'procore', // AECI-825 — replica sort key, never rendered
  integration_count: 12,
  review_count: 3,
  rating_overall_avg: 4.5,
  created_at_ts: 1767225600,
  updated_at_ts: 1767225600,
  logo_url: null,
  product_role: 'application',
};

@Component({
  imports: [SearchProductCard],
  template: `<aec-search-product-card [record]="record()" />`,
})
class Host {
  record = signal<AlgoliaProductRecord>(baseRecord);
}

function setup(initial: AlgoliaProductRecord = baseRecord) {
  TestBed.configureTestingModule({ providers: [provideRouter([])] });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.record.set(initial);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('SearchProductCard', () => {
  // AECI-1769: the Algolia record carries `logo_url: null` for an unclaimed product
  // (AECI-1618), so the hit shows the initial tile. A claimed product's logo shows.
  it('shows the initial tile for an unclaimed hit and the logo for a claimed one', () => {
    const unclaimed = setup({ ...baseRecord, logo_url: null });
    expect(unclaimed.querySelector('aec-logo-or-initial img')).toBeNull();
    expect(unclaimed.querySelector('aec-logo-or-initial span[aria-hidden]')).not.toBeNull();
    TestBed.resetTestingModule();
    const claimed = setup({ ...baseRecord, logo_url: 'https://cdn.example.com/p.png' });
    expect(claimed.querySelector('aec-logo-or-initial img')?.getAttribute('src')).toBe(
      'https://cdn.example.com/p.png',
    );
  });

  it('links the whole card to /products/:slug', () => {
    const el = setup();
    const link = el.querySelector('a[href="/products/procore"]');
    expect(link?.textContent).toContain('Procore');
  });

  it('shows the vendor name and the integration badge', () => {
    const el = setup();
    expect(el.textContent).toContain('Procore Technologies');
    expect(el.textContent).toContain('12');
    expect(el.textContent).toContain('integrations');
  });

  it('says "Independent" when vendor_name is null, as the /products tile does', () => {
    const el = setup({ ...baseRecord, vendor_name: null });
    expect(el.textContent).not.toContain('Procore Technologies');
    expect(el.textContent).toContain('Independent');
  });

  it('carries only the /products tile fields: no description, no taxonomy chips', () => {
    const el = setup({ ...baseRecord, trades: ['Roofing'] });
    expect(el.textContent).not.toContain('Construction management platform.');
    expect(el.textContent).not.toContain('Project Management');
    expect(el.textContent).not.toContain('Roofing');
    expect(el.querySelectorAll('li')).toHaveLength(0);
  });

  // AECI-1086 — the /products tile's role chip, on the search card too.
  it('shows the Connector chip for a connector-role product', () => {
    const el = setup({ ...baseRecord, product_role: 'connector' });
    expect(el.querySelector('aec-role-badge')?.textContent?.trim()).toBe('Connector');
  });

  it('shows the Hybrid chip for a hybrid-role product', () => {
    const el = setup({ ...baseRecord, product_role: 'hybrid' });
    expect(el.querySelector('aec-role-badge')?.textContent?.trim()).toBe('Hybrid');
  });

  it('renders no chip row for an application', () => {
    const el = setup();
    expect(el.querySelector('aec-role-badge')).toBeNull();
  });

  it('renders no chip row for a record indexed before the field existed', () => {
    const { product_role: _role, ...stale } = baseRecord;
    const el = setup(stale as AlgoliaProductRecord);
    expect(el.querySelector('aec-role-badge')).toBeNull();
  });

  it('uses the singular noun for one integration', () => {
    const el = setup({ ...baseRecord, integration_count: 1 });
    expect(el.textContent).toMatch(/1\s*integration(?!s)/);
  });
});

describe('SearchProductCard surface (AECI-1765)', () => {
  it('is a lifting card in a static hover host, with the link on the product name alone', () => {
    const el = setup();
    const host = el.querySelector('aec-search-product-card')!;
    expect(host.classList.contains('group/card')).toBe(true);
    const card = el.querySelector('div')!;
    expect(card.classList.contains('shadow-card')).toBe(true);
    expect(card.classList.contains('rounded-card')).toBe(true);
    expect(card.classList.contains('motion-safe:group-hover/card:-translate-y-1')).toBe(true);
    const link = el.querySelector('a')!;
    expect(link.textContent?.trim()).toBe(baseRecord.name);
    expect(link.hasAttribute('aria-label')).toBe(false);
    expect(link.classList.contains('after:inset-0')).toBe(true);
    // The vendor and the integration count are text outside the link name.
    expect(card.textContent).toContain('12');
    expect(card.textContent).toContain('Procore Technologies');
    expect(link.textContent).not.toContain('Procore Technologies');
    const title = el.querySelector('p')!;
    expect(title.classList.contains('text-t-20')).toBe(true);
    expect(title.classList.contains('leading-tight')).toBe(true);
  });
});
