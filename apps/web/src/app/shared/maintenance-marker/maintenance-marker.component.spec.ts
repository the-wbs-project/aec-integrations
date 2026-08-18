import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';

import { MaintenanceMarker } from './maintenance-marker';

@Component({
  imports: [MaintenanceMarker],
  template: `<aec-maintenance-marker [maintainedBy]="by" [reviewedAt]="at" />`,
})
class Host {
  by: 'aeci' | 'vendor' = 'aeci';
  at: string | null = null;
}

function render(by: 'aeci' | 'vendor' = 'aeci', at: string | null = null): string {
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.by = by;
  fixture.componentInstance.at = at;
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

describe('MaintenanceMarker', () => {
  // The Stage 1 default and the only reachable state today: AECi maintains every
  // record and no real review timestamp exists yet, so no date clause renders.
  it('attributes the record to AECi with no date by default', () => {
    expect(render()).toBe('Maintained by AEC Integrations');
  });

  // The load-bearing guarantee. A date must never appear unless something
  // actually supplies a review timestamp; the component must not invent one.
  it('renders no date when reviewedAt is null', () => {
    expect(render('aeci', null)).not.toMatch(/\d{4}/);
    expect(render('vendor', null)).not.toMatch(/\d{4}/);
  });

  it('appends the review date when one is supplied', () => {
    expect(render('aeci', '2026-08-17T03:25:47.160Z')).toBe(
      'Maintained by AEC Integrations · Reviewed August 17, 2026',
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
    expect(render('vendor')).toBe('Vendor-maintained');
    expect(render('vendor', '2026-08-17T03:25:47.160Z')).toBe(
      'Vendor-maintained · Updated August 17, 2026',
    );
  });

  it('drops an unparseable timestamp rather than rendering "Invalid Date"', () => {
    expect(render('aeci', 'not-a-date')).toBe('Maintained by AEC Integrations');
  });

  // No checkmark, shield, or tick: the marker is attribution, not endorsement.
  it('renders no icon path that could read as a verification mark', () => {
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('svg')).toBeNull();
  });
});
