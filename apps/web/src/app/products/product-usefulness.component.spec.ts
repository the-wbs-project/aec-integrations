import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import type { FieldCaption, ProductUsefulness } from '@aeci/shared';

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

function setup(data: ProductUsefulness, caption: FieldCaption | null = null) {
  const fixture = TestBed.createComponent(ProductUsefulnessSection);
  fixture.componentRef.setInput('data', data);
  fixture.componentRef.setInput('productName', 'Bluebeam Revu');
  fixture.componentRef.setInput('caption', caption);
  fixture.componentRef.setInput('page', {
    surface: 'product_detail',
    entityType: 'product',
    entityId: 'p1',
  });
  fixture.detectChanges();
  return fixture;
}

describe('ProductUsefulnessSection', () => {
  // AECI-1614: the caption replaced AECI-1316's "Written by" line.
  describe('caption', () => {
    const caption = (el: HTMLElement) =>
      el.querySelector('[data-testid="field-caption"]')?.textContent?.trim() ?? null;

    it('says who maintains the section and when, at its foot', () => {
      const el = setup(FULL, {
        form: 'updated',
        vendor_names: ['Procore'],
        date: '2026-10-04T00:00:00.000Z',
      }).nativeElement as HTMLElement;
      expect(caption(el)).toBe('Maintained by Procore · updated October 4, 2026');
      const section = el.querySelector('section')!;
      expect(section.lastElementChild?.tagName.toLowerCase()).toBe('aec-field-caption');
    });

    it('takes the until form when the plan ended', () => {
      const el = setup(FULL, {
        form: 'until',
        vendor_names: ['Procore'],
        date: '2026-10-04T00:00:00.000Z',
      }).nativeElement as HTMLElement;
      expect(caption(el)).toBe('Maintained by Procore until October 4, 2026');
    });

    it('carries no line with no vendor write, and no "Written by" ever', () => {
      const el = setup(FULL).nativeElement as HTMLElement;
      expect(caption(el)).toBeNull();
      expect(el.textContent).not.toContain('Written by');
      expect(el.querySelector('[data-testid="usefulness-attribution"]')).toBeNull();
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

  // AECI-1780: one row per facet, each group a card with its own name and points.
  it('renders one row per facet and one card per group, each card holding its own points', () => {
    const el = setup(FULL).nativeElement as HTMLElement;
    const rows = Array.from(el.querySelectorAll('[data-testid="usefulness-row"]'));
    expect(rows.map((r) => r.querySelector('h3')?.textContent?.trim())).toEqual([
      'By audience',
      'By phase',
    ]);
    const cards = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="usefulness-group"]'));
    expect(cards.map((c) => c.tagName)).toEqual(['DL', 'DL', 'DL']);
    expect(cards.every((c) => c.classList.contains('aec-card'))).toBe(true);
    // Each card carries its own group: the first audience card holds both of its points.
    expect(cards[0]!.querySelector('dt')?.textContent?.trim()).toBe('General contractors');
    expect(
      Array.from(cards[0]!.querySelectorAll('li')).map((li) => li.textContent?.trim()),
    ).toEqual(['Track RFIs against the schedule', 'Share submittals with the field']);
    // The phase card sits in the phase row, not under the audience label.
    expect(rows[1]!.querySelector('dt')?.textContent?.trim()).toBe('Construction');
    // Each point leads with a decorative tick.
    for (const li of Array.from(el.querySelectorAll('li'))) {
      expect(li.querySelector('aec-icon')).not.toBeNull();
    }
  });

  it('hides entirely (no section, host hidden) when both facets are empty', () => {
    const el = setup({ audiences: [], phases: [] }).nativeElement as HTMLElement;
    expect(el.querySelector('section')).toBeNull();
    expect(el.hidden).toBe(true);
  });

  it('never gives a facet more card columns than it has cards', () => {
    const el = setup({
      audiences: [
        { slug: 'a', name: 'A', points: ['1'] },
        { slug: 'b', name: 'B', points: ['2'] },
        { slug: 'c', name: 'C', points: ['3'] },
      ],
      phases: [{ slug: 'p', name: 'P', points: ['4'] }],
    }).nativeElement as HTMLElement;
    const [three, one] = Array.from(el.querySelectorAll('[data-testid="usefulness-cards"]'));
    expect(three!.classList.contains('lg:grid-cols-3')).toBe(true);
    expect(one!.className).not.toContain('grid-cols');
    const two = setup({ audiences: FULL.audiences, phases: [] }).nativeElement as HTMLElement;
    const cards = two.querySelector('[data-testid="usefulness-cards"]')!;
    expect(cards.classList.contains('md:grid-cols-2')).toBe(true);
    expect(cards.className).not.toContain('lg:grid-cols-3');
  });

  it('renders only the populated facet row when one facet is empty', () => {
    const el = setup({ audiences: FULL.audiences, phases: [] }).nativeElement as HTMLElement;
    expect(Array.from(el.querySelectorAll('h3')).map((h) => h.textContent?.trim())).toEqual([
      'By audience',
    ]);
    expect(el.querySelectorAll('[data-testid="usefulness-row"]').length).toBe(1);
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

  it('heads the section with the hidden label and "How teams use {product}", and no intro line (AECI-1720)', () => {
    const el = setup(FULL).nativeElement as HTMLElement;
    const h2 = el.querySelector('h2#usefulness-title')!;
    expect(h2.textContent?.trim()).toBe('How teams use Bluebeam Revu');
    const kicker = h2.previousElementSibling!;
    expect(kicker.getAttribute('aria-hidden')).toBe('true');
    expect(kicker.textContent?.trim()).toBe('How teams use it');
    // The mock-up's intro can read as "written by users", which the caption contradicts.
    expect(h2.nextElementSibling).toBeNull();
    expect(el.textContent).not.toContain('by the people who use it');
  });
});
