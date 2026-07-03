/**
 * ClaimProvenance render tests (AECI-300). Named `.component.spec.ts` so it runs
 * under `ng test` (TestBed). Asserts the always-rendered trigger (the popover
 * surface opens on click via CDK overlay and is exercised e2e, not here).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProductPairClaim } from '@aeci/shared';

import { ClaimProvenance } from './claim-provenance';

const claim = (note: string | null): ProductPairClaim => ({
  data_object_slug: 'rfis',
  data_object_name: 'RFIs',
  direction: 'inbound',
  agreement: 'unverified',
  attestations: [
    { source: 'aeci', asserted: true, note, introduced_at: null, deprecated_at: null },
  ],
});

function render(c: ProductPairClaim): HTMLElement {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ClaimProvenance);
  fixture.componentRef.setInput('claim', c);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

describe('ClaimProvenance', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('labels the trigger with the data object name', () => {
    const el = render(claim('Curated by AECi.'));
    const btn = el.querySelector('button');
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute('aria-label')).toContain('Provenance for RFIs');
  });
});
