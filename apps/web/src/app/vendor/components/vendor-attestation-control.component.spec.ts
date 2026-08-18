/**
 * AECI-606 — `VendorAttestationControl`: Affirm / Deny / Clear on one claim.
 *
 * **The first test in this file is the reason the file exists.**
 * `PUT /api/vendor/claims/:id/attestation` REPLACES the caller's position rather
 * than patching it: "an omitted `note` or version stamp lands as `null` on the
 * new row". Every neighbouring write on this dashboard is a PATCH of
 * only-changed-fields, so the natural thing to write here — `{ asserted: false }`
 * — silently destroys the note and version stamps the vendor recorded earlier.
 * These cases pin the whole position onto every request.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductVersion, VendorClaim } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_INTEGRATIONS_FIXTURE, VENDOR_PRODUCT_VERSIONS_FIXTURE } from '../vendor-fixtures';

import { VendorAttestationControl } from './vendor-attestation-control';

/** The `rfis` lane: affirmed, with a note AND an introduced-version stamp. */
const STAMPED_CLAIM = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
/** The AECi-seeded `models` lane: no position of the caller's at all. */
const UNVOTED_CLAIM = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[0];
const VERSIONS = VENDOR_PRODUCT_VERSIONS_FIXTURE[
  '00000000-0000-4000-8000-000000005201'
] as readonly ProductVersion[];

let upsertAttestation: ReturnType<typeof vi.fn>;
let retractAttestation: ReturnType<typeof vi.fn>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  upsertAttestation = vi.fn().mockResolvedValue({ claim: STAMPED_CLAIM });
  retractAttestation = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      {
        provide: VendorApi,
        useValue: { upsertAttestation, retractAttestation } as Partial<VendorApi>,
      },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

function create(
  claim: VendorClaim = STAMPED_CLAIM,
  versions: readonly ProductVersion[] = VERSIONS,
): ComponentFixture<VendorAttestationControl> {
  const fixture = TestBed.createComponent(VendorAttestationControl);
  fixture.componentRef.setInput('claim', claim);
  fixture.componentRef.setInput('versions', versions);
  fixture.detectChanges();
  return fixture;
}

function button(
  fixture: ComponentFixture<VendorAttestationControl>,
  name: string,
): HTMLButtonElement {
  const el = fixture.nativeElement as HTMLElement;
  const match = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().toLowerCase() === name.toLowerCase(),
  );
  if (!match) throw new Error(`no button named ${name}`);
  return match as HTMLButtonElement;
}

describe('VendorAttestationControl — PUT replaces, it does not patch', () => {
  it('sends the whole position on Deny, preserving an untouched note and version stamps', async () => {
    const fixture = create();

    button(fixture, 'Deny').click();
    await flush();

    // Not `{ asserted: false }`. Every field, every time — anything less erases
    // what the vendor already recorded.
    expect(upsertAttestation).toHaveBeenCalledWith(STAMPED_CLAIM.id, {
      asserted: false,
      note: 'Only for RFIs created after 2025.',
      introduced_version_id: STAMPED_CLAIM.mine[0].introduced_version_id,
      deprecated_version_id: null,
    });
  });

  it('sends the whole position on Affirm too', async () => {
    const fixture = create();

    button(fixture, 'Affirm').click();
    await flush();

    expect(upsertAttestation).toHaveBeenCalledWith(STAMPED_CLAIM.id, {
      asserted: true,
      note: 'Only for RFIs created after 2025.',
      introduced_version_id: STAMPED_CLAIM.mine[0].introduced_version_id,
      deprecated_version_id: null,
    });
  });

  it('sends an explicit null when the vendor clears the note', async () => {
    const fixture = create();
    const el = fixture.nativeElement as HTMLElement;
    const textarea = el.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();

    button(fixture, 'Affirm').click();
    await flush();

    // Whitespace is not a note. `null`, not `'   '` and not omitted.
    expect(upsertAttestation.mock.calls[0][1]).toMatchObject({ note: null });
  });

  it('seeds the editor from the caller’s own slot so the user can see what will be sent', () => {
    const el = create().nativeElement as HTMLElement;
    expect((el.querySelector('textarea') as HTMLTextAreaElement).value).toBe(
      'Only for RFIs created after 2025.',
    );
  });

  it('names the note AND the stamps in the collapsed summary', () => {
    // The editor is a disclosure, so the summary is what a vendor reads before
    // pressing Deny. It must quote the note that is about to be re-sent, not
    // say something neutral like "Details" over a populated field.
    const summary = (create().nativeElement as HTMLElement).querySelector('summary');
    expect(summary?.textContent).toContain('Only for RFIs created after 2025.');
    expect(summary?.textContent).toContain('2025.2');
    // A `$localize` placeholder name only attaches to an interpolation; a bare
    // `:name:` suffix renders as literal text. Cheap to write, invisible in
    // review, and it shipped once already in this very string.
    expect(summary?.textContent).not.toMatch(/:[a-z]+:/);
  });

  it('says so plainly when there is no note to lose', () => {
    const claim: VendorClaim = {
      ...STAMPED_CLAIM,
      mine: [{ ...STAMPED_CLAIM.mine[0], note: null, introduced_version_id: null }],
    };
    const summary = (create(claim).nativeElement as HTMLElement).querySelector('summary');
    expect(summary?.textContent).toContain('No note');
  });
});

describe('VendorAttestationControl — Clear', () => {
  it('retracts and emits the claim id rather than reconstructing the claim', async () => {
    const fixture = create();
    const retracted = vi.fn();
    fixture.componentInstance.retracted.subscribe(retracted);

    button(fixture, 'Clear').click();
    await flush();

    expect(retractAttestation).toHaveBeenCalledWith(STAMPED_CLAIM.id);
    expect(retracted).toHaveBeenCalledWith(STAMPED_CLAIM.id);
  });

  it('is disabled when there is no position to withdraw', () => {
    // A DELETE with nothing of the caller's to retract is a 404, deliberately
    // not an idempotent 204 — so the button must not offer it.
    expect(button(create(UNVOTED_CLAIM), 'Clear').disabled).toBe(true);
  });

  it('leaves Affirm and Deny enabled, so activation never disables the focused button', () => {
    const fixture = create();
    expect(button(fixture, 'Affirm').disabled).toBe(false);
    expect(button(fixture, 'Deny').disabled).toBe(false);
  });
});

describe('VendorAttestationControl — failure handling', () => {
  it('reports a 403 as a verification message that never mentions ranking or search', async () => {
    const { HttpErrorResponse } = await import('@angular/common/http');
    upsertAttestation.mockRejectedValue(
      new HttpErrorResponse({
        status: 403,
        error: { error: { code: 'FORBIDDEN', message: 'nope' }, trace_id: 't' },
      }),
    );
    const fixture = create();

    button(fixture, 'Affirm').click();
    await flush();
    fixture.detectChanges();

    const alert = (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]');
    const text = alert?.textContent ?? '';
    expect(text).toContain('verified account');
    expect(text).not.toMatch(/rank|placement|search/i);
  });

  it('falls back to a retry notice on an unrecognised failure', async () => {
    upsertAttestation.mockRejectedValue(new Error('offline'));
    const fixture = create();

    button(fixture, 'Deny').click();
    await flush();
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent,
    ).toContain('Try again');
  });
});

describe('VendorAttestationControl — the owns-both divergence case', () => {
  it('warns when two owned slots record different details', () => {
    // One PUT body replaces every owned slot, so two rows that disagree get
    // collapsed on the next save. The UI has to say so rather than do it quietly.
    const divergent: VendorClaim = {
      ...STAMPED_CLAIM,
      mine: [
        { ...STAMPED_CLAIM.mine[0], slot: 'vendor_a', note: 'A' },
        { ...STAMPED_CLAIM.mine[0], slot: 'vendor_b', note: 'B' },
      ],
    };

    const el = create(divergent).nativeElement as HTMLElement;
    expect(el.querySelector('[role="status"]')?.textContent).toContain('different details');
  });

  it('does NOT warn when only the version stamps differ across slots', () => {
    // That is the server's own doing: §8.2 requires a stamp to belong to the
    // attesting side's endpoint, so an owns-both write lands it on one slot and
    // leaves the other null. Warning here would fire on every stamped
    // both-endpoints claim.
    const agreeing: VendorClaim = VENDOR_INTEGRATIONS_FIXTURE.integrations[1].claims[0];
    expect(agreeing.mine).toHaveLength(2);
    expect(agreeing.mine[0].introduced_version_id).not.toBe(agreeing.mine[1].introduced_version_id);

    const el = create(agreeing, []).nativeElement as HTMLElement;
    expect(el.querySelector('[role="status"]')).toBeNull();
  });
});

describe('VendorAttestationControl — version stamps', () => {
  it('omits the version pickers when the product has no releases', () => {
    const el = create(STAMPED_CLAIM, []).nativeElement as HTMLElement;
    // The disclosure stays (it still holds the note); only the pickers go.
    expect(el.querySelector('details')).not.toBeNull();
    expect(el.querySelector('[role="combobox"]')).toBeNull();
  });

  it('renders the pickers as closed Aria comboboxes, never an open listbox', () => {
    // Repo convention: assert the collapsed trigger's wiring only; the
    // open→select interaction is jsdom-hostile and is covered live + in e2e.
    const el = create().nativeElement as HTMLElement;
    const triggers = [...el.querySelectorAll('[role="combobox"]')];
    expect(triggers).toHaveLength(2);
    for (const trigger of triggers) {
      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      const labelledBy = trigger.getAttribute('aria-labelledby')?.split(' ') ?? [];
      expect(labelledBy.length).toBeGreaterThan(0);
      // Every referenced id must actually exist, or the label is a dangling
      // pointer (the AECI-232 lesson).
      for (const id of labelledBy) {
        expect([...el.querySelectorAll('[id]')].some((n) => n.id === id)).toBe(true);
      }
    }
    expect(el.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('derives picker ids from the claim id so repeated lanes never collide', () => {
    const el = create().nativeElement as HTMLElement;
    expect(el.querySelector(`#vendor-claim-${STAMPED_CLAIM.id}-introduced-trigger`)).not.toBeNull();
    expect(el.querySelector(`#vendor-claim-${STAMPED_CLAIM.id}-deprecated-trigger`)).not.toBeNull();
  });
});
