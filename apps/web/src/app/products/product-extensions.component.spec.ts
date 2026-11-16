/**
 * `ProductBuiltWithin` / `ProductExtensionsSection` — the §13.3b extension
 * relation (AECI-710). Named `.component.spec.ts` so it runs under `ng test`.
 *
 * Placement on the page, the section nav and the "never an integration" rule are
 * asserted at page level in `product-detail.component.spec.ts`. This file covers
 * what each component renders on its own.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductListItem } from '@aeci/shared';

import { ProductBuiltWithin, ProductExtensionsSection } from './product-extensions';

function item(slug: string, name: string, vendorName: string | null = null): ProductListItem {
  return {
    id: 'p-' + slug,
    slug,
    name,
    logo_url: null,
    product_role: 'application',
    vendor: vendorName
      ? { id: 'v-' + slug, slug: 'v-' + slug, name: vendorName, logo_url: null }
      : null,
    integration_count: 0,
    review_count: 0,
    rating_overall_avg: null,
    rating_onboarding_avg: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

@Component({
  imports: [ProductBuiltWithin, ProductExtensionsSection],
  template: `
    <section
      aec-product-built-within
      aria-labelledby="built-within-title"
      [hosts]="hosts()"
    ></section>
    <section
      aec-product-extensions-section
      id="extensions"
      aria-labelledby="extensions-title"
      productName="Autodesk Revit"
      [extensions]="extensions()"
    ></section>
  `,
})
class Host {
  hosts = signal<readonly ProductListItem[]>([]);
  extensions = signal<readonly ProductListItem[]>([]);
}

function setup(hosts: ProductListItem[], extensions: ProductListItem[]) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.hosts.set(hosts);
  fixture.componentInstance.extensions.set(extensions);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ProductBuiltWithin', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('names the relation and links each host to its product page', () => {
    const el = setup([item('autodesk-revit', 'Autodesk Revit', 'Autodesk')], []);
    const section = el.querySelector('section[aec-product-built-within]')!;

    expect(section.querySelector('h2#built-within-title')!.textContent!.trim()).toBe(
      'Built within',
    );
    const links = [...section.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['/products/autodesk-revit']);
    expect(links[0]!.textContent).toContain('Autodesk Revit');
    expect(links[0]!.textContent).toContain('Autodesk');
  });

  it('renders one card per host, and omits the vendor line when there is no vendor', () => {
    const el = setup([item('forma', 'Forma'), item('revit', 'Revit', 'Autodesk')], []);
    const cards = el.querySelectorAll('section[aec-product-built-within] li');

    expect(cards).toHaveLength(2);
    expect(cards[0]!.querySelectorAll('a > span > span')).toHaveLength(1);
    expect(cards[1]!.querySelectorAll('a > span > span')).toHaveLength(2);
  });
});

describe('ProductExtensionsSection', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const EXTENSIONS = [item('augmenta', 'Augmenta', 'Augmenta Inc.'), item('ideatura', 'ideatura')];

  it('heads the section with the host name and carries no count', () => {
    const el = setup([], EXTENSIONS);
    const heading = el.querySelector('#extensions h2#extensions-title')!.textContent!.trim();

    expect(heading).toBe('Extensions built within Autodesk Revit');
    // Never "(2)": the page must not show a second count that reads like the
    // Integrations one (§13.3b).
    expect(heading).not.toMatch(/\d/);
  });

  it('says in plain words that these run inside the host, not connect to it', () => {
    const el = setup([], EXTENSIONS);
    const lead = el.querySelector('#extensions p')!.textContent!;

    expect(lead).toContain('run inside Autodesk Revit');
    expect(lead).toContain('rather than connecting to it');
  });

  it('renders a tile per extension in the given order, linking each product page', () => {
    const el = setup([], EXTENSIONS);
    const links = [...el.querySelectorAll<HTMLAnchorElement>('#extensions li a')];

    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/products/augmenta',
      '/products/ideatura',
    ]);
    expect(links[0]!.textContent).toContain('Augmenta Inc.');
  });

  it('draws each tile as the shared card, which is itself the link (ruling 35)', () => {
    const el = setup([], EXTENSIONS);
    const items = [...el.querySelectorAll<HTMLLIElement>('#extensions ul > li')];

    for (const li of items) {
      // The lift's hover state sits on the static wrapper (card.ts, THE REQUIRED WRAPPER).
      expect(li.classList).toContain('group/card');
      const a = li.querySelector<HTMLAnchorElement>(':scope > a')!;
      expect(a.classList).toContain('aec-card');
      expect(a.classList).toContain('shadow-card');
      expect(a.classList).toContain('rounded-card');
      // The old surface wash is gone: a tile is never a different fill from its siblings.
      expect(a.className).not.toContain('surface-sunken');
      // The logo rule: a tile mark is the 32px size, whatever the claim.
      expect(li.querySelector('aec-logo-or-initial .h-8.w-8')).not.toBeNull();
      expect(li.querySelector('aec-logo-or-initial .h-16')).toBeNull();
    }
  });

  it.each([
    [1, '1'],
    [2, '2'],
    [3, '3'],
    [5, '3'],
  ])('lays %i tiles on the shared card grid with data-columns=%s', (n, columns) => {
    const list = Array.from({ length: n }, (_, i) => item('ext-' + i, 'Extension ' + i));
    const el = setup([], list);
    const ul = el.querySelector('#extensions ul')!;

    expect(ul.classList).toContain('aec-card-grid');
    expect(ul.getAttribute('data-columns')).toBe(columns);
    expect(ul.querySelectorAll(':scope > li')).toHaveLength(n);
  });

  it('is a list of tiles, never a table: an extension is not an integration row', () => {
    const el = setup([], EXTENSIONS);

    expect(el.querySelector('#extensions table')).toBeNull();
    expect(el.querySelector('#extensions tr')).toBeNull();
    expect(el.querySelectorAll('#extensions ul > li')).toHaveLength(2);
  });
});
