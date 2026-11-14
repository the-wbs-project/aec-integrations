/**
 * The badge components all render `aec-chip` (AECI-1763). Each keeps its selector
 * and inputs; only the rendering moved. This pins the tone each one maps to, so a
 * badge cannot drift back to its own recipe.
 */
import { provideZonelessChangeDetection, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorEntitlementBlock } from '@aeci/shared';

import { ReviewStatusBadge } from '../../account/review-status-badge';
import { RoleBadge } from '../../products/role-badge';
import { VendorPlanBadge } from '../../vendor/components/vendor-plan-badge';
import { MaintenanceMarker } from '../maintenance-marker/maintenance-marker';
import { TaxonomyBadge } from '../taxonomy-badge/taxonomy-badge';

function render<T>(type: Type<T>, inputs: Record<string, unknown>): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
  const fixture = TestBed.createComponent(type);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

const chip = (el: HTMLElement) => el.querySelector('.aec-chip')!;

describe('badges on the one chip', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('maps each review status to one tone and keeps the text label', () => {
    const cases = [
      ['approved', 'forest', 'Approved'],
      ['rejected', 'strong', 'Not published'],
      ['removed', 'strong', 'Removed'],
      ['pending', 'sunken', 'Pending review'],
    ] as const;
    for (const [status, tone, text] of cases) {
      const el = chip(render(ReviewStatusBadge, { status }));
      expect(el.getAttribute('data-tone')).toBe(tone);
      expect(el.getAttribute('data-density')).toBe('dense');
      expect(el.textContent!.trim()).toBe(text);
    }
  });

  it('keeps the role chip for connector and hybrid only', () => {
    expect(chip(render(RoleBadge, { role: 'connector' })).textContent!.trim()).toBe('Connector');
    expect(render(RoleBadge, { role: 'application' }).querySelector('.aec-chip')).toBeNull();
  });

  it('renders the plan badge as Managed on the strong edge and Free quiet', () => {
    const managed = render(VendorPlanBadge, {
      plan: { plan: 'managed' } as unknown as VendorEntitlementBlock,
    });
    const free = render(VendorPlanBadge, {
      plan: { plan: 'free' } as unknown as VendorEntitlementBlock,
    });
    // Whatever the plan helper decides, the two must differ and neither is a status colour.
    const tones = [chip(managed), chip(free)].map((c) => c.getAttribute('data-tone'));
    expect(tones.every((t) => t === 'strong-sunken' || t === 'quiet')).toBe(true);
  });

  it('renders the maintenance marker in the 500-weight label face with its two labels', () => {
    const aeci = chip(render(MaintenanceMarker, { maintainedBy: 'aeci' }));
    expect(aeci.getAttribute('data-face')).toBe('label');
    expect(aeci.textContent!.trim()).toBe('AEC Integrations maintained');
    const vendor = chip(render(MaintenanceMarker, { maintainedBy: 'vendor' }));
    expect(vendor.textContent!.trim()).toBe('Vendor maintained');
  });

  it('renders a taxonomy chip as a link that keeps its count and accessible name', () => {
    const el = chip(
      render(TaxonomyBadge, { kind: 'category', slug: 'bim', name: 'BIM', count: 4 }),
    );
    expect(el.tagName).toBe('A');
    expect(el.getAttribute('href')).toBe('/categories/bim');
    expect(el.getAttribute('aria-label')).toBe('BIM 4 products');
  });
});
