/**
 * AECI-606 — `VendorClaimLane`: one data-flow claim as its own vendor sees it.
 *
 * The direction cases are the point. `VendorClaim.direction` arrives
 * caller-relative, framed against `context_product`, so the arrow must follow
 * the vendor's own product regardless of which endpoint slot they happen to
 * hold — and the stored `a_to_b` / `b_to_a` must never reach the DOM.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorClaim } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_INTEGRATIONS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorClaimLane } from './vendor-claim-lane';

const [PROCORE, BOTH_ENDPOINTS, VENDOR_B_ONLY] = VENDOR_INTEGRATIONS_FIXTURE.integrations;
const UNVOTED = PROCORE.claims[0]; // models, outbound, origin aeci
const SINGLE_SOURCE = PROCORE.claims[1]; // rfis, outbound, affirmed by us only
const CONFIRMED = PROCORE.claims[2]; // submittals, inbound, both sides
const CONFLICT = PROCORE.claims[3]; // drawings, both, we affirm / they deny

let retractAttestation: ReturnType<typeof vi.fn>;
let getIntegrations: ReturnType<typeof vi.fn>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  retractAttestation = vi.fn().mockResolvedValue(undefined);
  getIntegrations = vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      {
        provide: VendorApi,
        useValue: { retractAttestation, getIntegrations } as Partial<VendorApi>,
      },
      VendorPortalStore,
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

function create(
  claim: VendorClaim,
  otherProductName = PROCORE.other_product.name,
  canWrite = true,
): ComponentFixture<VendorClaimLane> {
  const fixture = TestBed.createComponent(VendorClaimLane);
  fixture.componentRef.setInput('claim', claim);
  fixture.componentRef.setInput('otherProductName', otherProductName);
  fixture.componentRef.setInput('contextProductId', PROCORE.context_product.id);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  fixture.componentRef.setInput('canWrite', canWrite);
  fixture.componentRef.setInput('versions', []);
  fixture.detectChanges();
  return fixture;
}

const text = (fixture: ComponentFixture<VendorClaimLane>) =>
  (fixture.nativeElement as HTMLElement).textContent ?? '';

describe('VendorClaimLane — direction in the vendor’s frame', () => {
  it('renders `outbound` as "Sends to {counterpart}" when the caller holds vendor_a', () => {
    expect(text(create(SINGLE_SOURCE))).toContain('Sends to Procore');
  });

  it('renders `inbound` as "Receives from {counterpart}"', () => {
    expect(text(create(CONFIRMED))).toContain('Receives from Procore');
  });

  it('renders `both` as "Syncs both ways"', () => {
    expect(text(create(CONFLICT))).toContain('Syncs both ways');
  });

  it('frames from the caller’s own product even when they hold vendor_b', () => {
    // `context_product` is the vendor's product on BOTH sides of this test; the
    // arrow follows it, never the integration's source/target.
    const claim = VENDOR_B_ONLY.claims[0];
    expect(claim.direction).toBe('inbound');
    expect(VENDOR_B_ONLY.slots).toEqual(['vendor_b']);

    expect(text(create(claim, VENDOR_B_ONLY.other_product.name))).toContain(
      'Receives from Autodesk Build',
    );
  });

  it('never leaks the stored a_to_b / b_to_a vocabulary', () => {
    for (const claim of [UNVOTED, SINGLE_SOURCE, CONFIRMED, CONFLICT]) {
      expect(text(create(claim))).not.toMatch(/a_to_b|b_to_a/);
    }
  });
});

describe('VendorClaimLane — agreement and the counterparty', () => {
  it('attributes a single_source badge to the caller’s own vendor name', () => {
    expect(text(create(SINGLE_SOURCE))).toContain('Confirmed by Summit BIM');
  });

  it('leaves the badge unattributed when the lone voice is the counterparty', () => {
    // We know the counterpart's PRODUCT, never its vendor, and the badge copy
    // says "Confirmed by {vendor}" — so a product name there would be a lie.
    const theirsOnly: VendorClaim = {
      ...SINGLE_SOURCE,
      mine: [],
      counterparty: { asserted: true, note: null },
    };
    const body = text(create(theirsOnly));
    expect(body).toContain('Confirmed by one vendor');
    expect(body).not.toContain('Confirmed by Procore');
  });

  it('distinguishes "nobody yet" from "they have not responded"', () => {
    expect(text(create(UNVOTED))).toContain('Neither vendor has confirmed this yet');
    expect(text(create(SINGLE_SOURCE))).toContain('The other vendor has not responded');
  });

  it('marks an AECi-seeded claim as such', () => {
    expect(text(create(UNVOTED))).toContain('On record from AEC Integrations');
    expect(text(create(SINGLE_SOURCE))).not.toContain('On record from AEC Integrations');
  });
});

describe('VendorClaimLane — a conflict is legible from the vendor’s side', () => {
  it('shows both positions and both notes', () => {
    const body = text(create(CONFLICT));

    expect(body).toContain('describe this flow differently');
    expect(body).toContain('Your position');
    expect(body).toContain('Procore’s position');
    // The vendor's own note and the counterparty's, side by side — §6's
    // "with the counterparty's position shown".
    expect(body).toContain('Sheets sync both ways through the coordination workspace.');
    expect(body).toContain('We do not ingest sheets from this tool.');
    expect(body).toContain('correction request');
  });

  it('renders the conflict disclosure without the error token', () => {
    // Red is the agreement badge's alone on this surface; the disclosure is two
    // parties describing a flow differently, not a defect.
    const el = create(CONFLICT).nativeElement as HTMLElement;
    const block = [...el.querySelectorAll('div')].find((d) =>
      d.className.includes('--surface-sunken'),
    );
    expect(block).toBeDefined();
    expect(block?.className).not.toContain('--status-error');
  });

  it('shows no conflict disclosure on the other three states', () => {
    for (const claim of [UNVOTED, SINGLE_SOURCE, CONFIRMED]) {
      expect(text(create(claim))).not.toContain('describe this flow differently');
    }
  });
});

describe('VendorClaimLane — the unverified read-only state', () => {
  it('renders the claim in full but withholds the authoring control', () => {
    const fixture = create(SINGLE_SOURCE, PROCORE.other_product.name, false);
    const el = fixture.nativeElement as HTMLElement;

    // Real data, not a gate: `GET /api/vendor/integrations` is not
    // Verified-gated, so the vendor sees their surface.
    expect(el.textContent).toContain('RFIs');
    expect(el.textContent).toContain('Sends to Procore');
    expect(el.querySelector('aec-vendor-attestation-control')).toBeNull();
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('VendorClaimLane — the duplicate-claim highlight', () => {
  it('marks the pivoted-to lane for sighted and assistive users alike', () => {
    const fixture = TestBed.createComponent(VendorClaimLane);
    fixture.componentRef.setInput('claim', SINGLE_SOURCE);
    fixture.componentRef.setInput('otherProductName', 'Procore');
    fixture.componentRef.setInput('contextProductId', PROCORE.context_product.id);
    fixture.componentRef.setInput('vendorName', 'Summit BIM');
    fixture.componentRef.setInput('canWrite', true);
    fixture.componentRef.setInput('versions', []);
    fixture.componentRef.setInput('highlighted', true);
    fixture.detectChanges();

    // (The host is an `<li>` in real use — the component takes an ATTRIBUTE
    // selector so nothing sits between the `<ul>` and its items. TestBed
    // synthesises a `<div>` host regardless, so the structural assertion lives
    // in `vendor-integrations-section.component.spec.ts` where the real DOM is
    // built.)
    const row = fixture.nativeElement as HTMLElement;
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(row.className).toContain('--accent-primary');
  });
});

describe('VendorClaimLane — the owns-both case', () => {
  it('still renders single_source when one company fills two slots', () => {
    const claim = BOTH_ENDPOINTS.claims[0];
    expect(claim.mine).toHaveLength(2);
    // One company is one voter; two slots cannot manufacture agreement.
    expect(text(create(claim, BOTH_ENDPOINTS.other_product.name))).toContain(
      'Confirmed by Summit BIM',
    );
  });
});

describe('VendorClaimLane — the optimistic retract interim (AECI-630)', () => {
  /** Load the real list into the store, so the lane's Clear writes against it. */
  async function seededStore(): Promise<VendorPortalStore> {
    const store = TestBed.inject(VendorPortalStore);
    await store.ensure('integrations');
    return store;
  }

  const clear = (fixture: ComponentFixture<VendorClaimLane>) => {
    const el = fixture.nativeElement as HTMLElement;
    const match = [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Clear');
    if (!match) throw new Error('no Clear button');
    match.click();
  };

  const claimIn = (store: VendorPortalStore, claimId: string) =>
    store
      .integrations()
      .flatMap((i) => i.claims)
      .find((c) => c.id === claimId)!;

  it('drops our own rows immediately and leaves the badge for the re-read', async () => {
    const store = await seededStore();
    let settle!: () => void;
    retractAttestation.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const fixture = create(SINGLE_SOURCE);

    clear(fixture);

    // The lane stops asserting at once rather than sitting frozen for a round
    // trip plus a re-read...
    expect(claimIn(store, SINGLE_SOURCE.id).mine).toEqual([]);
    // ...but `agreement` is the server's to recompute (a 204 carries no body,
    // and `counterparty` is a lossy reduction of every other voter).
    expect(claimIn(store, SINGLE_SOURCE.id).agreement).toBe('single_source');

    settle();
    await flush();
  });

  it('reports itself busy while the write is in flight, and stops when it settles', async () => {
    await seededStore();
    let settle!: () => void;
    retractAttestation.mockReturnValue(
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );
    const fixture = create(SINGLE_SOURCE);
    const row = fixture.nativeElement as HTMLElement;

    expect(row.getAttribute('aria-busy')).toBeNull();

    clear(fixture);
    fixture.detectChanges();
    // Part of the lane has moved and part has not; `aria-busy` is how an
    // assistive reader is told that rather than hearing a contradiction.
    expect(row.getAttribute('aria-busy')).toBe('true');

    settle();
    await flush();
    fixture.detectChanges();
    expect(row.getAttribute('aria-busy')).toBeNull();
  });

  it('rolls the position back and shows a lane-local error when the retract fails', async () => {
    // The rollback test for the retract path. Without it the lane would keep
    // rendering "no position" for a withdrawal the server refused.
    const store = await seededStore();
    retractAttestation.mockRejectedValue(new Error('offline'));
    const fixture = create(SINGLE_SOURCE);

    clear(fixture);
    await flush();
    fixture.detectChanges();

    expect(claimIn(store, SINGLE_SOURCE.id).mine).toEqual(SINGLE_SOURCE.mine);
    // Failures stay lane-local and `role="alert"`, beside the control that
    // failed — never in the tab's one polite live region.
    const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Try again');
    expect((fixture.nativeElement as HTMLElement).getAttribute('aria-busy')).toBeNull();
  });

  it('renders the interim honestly once the patch lands', () => {
    // What the card re-renders the lane with mid-flight: our rows gone, the
    // badge not yet moved. The stance line must follow the rows, and the badge
    // must not borrow our name for an attribution we just withdrew.
    const interim: VendorClaim = { ...SINGLE_SOURCE, mine: [] };
    const body = text(create(interim));

    expect(body).toContain('No position yet');
    expect(body).not.toContain('Confirmed by Summit BIM');
  });
});
