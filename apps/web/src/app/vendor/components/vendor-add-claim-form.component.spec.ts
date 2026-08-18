/**
 * AECI-606 — `VendorAddClaimForm`: create a claim over the closed vocabulary.
 *
 * Two behaviours carry this file. The **duplicate pivot**: a repeated identity
 * triple is a `400` whose `details.claim_id` names the lane that already exists,
 * and the API returns it specifically so the vendor is routed there instead of
 * dead-ended. And the **negative** of that: a `data_object` validation error
 * WITHOUT a `claim_id` is an unknown term, not a duplicate, so an over-broad
 * `catch` that pivots on every 400 has to fail here.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorClaim } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_DATA_OBJECTS_FIXTURE, VENDOR_INTEGRATIONS_FIXTURE } from '../vendor-fixtures';

import { VendorAddClaimForm } from './vendor-add-claim-form';

const INTEGRATION = VENDOR_INTEGRATIONS_FIXTURE.integrations[0];
/** `rfis`, `outbound` — the identity a duplicate submission would collide with. */
const EXISTING: VendorClaim = INTEGRATION.claims[1];

let createClaim: ReturnType<typeof vi.fn>;

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

/** The envelope `POST /api/vendor/claims` actually returns for a duplicate. */
function duplicateError(claimId: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status: 400,
    error: {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'A "RFIs" claim already exists in that direction on this integration',
        field: 'data_object',
        details: { claim_id: claimId },
      },
      trace_id: 't',
    },
  });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  createClaim = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      { provide: VendorApi, useValue: { createClaim } as Partial<VendorApi> },
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

function create(
  dataObjects = VENDOR_DATA_OBJECTS_FIXTURE,
  existingClaims: readonly VendorClaim[] = INTEGRATION.claims,
): ComponentFixture<VendorAddClaimForm> {
  const fixture = TestBed.createComponent(VendorAddClaimForm);
  fixture.componentRef.setInput('integrationId', INTEGRATION.id);
  fixture.componentRef.setInput('otherProductName', INTEGRATION.other_product.name);
  fixture.componentRef.setInput('dataObjects', dataObjects);
  fixture.componentRef.setInput('versions', []);
  fixture.componentRef.setInput('existingClaims', existingClaims);
  fixture.detectChanges();
  return fixture;
}

/** Drive the two required choices without opening any overlay — the repo
 *  convention is that a CDK overlay is never opened in a unit test. */
function choose(
  fixture: ComponentFixture<VendorAddClaimForm>,
  slug: string,
  direction: 'outbound' | 'inbound' | 'both',
): void {
  const component = fixture.componentInstance as unknown as {
    onDataObject(slug: string | null): void;
    directionSelection: { set(v: string[]): void };
  };
  component.onDataObject(slug);
  component.directionSelection.set([direction]);
  fixture.detectChanges();
}

const text = (fixture: ComponentFixture<VendorAddClaimForm>) =>
  (fixture.nativeElement as HTMLElement).textContent ?? '';

function button(
  fixture: ComponentFixture<VendorAddClaimForm>,
  label: string,
): HTMLButtonElement | null {
  const el = fixture.nativeElement as HTMLElement;
  return (
    ([...el.querySelectorAll('button')].find((b) =>
      b.textContent?.trim().toLowerCase().includes(label.toLowerCase()),
    ) as HTMLButtonElement | undefined) ?? null
  );
}

describe('VendorAddClaimForm — the closed vocabulary', () => {
  it('offers the vocabulary as a closed Aria combobox, not a text input', () => {
    const el = create().nativeElement as HTMLElement;
    // §5.2: the picker is what stops a vendor submitting a term the find-only
    // resolver will reject.
    const combobox = el.querySelector('[role="combobox"]');
    expect(combobox).not.toBeNull();
    expect(combobox?.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('input[type="text"]')).toBeNull();
    // Its popup is deferred, so nothing renders into the overlay container while
    // collapsed. (The direction control below IS a listbox and is always in the
    // DOM — it is a bare `ngListbox` radio substitute, not an overlay.)
    expect(document.querySelector('.cdk-overlay-container [role="listbox"]')).toBeNull();
  });

  it('renders direction as a bare Aria listbox in the vendor’s own frame', () => {
    const el = create().nativeElement as HTMLElement;
    const options = [...el.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());

    // The counterpart is named, and the stored `a_to_b` / `b_to_a` never appears.
    expect(options).toEqual(['Sends to Procore', 'Receives from Procore', 'Syncs both ways']);
    expect(el.textContent).not.toMatch(/a_to_b|b_to_a/);
  });

  it('disables adding entirely when the vocabulary could not be loaded', () => {
    const fixture = create([]);
    expect(text(fixture)).toContain('cannot be added right now');
    expect(button(fixture, 'Add data flow')).toBeNull();
  });

  it('keeps submit disabled until both required choices are made', () => {
    const fixture = create();
    expect(button(fixture, 'Add data flow')?.disabled).toBe(true);

    choose(fixture, 'documents', 'outbound');
    expect(button(fixture, 'Add data flow')?.disabled).toBe(false);
  });

  it('submits the chosen slug and the caller-relative direction', async () => {
    createClaim.mockResolvedValue({ claim: EXISTING });
    const fixture = create();
    choose(fixture, 'documents', 'inbound');

    button(fixture, 'Add data flow')!.click();
    await flush();

    expect(createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        integration_id: INTEGRATION.id,
        data_object: 'documents',
        // Never `a_to_b` / `b_to_a`: the wire speaks the caller's frame.
        direction: 'inbound',
      }),
    );
  });
});

describe('VendorAddClaimForm — the duplicate pivot', () => {
  it('pre-empts a local duplicate before any round-trip', () => {
    const fixture = create();
    const duplicate = vi.fn();
    fixture.componentInstance.duplicate.subscribe(duplicate);

    choose(fixture, EXISTING.data_object_slug, EXISTING.direction as 'outbound');

    // Submit is replaced, not merely disabled: a dead button with no explanation
    // is the dead end this whole path exists to avoid.
    expect(button(fixture, 'Add data flow')).toBeNull();
    expect(text(fixture)).toContain('already have');

    button(fixture, 'Go to the existing')!.click();
    expect(duplicate).toHaveBeenCalledWith({
      claimId: EXISTING.id,
      dataObjectName: EXISTING.data_object_name,
    });
    expect(createClaim).not.toHaveBeenCalled();
  });

  it('pivots on the 400 backstop when the local list is stale', async () => {
    createClaim.mockRejectedValue(duplicateError(EXISTING.id));
    // An empty local list, so pre-emption cannot fire and the server has to.
    const fixture = create(VENDOR_DATA_OBJECTS_FIXTURE, []);
    const duplicate = vi.fn();
    fixture.componentInstance.duplicate.subscribe(duplicate);

    choose(fixture, 'rfis', 'outbound');
    button(fixture, 'Add data flow')!.click();
    await flush();
    fixture.detectChanges();

    expect(duplicate).toHaveBeenCalledWith({ claimId: EXISTING.id, dataObjectName: 'RFIs' });
    // Routed, not dead-ended: no error is shown.
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).toBeNull();
  });

  it('does NOT pivot on a data_object error that carries no claim_id', async () => {
    // The guard against an over-broad catch. An unknown term is a different
    // problem with a different remedy, and pivoting would send the vendor to a
    // lane that does not exist.
    createClaim.mockRejectedValue(
      new HttpErrorResponse({
        status: 400,
        error: {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Unknown data object "widgets"',
            field: 'data_object',
          },
          trace_id: 't',
        },
      }),
    );
    const fixture = create(VENDOR_DATA_OBJECTS_FIXTURE, []);
    const duplicate = vi.fn();
    fixture.componentInstance.duplicate.subscribe(duplicate);

    choose(fixture, 'documents', 'outbound');
    button(fixture, 'Add data flow')!.click();
    await flush();
    fixture.detectChanges();

    expect(duplicate).not.toHaveBeenCalled();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent,
    ).toContain('not on the AEC Integrations list');
  });

  it('keeps the vendor’s input after a duplicate so they can see what they tried', async () => {
    createClaim.mockRejectedValue(duplicateError(EXISTING.id));
    const fixture = create(VENDOR_DATA_OBJECTS_FIXTURE, []);
    choose(fixture, 'rfis', 'outbound');
    button(fixture, 'Add data flow')!.click();
    await flush();
    fixture.detectChanges();

    const trigger = (fixture.nativeElement as HTMLElement).querySelector('[role="combobox"]');
    expect(trigger?.textContent).toContain('RFIs');
  });
});

describe('VendorAddClaimForm — failures and copy', () => {
  it('surfaces a 403 as a verification message, never a ranking one', async () => {
    createClaim.mockRejectedValue(
      new HttpErrorResponse({
        status: 403,
        error: { error: { code: 'FORBIDDEN', message: 'nope' }, trace_id: 't' },
      }),
    );
    const fixture = create();
    choose(fixture, 'documents', 'outbound');
    button(fixture, 'Add data flow')!.click();
    await flush();
    fixture.detectChanges();

    const message =
      (fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')?.textContent ?? '';
    expect(message).toContain('verified account');
    expect(message).not.toMatch(/rank|placement/i);
  });

  it('never promises instant search', () => {
    // §5.2 / STAGE_2_SPEC §8.3(5): vendor edits reach Algolia on the nightly
    // sync, so the hint says "within a day" and nothing says "live in search".
    const body = text(create());
    expect(body).toContain('within a day');
    expect(body).not.toMatch(/instantly|immediately in search|live in search/i);
    expect(body).not.toMatch(/rank|placement/i);
  });

  it('clears the form and emits the new claim on success', async () => {
    const fresh: VendorClaim = { ...EXISTING, id: 'new-claim', data_object_slug: 'documents' };
    createClaim.mockResolvedValue({ claim: fresh });
    const fixture = create(VENDOR_DATA_OBJECTS_FIXTURE, []);
    const created = vi.fn();
    fixture.componentInstance.created.subscribe(created);

    choose(fixture, 'documents', 'outbound');
    button(fixture, 'Add data flow')!.click();
    await flush();
    fixture.detectChanges();

    expect(created).toHaveBeenCalledWith(fresh);
    expect(button(fixture, 'Add data flow')?.disabled).toBe(true);
  });
});
