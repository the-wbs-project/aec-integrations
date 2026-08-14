/**
 * ClaimProvenance render tests (AECI-300; state-aware copy from AECI-605).
 * Named `.component.spec.ts` so it runs under `ng test` (TestBed).
 *
 * The popover body lives in an `ng-template` and is projected into a CDK
 * overlay on `document.body`, so the assertions below click the trigger and
 * then query the **document**, not the component host.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgreementState, PairClaimAttestation, ProductPairClaim } from '@aeci/shared';

import { ClaimProvenance } from './claim-provenance';

const att = (
  attestor: PairClaimAttestation['attestor'],
  asserted: boolean,
  note: string | null = null,
): PairClaimAttestation => ({
  source: attestor === 'aeci' ? 'aeci' : attestor === 'context' ? 'vendor_a' : 'vendor_b',
  attestor,
  asserted,
  note,
  introduced_at: null,
  deprecated_at: null,
});

const claim = (
  agreement: AgreementState,
  attestations: PairClaimAttestation[],
): ProductPairClaim => ({
  data_object_slug: 'rfis',
  data_object_name: 'RFIs',
  direction: 'inbound',
  agreement,
  attestations,
});

/** Render, click the trigger, and return the opened popover's text. */
function open(
  c: ProductPairClaim,
  vendors: { context?: string | null; other?: string | null } = {},
): { host: HTMLElement; popoverText: string } {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ClaimProvenance);
  fixture.componentRef.setInput('claim', c);
  fixture.componentRef.setInput('contextVendorName', vendors.context ?? null);
  fixture.componentRef.setInput('otherVendorName', vendors.other ?? null);
  fixture.detectChanges();
  const host = fixture.nativeElement as HTMLElement;
  host.querySelector('button')!.click();
  fixture.detectChanges();
  return { host, popoverText: document.body.textContent ?? '' };
}

describe('ClaimProvenance', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
  });

  it('labels the trigger with the data object name', () => {
    const { host } = open(claim('unverified', [att('aeci', true)]));
    const btn = host.querySelector('button');
    expect(btn).toBeTruthy();
    expect(btn?.getAttribute('aria-label')).toContain('Provenance for RFIs');
  });

  it('attributes the AECi seed and keeps the Stage 1.5 closing line', () => {
    const { popoverText } = open(claim('unverified', [att('aeci', true, 'Curated by AECi.')]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('AECi');
    expect(popoverText).toContain('asserts this flow');
    expect(popoverText).toContain('Curated by AECi.');
    expect(popoverText).toContain('Vendor confirmation is not available yet');
  });

  it('names each vendor by its context-relative attestor', () => {
    const { popoverText } = open(claim('conflict', [att('context', true), att('other', false)]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('Acme Software');
    expect(popoverText).toContain('asserts this flow');
    expect(popoverText).toContain('Globex');
    expect(popoverText).toContain('disputes this flow');
  });

  // §4.3: a conflict reports a difference between two vendors — it must not
  // read as a defect in either product, and AECi does not pick a side.
  it('closes a conflict by showing both accounts rather than picking one', () => {
    const { popoverText } = open(claim('conflict', [att('context', true), att('other', false)]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('describe this flow differently');
    expect(popoverText).toContain('We show both accounts rather than pick one');
  });

  it('names the silent counterparty for single_source', () => {
    const { popoverText } = open(
      claim('single_source', [att('aeci', true), att('context', true)]),
      {
        context: 'Acme Software',
        other: 'Globex',
      },
    );
    expect(popoverText).toContain('Globex has not responded');
    expect(popoverText).toContain("one vendor's account rather than an agreed one");
  });

  it('falls back to a generic phrasing when the silent side has no vendor record', () => {
    const { popoverText } = open(claim('single_source', [att('context', true)]), {
      context: 'Acme Software',
      other: null,
    });
    expect(popoverText).toContain('The other vendor has not responded');
    expect(popoverText).not.toContain('null');
  });

  it('states plainly when both vendors confirmed', () => {
    const { popoverText } = open(claim('confirmed', [att('context', true), att('other', true)]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('Both vendors have confirmed this flow.');
  });
});
