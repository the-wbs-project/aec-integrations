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

import type {
  AgreementState,
  ClaimTimeline,
  PairClaimAttestation,
  ProductPairClaim,
} from '@aeci/shared';

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
  vendors: {
    context?: string | null;
    other?: string | null;
    /** AECI-303 (§9.1) history; absent = the parent's lazy fetch has not landed. */
    timeline?: ClaimTimeline | null;
  } = {},
): { host: HTMLElement; popoverText: string } {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(ClaimProvenance);
  fixture.componentRef.setInput('claim', c);
  fixture.componentRef.setInput('contextVendorName', vendors.context ?? null);
  fixture.componentRef.setInput('otherVendorName', vendors.other ?? null);
  fixture.componentRef.setInput('timeline', vendors.timeline ?? null);
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

// ─── The append-only history (AECI-303 / §9.1) ───────────────────────────────

const timeline = (entries: ClaimTimeline['entries']): ClaimTimeline => ({
  claim_id: '00000000-0000-4000-8000-000000000030',
  entries,
});

describe('ClaimProvenance — history', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
  });

  it('renders NO history section without a timeline — the popover is unchanged', () => {
    // Every claim before the first lazy fetch, and every claim with no version data.
    const { popoverText } = open(claim('unverified', [att('aeci', true)]));
    expect(popoverText).toContain('Provenance');
    expect(popoverText).not.toContain('History');
  });

  it('renders no history section for an EMPTY timeline', () => {
    const { popoverText } = open(claim('unverified', [att('aeci', true)]), {
      timeline: timeline([]),
    });
    expect(popoverText).not.toContain('History');
  });

  it('renders the history with version labels and a UTC-pinned date', () => {
    const { popoverText } = open(claim('single_source', [att('context', true)]), {
      context: 'Acme Software',
      timeline: timeline([
        {
          attestor: 'context',
          asserted: true,
          note: null,
          introduced_version: '2026.1',
          deprecated_version: '2026.4',
          // A date-only stamp parses as UTC midnight. Ambient-zone formatting would
          // render "January 14" for every reader in the Americas AND drift from the
          // UTC SSR render, so the component pins UTC.
          created_at: '2026-01-15',
          retracted_at: null,
        },
      ]),
    });

    expect(popoverText).toContain('History');
    expect(popoverText).toContain('Acme Software');
    // The version LABEL is the primary token; the date is the secondary clause.
    expect(popoverText).toContain('2026.1 → 2026.4');
    expect(popoverText).toContain('January 15, 2026');
  });

  it('marks a retracted row as superseded — what makes it history, not state', () => {
    const { popoverText } = open(claim('unverified', [att('aeci', true)]), {
      timeline: timeline([
        {
          attestor: 'aeci',
          asserted: true,
          note: 'First position.',
          created_at: '2026-01-01T00:00:00.000Z',
          retracted_at: '2026-03-01T00:00:00.000Z',
        },
      ]),
    });
    expect(popoverText).toContain('superseded');
  });

  it('renders a one-sided version bound on its own', () => {
    const { popoverText } = open(claim('unverified', [att('aeci', true)]), {
      timeline: timeline([
        {
          attestor: 'aeci',
          asserted: true,
          note: null,
          introduced_version: '2026.1',
          created_at: '2026-01-01T00:00:00.000Z',
          retracted_at: null,
        },
      ]),
    });
    expect(popoverText).toContain('Since 2026.1');
  });

  it('caps the rendered entries and reports how many are hidden', () => {
    // The popover is w-[min(90vw,20rem)] and the append-only log grows forever, so
    // the cap is not cosmetic.
    const entries = Array.from({ length: 11 }, (_, i) => ({
      attestor: 'aeci' as const,
      asserted: true,
      note: `entry-${i}`,
      created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z`,
      retracted_at: i < 10 ? '2026-06-01T00:00:00.000Z' : null,
    }));
    const { popoverText } = open(claim('unverified', [att('aeci', true)]), {
      timeline: timeline(entries),
    });

    // The window keeps the MOST RECENT entries — the oldest three drop off.
    expect(popoverText).toContain('entry-10');
    expect(popoverText).not.toContain('entry-0');
    expect(popoverText).toContain('3 earlier entries');
  });

  it('widens the trigger label only when a history exists', () => {
    const withoutHistory = open(claim('unverified', [att('aeci', true)]));
    expect(withoutHistory.host.querySelector('button')!.getAttribute('aria-label')).toBe(
      'Provenance for RFIs',
    );

    TestBed.resetTestingModule();
    const withHistory = open(claim('unverified', [att('aeci', true)]), {
      timeline: timeline([
        {
          attestor: 'aeci',
          asserted: true,
          note: null,
          created_at: '2026-01-01T00:00:00.000Z',
          retracted_at: null,
        },
      ]),
    });
    expect(withHistory.host.querySelector('button')!.getAttribute('aria-label')).toBe(
      'Provenance and history for RFIs',
    );
  });
});
