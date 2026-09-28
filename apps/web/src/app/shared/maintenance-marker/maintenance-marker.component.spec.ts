import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MaintenanceMarker } from './maintenance-marker';

@Component({
  imports: [MaintenanceMarker],
  template: `<aec-maintenance-marker [maintainedBy]="by" [reviewedAt]="at" [ownerName]="owner" />`,
})
class Host {
  by: 'aeci' | 'vendor' = 'aeci';
  at: string | null = null;
  owner: string | null = null;
}

const squash = (t: string | null | undefined) => t?.replace(/\s+/g, ' ').trim() ?? '';

function mount(by: 'aeci' | 'vendor', at: string | null, owner: string | null): HTMLElement {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.by = by;
  fixture.componentInstance.at = at;
  fixture.componentInstance.owner = owner;
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** The VISIBLE label: the chip's text with any sr-only span removed. */
function render(
  by: 'aeci' | 'vendor' = 'aeci',
  at: string | null = null,
  owner: string | null = null,
): string {
  const el = mount(by, at, owner).cloneNode(true) as HTMLElement;
  el.querySelectorAll('.sr-only').forEach((n) => n.remove());
  return squash(el.textContent);
}

/** What a screen reader hears: the full text, sr-only suffix included. */
function spoken(
  by: 'aeci' | 'vendor' = 'aeci',
  at: string | null = null,
  owner: string | null = null,
): string {
  return squash(mount(by, at, owner).textContent);
}

describe('MaintenanceMarker', () => {
  // The Stage 1 default and the only reachable state today: AECi maintains every
  // record and no real review timestamp exists yet, so no date clause renders.
  it('attributes the record to AECi with no date by default', () => {
    expect(render()).toBe('AEC Integrations maintained');
  });

  // The load-bearing guarantee. A date must never appear unless something
  // actually supplies a review timestamp; the component must not invent one.
  it('renders no date when reviewedAt is null', () => {
    expect(render('aeci', null)).not.toMatch(/\d{4}/);
    expect(render('vendor', null)).not.toMatch(/\d{4}/);
  });

  it('appends the review date when one is supplied', () => {
    expect(render('aeci', '2026-08-17T03:25:47.160Z')).toBe(
      'AEC Integrations maintained · Reviewed August 17, 2026',
    );
  });

  // Formatting is pinned to UTC so the SSR Worker (UTC) and the browser (any
  // zone) agree; a zone-local format would render two different dates either
  // side of midnight and trip a hydration mismatch.
  it('formats the date in UTC, not the ambient zone', () => {
    // 23:30 UTC is the previous day in every western zone.
    expect(render('aeci', '2026-08-17T23:30:00.000Z')).toContain('August 17, 2026');
  });

  // Stage 2 seam: unreachable until a vendor can attest, but defined so the
  // portal work is a data change rather than a component change.
  it('renders the vendor branch when maintained by a vendor', () => {
    expect(render('vendor')).toBe('Vendor maintained');
    expect(render('vendor', '2026-08-17T03:25:47.160Z')).toBe(
      'Vendor maintained · Updated August 17, 2026',
    );
  });

  // Ruling 2026-09-28 (AECI-1142): exactly two visible labels, everywhere.
  it('never puts a company name in the visible label', () => {
    expect(render('vendor', null, 'Procore Technologies')).toBe('Vendor maintained');
    expect(render('vendor', '2026-08-17T03:25:47.160Z', 'Procore Technologies')).toBe(
      'Vendor maintained · Updated August 17, 2026',
    );
  });

  it('names the owner for screen readers only, on the vendor branch', () => {
    expect(spoken('vendor', null, 'Procore Technologies')).toBe(
      'Vendor maintained: Procore Technologies keeps this up to date',
    );
    expect(spoken('vendor', '2026-08-17T03:25:47.160Z', 'Procore Technologies')).toBe(
      'Vendor maintained: Procore Technologies keeps this up to date · Updated August 17, 2026',
    );
    const el = mount('vendor', null, 'Procore Technologies');
    expect(el.querySelector('.sr-only')?.textContent).toContain('Procore Technologies');
    // No name passed (the pair page): nothing extra is spoken.
    expect(spoken('vendor', null, null)).toBe('Vendor maintained');
    // The AECi branch never borrows the owner's name.
    expect(spoken('aeci', null, 'Procore Technologies')).toBe('AEC Integrations maintained');
  });

  it('drops an unparseable timestamp rather than rendering "Invalid Date"', () => {
    expect(render('aeci', 'not-a-date')).toBe('AEC Integrations maintained');
  });

  // No checkmark, shield, or tick: the marker is attribution, not endorsement.
  it('renders no icon path that could read as a verification mark', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('svg')).toBeNull();
  });
});
