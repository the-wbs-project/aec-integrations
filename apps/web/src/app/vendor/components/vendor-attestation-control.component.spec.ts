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
 *
 * AECI-630 adds the optimistic half (`STAGE_2_REALTIME_SPEC.md` §5), and every
 * optimistic path here carries a **rollback** case. An optimistic UI without a
 * tested rollback is just a bug with good latency: the failure mode is a control
 * left rendering a position the server rejected, which is worse than the latency
 * it bought. The optimistic row is built from the same `position()` object as the
 * request, so the "whole position, every time" cases above cover it too.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductVersion, VendorClaim, VendorClaimResponse } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_INTEGRATIONS_FIXTURE, VENDOR_PRODUCT_VERSIONS_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorAttestationControl } from './vendor-attestation-control';

/** The `rfis` lane: affirmed, with a note AND an introduced-version stamp. */
const STAMPED_CLAIM = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[1];
/** The AECi-seeded `models` lane: no position of the caller's at all. */
const UNVOTED_CLAIM = VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[0];
/** The owns-both lane: one company, two slots, still one voter. */
const OWNS_BOTH_CLAIM = VENDOR_INTEGRATIONS_FIXTURE.integrations[1].claims[0];
const VERSIONS = VENDOR_PRODUCT_VERSIONS_FIXTURE[
  '00000000-0000-4000-8000-000000005201'
] as readonly ProductVersion[];

let upsertAttestation: ReturnType<typeof vi.fn>;
let retractAttestation: ReturnType<typeof vi.fn>;
let getIntegrations: ReturnType<typeof vi.fn>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  upsertAttestation = vi.fn().mockResolvedValue({ claim: STAMPED_CLAIM });
  retractAttestation = vi.fn().mockResolvedValue(undefined);
  getIntegrations = vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE);
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      {
        provide: VendorApi,
        useValue: { upsertAttestation, retractAttestation, getIntegrations } as Partial<VendorApi>,
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
  claim: VendorClaim = STAMPED_CLAIM,
  versions: readonly ProductVersion[] = VERSIONS,
): ComponentFixture<VendorAttestationControl> {
  const fixture = TestBed.createComponent(VendorAttestationControl);
  fixture.componentRef.setInput('claim', claim);
  fixture.componentRef.setInput('versions', versions);
  fixture.detectChanges();
  return fixture;
}

/** Load the real integration list into the store, exactly as the tab does. The
 *  optimistic patches below are writes against THIS list. */
async function seededStore(): Promise<VendorPortalStore> {
  const store = TestBed.inject(VendorPortalStore);
  await store.ensure('integrations');
  return store;
}

/** One claim as the store currently holds it. */
function claimIn(store: VendorPortalStore, claimId: string): VendorClaim {
  const claim = store
    .integrations()
    .flatMap((i) => i.claims)
    .find((c) => c.id === claimId);
  if (!claim) throw new Error(`claim ${claimId} is not in the store`);
  return claim;
}

/** A promise whose settlement this test controls, so the window between the
 *  optimistic patch and the server's answer is inspectable. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

describe('VendorAttestationControl — optimistic assert / deny (AECI-630)', () => {
  it('renders the new position before the server answers', async () => {
    const store = await seededStore();
    const pending = deferred<VendorClaimResponse>();
    upsertAttestation.mockReturnValue(pending.promise);
    const fixture = create();

    button(fixture, 'Deny').click();

    // No await: the patch is applied before the request is even sent.
    expect(claimIn(store, STAMPED_CLAIM.id).mine[0].asserted).toBe(false);
    expect(upsertAttestation).toHaveBeenCalled();

    pending.resolve({ claim: STAMPED_CLAIM });
    await flush();
  });

  it('carries the WHOLE position onto the optimistic row, not a partial one', async () => {
    // The same trap the file opens with, one layer in: an optimistic path that
    // builds its own `{ asserted }` would render a note-less, stamp-less
    // position and hide the data loss until the echo landed.
    const store = await seededStore();
    upsertAttestation.mockReturnValue(deferred<VendorClaimResponse>().promise);
    const fixture = create();

    button(fixture, 'Deny').click();

    const [row] = claimIn(store, STAMPED_CLAIM.id).mine;
    expect(row).toMatchObject({
      asserted: false,
      note: 'Only for RFIs created after 2025.',
      introduced_version_id: STAMPED_CLAIM.mine[0].introduced_version_id,
      deprecated_version_id: null,
    });
    // Identical to what went on the wire — one `position()`, two consumers.
    const sent = upsertAttestation.mock.calls[0][1] as Record<string, unknown>;
    expect(row).toMatchObject(sent);
  });

  it('fills every owned slot, taking them from the integration rather than from `mine`', async () => {
    // A first attestation has no `mine` to copy slots from, and a half-voted
    // owns-both claim has one too few. `VendorIntegration.slots` is the read's
    // own answer to "which are mine".
    const store = await seededStore();
    upsertAttestation.mockReturnValue(deferred<VendorClaimResponse>().promise);

    const first = create(UNVOTED_CLAIM);
    button(first, 'Affirm').click();
    expect(claimIn(store, UNVOTED_CLAIM.id).mine.map((a) => a.slot)).toEqual(['vendor_a']);

    const both = create(OWNS_BOTH_CLAIM, []);
    button(both, 'Deny').click();
    expect(claimIn(store, OWNS_BOTH_CLAIM.id).mine.map((a) => a.slot)).toEqual([
      'vendor_a',
      'vendor_b',
    ]);
  });

  it('leaves `agreement` and `counterparty` for the echo', async () => {
    // The dashboard never re-derives `computeAgreement`, and `counterparty` is a
    // lossy reduction of every other voter — a third vendor would be invisible
    // to a local guess.
    const store = await seededStore();
    upsertAttestation.mockReturnValue(deferred<VendorClaimResponse>().promise);
    const fixture = create(VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[3]);

    button(fixture, 'Affirm').click();

    const claim = claimIn(store, VENDOR_INTEGRATIONS_FIXTURE.integrations[0].claims[3].id);
    expect(claim.agreement).toBe('conflict');
    expect(claim.counterparty).toEqual({
      asserted: false,
      note: 'We do not ingest sheets from this tool.',
    });
  });

  it('replaces the optimistic value with the echo, agreement included', async () => {
    const store = await seededStore();
    const echo: VendorClaim = { ...STAMPED_CLAIM, agreement: 'confirmed' };
    upsertAttestation.mockResolvedValue({ claim: echo });
    const fixture = create();

    button(fixture, 'Affirm').click();
    await flush();

    expect(claimIn(store, STAMPED_CLAIM.id)).toBe(echo);
  });

  it('rolls the position back AND shows the error when the write fails', async () => {
    // The rollback test. A silent revert reads as a UI glitch and the vendor
    // clicks again; a revert with no rollback leaves the control asserting a
    // position the server rejected.
    const store = await seededStore();
    upsertAttestation.mockRejectedValue(new Error('offline'));
    const fixture = create();

    button(fixture, 'Deny').click();
    await flush();
    fixture.detectChanges();

    expect(claimIn(store, STAMPED_CLAIM.id).mine).toEqual(STAMPED_CLAIM.mine);
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent,
    ).toContain('Try again');
  });

  it('rolls back a first-ever attestation to no position at all', async () => {
    const store = await seededStore();
    upsertAttestation.mockRejectedValue(new Error('offline'));
    const fixture = create(UNVOTED_CLAIM);

    button(fixture, 'Affirm').click();
    await flush();
    fixture.detectChanges();

    expect(claimIn(store, UNVOTED_CLAIM.id).mine).toEqual([]);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('VendorAttestationControl — optimistic retract (AECI-630)', () => {
  it('withdraws the position locally so the lane does not sit frozen', async () => {
    const store = await seededStore();
    const pending = deferred<void>();
    retractAttestation.mockReturnValue(pending.promise);
    const fixture = create();

    button(fixture, 'Clear').click();

    expect(claimIn(store, STAMPED_CLAIM.id).mine).toEqual([]);
    // The DELETE determines our own rows and nothing else: 204, no body, and the
    // recomputed agreement arrives with the section's re-read.
    expect(claimIn(store, STAMPED_CLAIM.id).agreement).toBe('single_source');

    pending.resolve();
    await flush();
  });

  it('keeps the interim after a 204 and hands the re-read to the section', async () => {
    const store = await seededStore();
    const fixture = create();
    const retracted = vi.fn();
    fixture.componentInstance.retracted.subscribe(retracted);

    button(fixture, 'Clear').click();
    await flush();

    expect(claimIn(store, STAMPED_CLAIM.id).mine).toEqual([]);
    expect(retracted).toHaveBeenCalledWith(STAMPED_CLAIM.id);
    // The control never re-reads: reconstructing the agreement is the section's
    // one targeted refetch, not a local guess.
    expect(getIntegrations.mock.calls.length).toBe(1); // the seeding read only
  });

  it('puts the position back AND shows the error when the retract fails', async () => {
    const store = await seededStore();
    retractAttestation.mockRejectedValue(new Error('offline'));
    const fixture = create();
    const retracted = vi.fn();
    fixture.componentInstance.retracted.subscribe(retracted);

    button(fixture, 'Clear').click();
    await flush();
    fixture.detectChanges();

    expect(claimIn(store, STAMPED_CLAIM.id).mine).toEqual(STAMPED_CLAIM.mine);
    expect(retracted).not.toHaveBeenCalled();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent,
    ).toContain('Try again');
  });
});

describe('VendorAttestationControl — a provisional lane cannot be written to', () => {
  it('disables all three commands on the add form’s placeholder', async () => {
    await seededStore();
    // The id the optimistic insert mints. It is deliberately not a UUID: the
    // server has never seen it, so a write against it could only 404.
    const provisional: VendorClaim = { ...STAMPED_CLAIM, id: 'pending-claim:1' };
    const fixture = create(provisional);

    for (const name of ['Affirm', 'Deny', 'Clear']) {
      expect(button(fixture, name).disabled).toBe(true);
    }
    expect(upsertAttestation).not.toHaveBeenCalled();
    expect(retractAttestation).not.toHaveBeenCalled();
  });
});

describe('VendorAttestationControl — the owns-both divergence case', () => {
  /** The divergence notice, found by its copy rather than by `role="status"`.
   *  It deliberately is NOT a live region (see the template comment): it
   *  describes a standing condition, and `divergentSlots()` is computed off
   *  store data a background revalidation can move, so as a region it competed
   *  with `VendorPortalAnnouncer` for the same event. */
  const divergenceNotice = (el: HTMLElement): HTMLElement | undefined =>
    [...el.querySelectorAll('p')].find((p) => (p.textContent ?? '').includes('different details'));

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
    expect(divergenceNotice(el)?.textContent).toContain('different details');
  });

  it('does not make the divergence notice a live region', () => {
    // The single-channel rule (STAGE_2_REALTIME_SPEC.md §6.3): standing state is
    // plain text, events go through VendorPortalAnnouncer. A `role="status"`
    // here fires on a store refetch the user did not cause, on the one tab that
    // also announces, so two utterances queue for one event.
    const divergent: VendorClaim = {
      ...STAMPED_CLAIM,
      mine: [
        { ...STAMPED_CLAIM.mine[0], slot: 'vendor_a', note: 'A' },
        { ...STAMPED_CLAIM.mine[0], slot: 'vendor_b', note: 'B' },
      ],
    };

    const el = create(divergent).nativeElement as HTMLElement;
    expect(divergenceNotice(el)).toBeDefined();
    expect(divergenceNotice(el)?.getAttribute('role')).toBeNull();
    expect(divergenceNotice(el)?.getAttribute('aria-live')).toBeNull();
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
    expect(divergenceNotice(el)).toBeUndefined();
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
