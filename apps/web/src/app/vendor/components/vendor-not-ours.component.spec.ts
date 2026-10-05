/**
 * AECI-1225 — "Not ours?" (`STAGE_2_PAID_TIERS_SPEC.md` §13.10,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.2).
 *
 * What these pin:
 *   1. The body is an `owner` contest on the row, with no context product, and
 *      "someone else" is `null` on the wire.
 *   2. A reason is required before any request leaves.
 *   3. Success announces, revalidates contests and refetches a loaded checklist.
 *   4. The state line follows the caller's newest "not ours": open (Withdraw),
 *      accepted, declined (the trigger again). Another vendor's owner contest is
 *      not the caller's "not ours".
 *   5. An API refusal renders as a `role="alert"`.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorContest } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_CONTESTS_FIXTURE, VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { NO_OWNER } from './vendor-contest-form';
import { VendorNotOurs, selfDisclaimOn, selfDisclaimStands } from './vendor-not-ours';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const ROW_ID = '00000000-0000-4000-8000-0000000000aa';
const ME = { id: VENDOR_ME_FIXTURE.vendor.id, name: VENDOR_ME_FIXTURE.vendor.company_name };
const OTHER = { id: '00000000-0000-4000-8000-0000000000bb', name: 'Summit' };

/** A "not ours" the caller filed on ROW_ID. */
function selfDisclaim(extra: Partial<VendorContest> = {}): VendorContest {
  return {
    ...VENDOR_CONTESTS_FIXTURE.submitted[0]!,
    id: '00000000-0000-4000-8000-0000000000cc',
    integration_id: ROW_ID,
    anchor: 'integration',
    field: 'owner',
    current_value: ME.id,
    proposed_value: null,
    routed_to: 'aeci',
    status: 'open',
    submitter_vendor: ME,
    owner_vendor: ME,
    decision_note: null,
    ...extra,
  };
}

let api: {
  getContests: ReturnType<typeof vi.fn>;
  submitContest: ReturnType<typeof vi.fn>;
  withdrawContest: ReturnType<typeof vi.fn>;
  getChecklist: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
    submitContest: vi.fn(),
    withdrawContest: vi.fn(),
    getChecklist: vi.fn().mockResolvedValue({ steps: [], products: [] }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function create(
  otherVendors: readonly { id: string; name: string }[] = [],
): Promise<ComponentFixture<VendorNotOurs>> {
  const fixture = TestBed.createComponent(VendorNotOurs);
  fixture.componentRef.setInput('integrationId', ROW_ID);
  fixture.componentRef.setInput('productA', 'Revit');
  fixture.componentRef.setInput('productB', 'Procore');
  fixture.componentRef.setInput('otherVendors', otherVendors);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const byTestId = (fixture: ComponentFixture<unknown>, id: string) =>
  el(fixture).querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openForm(fixture: ComponentFixture<unknown>): Promise<void> {
  byTestId(fixture, 'not-ours')!.click();
  await settle(fixture);
}

async function typeReason(fixture: ComponentFixture<unknown>, value: string): Promise<void> {
  const node = el(fixture).querySelector<HTMLTextAreaElement>('textarea')!;
  node.value = value;
  node.dispatchEvent(new Event('input'));
  await settle(fixture);
}

async function submit(fixture: ComponentFixture<unknown>): Promise<void> {
  el(fixture).querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
}

describe('selfDisclaimOn', () => {
  it('finds the caller’s own owner contest about itself, and skips a withdrawn one', () => {
    const withdrawn = selfDisclaim({ id: 'w', status: 'withdrawn' });
    const open = selfDisclaim({ id: 'o' });
    expect(selfDisclaimOn([withdrawn, open], ROW_ID, 'integration')?.id).toBe('o');
  });

  it('ignores an owner contest about another vendor', () => {
    const aboutOther = selfDisclaim({ owner_vendor: OTHER, current_value: OTHER.id });
    expect(selfDisclaimOn([aboutOther], ROW_ID, 'integration')).toBeNull();
  });

  it('ignores the same id in the other table', () => {
    expect(selfDisclaimOn([selfDisclaim()], ROW_ID, 'evidenced_pair')).toBeNull();
  });

  it('stands while open or accepted, not once declined', () => {
    expect(selfDisclaimStands(selfDisclaim())).toBe(true);
    expect(selfDisclaimStands(selfDisclaim({ status: 'accepted' }))).toBe(true);
    expect(selfDisclaimStands(selfDisclaim({ status: 'declined' }))).toBe(false);
    expect(selfDisclaimStands(null)).toBe(false);
  });
});

describe('VendorNotOurs', () => {
  it('offers the trigger, collapsed, when nothing is filed', async () => {
    const fixture = await create();
    const trigger = byTestId(fixture, 'not-ours')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toContain('Revit and Procore');
    expect(el(fixture).querySelector('form')).toBeNull();
  });

  it('offers the other endpoint vendors and "someone else", defaulting to someone else', async () => {
    const fixture = await create([OTHER]);
    await openForm(fixture);
    const options = [...el(fixture).querySelectorAll('option')];
    expect(options.map((o) => o.value)).toEqual([OTHER.id, NO_OWNER]);
    expect((el(fixture).querySelector('select') as unknown as HTMLSelectElement).value).toBe(
      NO_OWNER,
    );
  });

  it('refuses an empty reason before any request', async () => {
    const fixture = await create();
    await openForm(fixture);
    await submit(fixture);
    expect(api.submitContest).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'Say why this integration is not yours.',
    );
  });

  it('sends an owner contest with no context product, announces and refetches', async () => {
    const store = TestBed.inject(VendorPortalStore);
    await store.ensureChecklist();
    api.getChecklist.mockClear();
    api.submitContest.mockResolvedValue({ contest: selfDisclaim() });
    const fixture = await create([OTHER]);
    await openForm(fixture);
    await typeReason(fixture, 'We do not offer this.');
    api.getContests.mockResolvedValue({ submitted: [selfDisclaim()], received: [] });
    await submit(fixture);

    expect(api.submitContest).toHaveBeenCalledWith(
      ROW_ID,
      {
        field: 'owner',
        proposed_value: null,
        reason: 'We do not offer this.',
        context_product_id: null,
      },
      'integration',
    );
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toContain('Sent to AEC Integrations');
    expect(api.getChecklist).toHaveBeenCalledTimes(1);
    expect(el(fixture).querySelector('form')).toBeNull();
    expect(byTestId(fixture, 'not-ours-open')).not.toBeNull();
  });

  it('sends the chosen endpoint vendor', async () => {
    api.submitContest.mockResolvedValue({ contest: selfDisclaim() });
    const fixture = await create([OTHER]);
    await openForm(fixture);
    const select = el(fixture).querySelector('select') as unknown as HTMLSelectElement;
    select.value = OTHER.id;
    select.dispatchEvent(new Event('change'));
    await typeReason(fixture, 'Summit offers it.');
    await submit(fixture);
    expect(api.submitContest.mock.calls[0]![1]).toMatchObject({ proposed_value: OTHER.id });
  });

  it('renders a refusal as an alert and keeps the form', async () => {
    api.submitContest.mockRejectedValue(apiError(403, 'CONTEST_OWN_INTEGRATION'));
    const fixture = await create();
    await openForm(fixture);
    await typeReason(fixture, 'Not ours.');
    await submit(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'recorded as the owner',
    );
    expect(el(fixture).querySelector('form')).not.toBeNull();
  });

  it('shows the open state with Withdraw, and withdraws', async () => {
    api.getContests.mockResolvedValue({ submitted: [selfDisclaim()], received: [] });
    api.withdrawContest.mockResolvedValue({ contest: selfDisclaim({ status: 'withdrawn' }) });
    const fixture = await create();
    expect(byTestId(fixture, 'not-ours')).toBeNull();
    api.getContests.mockResolvedValue({
      submitted: [selfDisclaim({ status: 'withdrawn' })],
      received: [],
    });
    byTestId(fixture, 'not-ours-withdraw')!.click();
    await settle(fixture);
    expect(api.withdrawContest).toHaveBeenCalledWith(selfDisclaim().id);
    expect(byTestId(fixture, 'not-ours')).not.toBeNull();
  });

  it('shows the accepted state with nothing to do', async () => {
    api.getContests.mockResolvedValue({
      submitted: [selfDisclaim({ status: 'accepted' })],
      received: [],
    });
    const fixture = await create();
    expect(byTestId(fixture, 'not-ours-accepted')).not.toBeNull();
    expect(byTestId(fixture, 'not-ours')).toBeNull();
  });

  it('shows a decline with its note, and offers the trigger again', async () => {
    api.getContests.mockResolvedValue({
      submitted: [selfDisclaim({ status: 'declined', decision_note: 'Your docs list it.' })],
      received: [],
    });
    const fixture = await create();
    expect(byTestId(fixture, 'not-ours-declined')?.textContent).toContain('Your docs list it.');
    expect(byTestId(fixture, 'not-ours')).not.toBeNull();
  });
});
