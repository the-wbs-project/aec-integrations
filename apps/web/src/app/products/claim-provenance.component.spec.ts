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
    expect(btn?.getAttribute('aria-label')).toContain('Sources for RFIs');
  });

  it('attributes the AECi seed and closes on the unconfirmed state', () => {
    const { popoverText } = open(claim('unverified', [att('aeci', true, 'Curated by AECi.')]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('Sources');
    expect(popoverText).toContain('Listed by AEC Integrations');
    expect(popoverText).toContain('Curated by AECi.');
    expect(popoverText).toContain('Neither company has confirmed this yet.');
    // AECI-1142: no data-model jargon in the popover's own copy.
    expect(popoverText).not.toMatch(/Provenance|asserts|disputes|this flow/);
    // AECI-781: the vendor portal shipped 2026-09-03, so the closing line must
    // never again describe vendor confirmation as a forthcoming feature.
    expect(popoverText).not.toContain('vendor portal');
  });

  it('names each vendor by its context-relative attestor', () => {
    const { popoverText } = open(claim('conflict', [att('context', true), att('other', false)]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('Acme Software confirms this');
    expect(popoverText).toContain('Globex says this is not accurate');
  });

  // §4.3: a conflict reports a difference between two vendors — it must not
  // read as a defect in either product, and AECi does not pick a side.
  it('closes a conflict by naming both companies and taking no side', () => {
    const { popoverText } = open(claim('conflict', [att('context', true), att('other', false)]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain(
      'Acme Software and Globex disagree about this. We show both answers and do not take sides.',
    );
  });

  it('falls back to "the two companies" when both sides share one vendor name', () => {
    const { popoverText } = open(claim('conflict', [att('context', true), att('other', false)]), {
      context: 'Acme Software',
      other: 'Acme Software',
    });
    expect(popoverText).toContain('The two companies disagree about this.');
    expect(popoverText).not.toContain('Acme Software and Acme Software');
  });

  it('names the silent counterparty for single_source', () => {
    const { popoverText } = open(
      claim('single_source', [att('aeci', true), att('context', true)]),
      {
        context: 'Acme Software',
        other: 'Globex',
      },
    );
    expect(popoverText).toContain('Globex has not answered yet.');
    expect(popoverText).toContain('Only one company has confirmed this.');
  });

  it('falls back to a generic phrasing when the silent side has no vendor record', () => {
    const { popoverText } = open(claim('single_source', [att('context', true)]), {
      context: 'Acme Software',
      other: null,
    });
    expect(popoverText).toContain('The other company has not answered yet.');
    expect(popoverText).not.toContain('null');
  });

  it('states plainly when both vendors confirmed', () => {
    const { popoverText } = open(claim('confirmed', [att('context', true), att('other', true)]), {
      context: 'Acme Software',
      other: 'Globex',
    });
    expect(popoverText).toContain('Both companies confirm this.');
  });

  // The pair page dropped the History section: the popover is provenance only,
  // and opening it must not fetch the pair's attestation log.
  it('renders no history section', () => {
    const { popoverText } = open(claim('unverified', [att('aeci', true)]));
    expect(popoverText).not.toContain('History');
  });
});
