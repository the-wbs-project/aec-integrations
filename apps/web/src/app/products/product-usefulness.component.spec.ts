import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { ProductUsefulness } from '@aeci/shared';

import { ProductUsefulnessSection } from './product-usefulness';

/**
 * AECI-170 — `ProductUsefulnessSection` ("How teams use it"). Named
 * `*.component.spec.ts` so it runs under `ng test` (Angular TestBed) and is
 * excluded from the plain Vitest pass. The component has no router dependency,
 * so it's created directly with `componentRef.setInput`.
 */
const FULL: ProductUsefulness = {
  audiences: [
    {
      slug: 'general-contracting',
      name: 'General contractors',
      points: ['Track RFIs against the schedule', 'Share submittals with the field'],
    },
    { slug: 'owners', name: 'Owners', points: ['See budget burn-down in real time'] },
  ],
  phases: [
    { slug: 'construction', name: 'Construction', points: ['Daily logs sync to the office'] },
  ],
};

function setup(
  data: ProductUsefulness,
  attribution: { source?: 'vendor' | 'admin' | null; vendorName?: string | null } = {},
) {
  const fixture = TestBed.createComponent(ProductUsefulnessSection);
  fixture.componentRef.setInput('data', data);
  if (attribution.source !== undefined) fixture.componentRef.setInput('source', attribution.source);
  if (attribution.vendorName !== undefined)
    fixture.componentRef.setInput('vendorName', attribution.vendorName);
  fixture.detectChanges();
  return fixture;
}

describe('ProductUsefulnessSection', () => {
  // AECI-1316: vendor-written copy is labelled; AECi's own copy is not.
  describe('attribution', () => {
    const attribution = (el: HTMLElement) =>
      el.querySelector('[data-testid="usefulness-attribution"]')?.textContent?.trim() ?? null;

    it('says "Written by {vendor}" when the vendor wrote the section', () => {
      const el = setup(FULL, { source: 'vendor', vendorName: 'Procore' }).nativeElement;
      expect(attribution(el)).toBe('Written by Procore');
    });

    it('falls back to "Written by the vendor" when the product has no vendor name', () => {
      const el = setup(FULL, { source: 'vendor', vendorName: null }).nativeElement;
      expect(attribution(el)).toBe('Written by the vendor');
    });

    it('carries no label on AECi copy (source null)', () => {
      const el = setup(FULL, { source: null, vendorName: 'Procore' }).nativeElement;
      expect(attribution(el)).toBeNull();
    });

    it('carries no label by default', () => {
      expect(attribution(setup(FULL).nativeElement)).toBeNull();
    });
  });

  it('renders both columns with every group name and point when both facets are populated', () => {
    const el = setup(FULL).nativeElement as HTMLElement;

    expect(Array.from(el.querySelectorAll('h3')).map((h) => h.textContent?.trim())).toEqual([
      'By audience',
      'By phase',
    ]);
    expect(Array.from(el.querySelectorAll('dt')).map((d) => d.textContent?.trim())).toEqual([
      'General contractors',
      'Owners',
      'Construction',
    ]);
    expect(Array.from(el.querySelectorAll('li')).map((li) => li.textContent?.trim())).toEqual([
      'Track RFIs against the schedule',
      'Share submittals with the field',
      'See budget burn-down in real time',
      'Daily logs sync to the office',
    ]);
  });

  it('uses the two-column grid only when both facets are populated', () => {
    const el = setup(FULL).nativeElement as HTMLElement;
    expect(el.querySelector('.grid')?.classList.contains('md:grid-cols-2')).toBe(true);
  });

  it('hides entirely (no section, host hidden) when both facets are empty', () => {
    const el = setup({ audiences: [], phases: [] }).nativeElement as HTMLElement;
    expect(el.querySelector('section')).toBeNull();
    expect(el.hidden).toBe(true);
  });

  it('collapses to a single column when only one facet is populated', () => {
    const el = setup({ audiences: FULL.audiences, phases: [] }).nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('h3')).map((h) => h.textContent?.trim())).toEqual([
      'By audience',
    ]);
    expect(el.querySelector('.grid')?.classList.contains('md:grid-cols-2')).toBe(false);
  });

  it('drops groups that have no points', () => {
    const el = setup({
      audiences: [
        { slug: 'a', name: 'Has points', points: ['Keep me'] },
        { slug: 'b', name: 'Empty group', points: [] },
      ],
      phases: [],
    }).nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('dt')).map((d) => d.textContent?.trim())).toEqual([
      'Has points',
    ]);
  });

  it('keeps heading order h2 then h3 (axe heading-order)', () => {
    const el = setup(FULL).nativeElement as HTMLElement;
    const tags = Array.from(el.querySelectorAll('h2, h3')).map((h) => h.tagName);
    expect(tags[0]).toBe('H2');
    expect(tags.slice(1).every((t) => t === 'H3')).toBe(true);
  });
});
