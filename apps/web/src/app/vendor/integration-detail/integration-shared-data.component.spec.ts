/**
 * AECI-1151 — "Data that's shared" (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.4).
 *
 * What these pin:
 *   1. Yes saves at once, optimistic, re-sending the caller's version stamps, and
 *      rolls back with a visible error on failure.
 *   2. No opens the reason form; an empty reason is refused before anything is
 *      sent; the reason is the stored note, verbatim.
 *   3. "The direction is wrong" is two writes in order: the No with its reason,
 *      then the corrected row with no note.
 *   4. Pressing the pressed button clears the answer.
 *   5. Add a row: the note, the audience helper text, a duplicate focuses the row.
 *   6. A connector-powered row, and a caller without access, are read-only.
 *   7. The answer lock (AECI-1246): an answered row shows plain text and Change;
 *      Change reveals the toggles; a save or Escape puts the row back.
 *   8. A submitted change (AECI-1246): the correction folds into a box under the
 *      denied row, with Change and Cancel.
 */
import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VendorClaim } from '@aeci/shared';

import {
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorPortalStore } from '../vendor-portal-store';

import {
  apiError,
  buttonNamed,
  el,
  makeApi,
  mount,
  settle,
  setup,
  text,
} from './integration-detail-testing.harness';
import { IntegrationDetailState } from './integration-detail-state';
import { IntegrationSharedData } from './integration-shared-data';

afterEach(() => vi.restoreAllMocks());

/** Binds the section to the page state's live integration, as the page does, so a
 *  write re-renders the table without a manual refresh. */
@Component({
  imports: [IntegrationSharedData],
  template: `@if (state.integration(); as i) {
    <aec-integration-shared-data [integration]="i" />
  }`,
})
class LiveHost {
  protected readonly state = inject(IntegrationDetailState);
}

async function mountLive() {
  const fixture = TestBed.createComponent(LiveHost);
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  await settle(fixture);
  return fixture;
}

const PROCORE = INTEGRATION_PROCORE_DETAIL;
const claim = (slug: string): VendorClaim =>
  PROCORE.claims.find((c) => c.data_object_slug === slug)!;

function echo(base: VendorClaim, asserted: boolean, note: string | null): VendorClaim {
  return {
    ...base,
    agreement: 'single_source',
    mine: [
      {
        slot: 'vendor_a',
        asserted,
        note,
        introduced_version_id: null,
        deprecated_version_id: null,
        updated_at: '2026-09-28T00:00:00.000Z',
      },
    ],
  };
}

const testid = (id: string) => `[data-testid="${id}"]`;

describe('Yes and No', () => {
  it('saves Yes at once and re-sends the version stamps', async () => {
    const api = makeApi([PROCORE]);
    const models = claim('models');
    api.upsertAttestation.mockResolvedValue({ claim: echo(models, true, null) });
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);

    el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.click();
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledWith(
      models.id,
      { asserted: true, note: null, introduced_version_id: null, deprecated_version_id: null },
      PROCORE.context_product.id,
    );
  });

  it('never carries a saved No reason onto a one-click Yes', async () => {
    const api = makeApi([PROCORE]);
    const saidNo = {
      ...claim('models'),
      mine: [
        {
          slot: 'vendor_a' as const,
          asserted: false,
          note: 'We never send models.',
          introduced_version_id: null,
          deprecated_version_id: null,
          updated_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    };
    const integration = { ...PROCORE, claims: [saidNo] };
    api.getIntegrations.mockResolvedValue({ integrations: [integration], owned: [] });
    api.upsertAttestation.mockResolvedValue({ claim: echo(saidNo, true, null) });
    await setup(api, integration);
    const fixture = await mount(IntegrationSharedData, integration);
    el(fixture).querySelector<HTMLButtonElement>(testid('change-models'))!.click();
    await settle(fixture);
    el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.click();
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledWith(
      saidNo.id,
      expect.objectContaining({ asserted: true, note: null }),
      PROCORE.context_product.id,
    );
  });

  it('reads no change requests again for a local optimistic Yes (§6.17.6)', async () => {
    const api = makeApi([PROCORE]);
    api.upsertAttestation.mockResolvedValue({ claim: echo(claim('models'), true, null) });
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    const before = api.getContests.mock.calls.length;
    el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.click();
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledTimes(1);
    expect(api.getContests.mock.calls.length).toBe(before);
  });

  it('reads change requests again when a server read of the list lands', async () => {
    const api = makeApi([PROCORE]);
    const { store } = await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    const before = api.getContests.mock.calls.length;
    await store.revalidate(['integrations']);
    await settle(fixture);
    expect(api.getContests.mock.calls.length).toBeGreaterThan(before);
  });

  it('rolls a failed Yes back and says so beside the row', async () => {
    const api = makeApi([PROCORE]);
    api.upsertAttestation.mockRejectedValue(apiError(500, 'INTERNAL'));
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.click();
    await settle(fixture);
    const store = TestBed.inject(VendorPortalStore);
    const models = store.integrations()[0]!.claims.find((c) => c.data_object_slug === 'models')!;
    expect(models.mine).toEqual([]);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain(
      'Could not save your answer',
    );
  });

  it('opens the reason form on No and refuses an empty reason before sending', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    el(fixture).querySelector<HTMLButtonElement>(testid('no-models'))!.click();
    await settle(fixture);
    expect(text(fixture)).toContain("What's wrong?");
    expect(text(fixture)).toContain('Only Procore Technologies and AEC Integrations see this.');
    expect(el(fixture).querySelector(testid('versions-soon'))?.textContent).toContain(
      'coming soon',
    );

    el(fixture)
      .querySelector<HTMLFormElement>(testid('answer-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.upsertAttestation).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Give a reason');
  });

  it('saves a No with its reason verbatim', async () => {
    const api = makeApi([PROCORE]);
    const models = claim('models');
    api.upsertAttestation.mockResolvedValue({
      claim: echo(models, false, 'We never send models.'),
    });
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    el(fixture).querySelector<HTMLButtonElement>(testid('no-models'))!.click();
    await settle(fixture);
    const note = el(fixture).querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = 'We never send models.';
    note.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(testid('answer-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledWith(
      models.id,
      expect.objectContaining({ asserted: false, note: 'We never send models.' }),
      PROCORE.context_product.id,
    );
    expect(el(fixture).querySelector(testid('answer-form'))).toBeNull();
  });

  it('turns "the direction is wrong" into a No, then the corrected row', async () => {
    const api = makeApi([PROCORE]);
    const models = claim('models');
    api.upsertAttestation.mockResolvedValue({ claim: echo(models, false, 'Wrong way.') });
    api.createClaim.mockResolvedValue({
      claim: { ...echo(models, true, null), id: 'new-claim', direction: 'inbound' },
    });
    await setup(api, PROCORE);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await mount(IntegrationSharedData, PROCORE);
    el(fixture).querySelector<HTMLButtonElement>(testid('no-models'))!.click();
    await settle(fixture);
    el(fixture).querySelector<HTMLInputElement>('input[type="radio"][value="direction"]')!.click();
    await settle(fixture);
    const note = el(fixture).querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = 'Wrong way.';
    note.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(testid('answer-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledTimes(1);
    expect(api.createClaim).toHaveBeenCalledWith({
      integration_id: PROCORE.id,
      data_object: 'models',
      direction: 'inbound',
      context_product_id: PROCORE.context_product.id,
      note: null,
    });
    expect(api.upsertAttestation.mock.invocationCallOrder[0]!).toBeLessThan(
      api.createClaim.mock.invocationCallOrder[0]!,
    );
    expect(announce).toHaveBeenLastCalledWith(
      expect.stringContaining('you said the direction is wrong and added the corrected row'),
    );
  });

  it('offers a retry when the corrected row fails after the No saved', async () => {
    const api = makeApi([PROCORE]);
    const models = claim('models');
    api.upsertAttestation.mockResolvedValue({ claim: echo(models, false, 'Wrong way.') });
    api.createClaim.mockRejectedValue(apiError(500, 'INTERNAL'));
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    el(fixture).querySelector<HTMLButtonElement>(testid('no-models'))!.click();
    await settle(fixture);
    el(fixture).querySelector<HTMLInputElement>('input[type="radio"][value="direction"]')!.click();
    await settle(fixture);
    const note = el(fixture).querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = 'Wrong way.';
    note.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(testid('answer-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(text(fixture)).toContain('Your No was saved. The corrected row was not added.');
    expect(buttonNamed(fixture, 'Add the corrected row')).toBeTruthy();
  });

  it('clears the answer when the pressed button is pressed again, through Change', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    expect(el(fixture).querySelector(testid('yes-submittals'))).toBeNull();
    el(fixture).querySelector<HTMLButtonElement>(testid('change-submittals'))!.click();
    await settle(fixture);
    const yes = el(fixture).querySelector<HTMLButtonElement>(testid('yes-submittals'))!;
    expect(yes.getAttribute('aria-pressed')).toBe('true');
    yes.click();
    await settle(fixture);
    expect(api.retractAttestation).toHaveBeenCalledWith(claim('submittals').id);
  });

  it('opens a note form for Yes when the other company said No', async () => {
    const api = makeApi([PROCORE]);
    const theyNo = { ...claim('models'), counterparty: { asserted: false, note: 'Not us.' } };
    const integration = { ...PROCORE, claims: [theyNo] };
    api.getIntegrations.mockResolvedValue({ integrations: [integration], owned: [] });
    await setup(api, integration);
    const fixture = await mount(IntegrationSharedData, integration);
    el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.click();
    await settle(fixture);
    expect(api.upsertAttestation).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('A note with your answer');
  });
});

describe('the table', () => {
  it('is a captioned table with row headers and labelled answer groups', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    expect(el(fixture).querySelector('caption')?.textContent).toContain(
      'Data that is shared between Summit Model Coordination and Procore',
    );
    expect(el(fixture).querySelectorAll('th[scope="row"]')).toHaveLength(PROCORE.claims.length);
    const group = el(fixture).querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-label')).toBe('Your answer: Models are sent to Procore');
    expect(group.querySelector('button')!.getAttribute('aria-label')).toBe('Yes, this is right');
  });

  it('flags a disputed row and shows the reasons in the status tooltip text', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    const row = el(fixture).querySelector(testid('data-row-drawings'))!;
    expect(row.textContent).toContain('Disputed');
    expect(row.querySelector('button[aria-label="Open disagreement on Drawings"]')).not.toBeNull();
    expect(row.textContent).toContain('Your reason: Sheets sync both ways');
    expect(row.textContent).toContain('reason: We do not ingest sheets from this tool.');
  });
});

describe('adding a row', () => {
  it('adds with a private note and says who sees it', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    const added = {
      ...INTEGRATION_OWNED_CLAIMED.claims[0]!,
      id: 'added',
      data_object_slug: 'drawings',
      data_object_name: 'Drawings',
    };
    api.createClaim.mockResolvedValue({ claim: added });
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationSharedData, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('add-row'))!.click();
    await settle(fixture);
    expect(text(fixture)).toContain('Only Trimble and AEC Integrations see this.');
    expect(text(fixture)).toContain(
      'shows publicly as "Confirmed by Summit BIM" until Trimble answers',
    );
    const note = el(fixture).querySelector<HTMLTextAreaElement>('#data-shared-add-note')!;
    note.value = 'Sheets too.';
    note.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(testid('add-row-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        integration_id: INTEGRATION_OWNED_CLAIMED.id,
        note: 'Sheets too.',
        context_product_id: INTEGRATION_OWNED_CLAIMED.context_product.id,
      }),
    );
  });

  it('cases the fallback name by its place in the sentence when no company is named', async () => {
    const unnamed = { ...INTEGRATION_OWNED_CLAIMED, endpoint_vendors: [] };
    const api = makeApi([unnamed]);
    await setup(api, unnamed);
    const fixture = await mount(IntegrationSharedData, unnamed);
    el(fixture).querySelector<HTMLButtonElement>(testid('add-row'))!.click();
    await settle(fixture);
    expect(text(fixture)).toContain(
      'until the other company answers. The other company is asked to confirm it.',
    );
    expect(text(fixture)).toContain('Note for the other company');
    expect(text(fixture)).not.toContain('until The other company');
  });

  it('closes on a duplicate and says the row is already listed', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.createClaim.mockRejectedValue(
      apiError(400, 'VALIDATION_FAILED', { claim_id: INTEGRATION_OWNED_CLAIMED.claims[0]!.id }),
    );
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await mount(IntegrationSharedData, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('add-row'))!.click();
    await settle(fixture);
    el(fixture)
      .querySelector<HTMLFormElement>(testid('add-row-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(el(fixture).querySelector(testid('add-row-form'))).toBeNull();
    expect(announce).toHaveBeenCalledWith(expect.stringContaining('already listed'));
  });
});

describe('read-only rows', () => {
  it('a connector-powered row answers "Not needed" and offers no add', async () => {
    const connector = VENDOR_INTEGRATIONS_FIXTURE.integrations[4]!;
    const api = makeApi([connector]);
    await setup(api, connector);
    const fixture = await mount(IntegrationSharedData, connector);
    expect(text(fixture)).toContain('Not needed');
    expect(text(fixture)).toContain('so neither company answers for them');
    expect(el(fixture).querySelector(testid('add-row'))).toBeNull();
    expect(el(fixture).querySelector('[role="group"]')).toBeNull();
  });

  it('without access, every answer is disabled and the access sentence shows', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE, VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    expect(text(fixture)).toContain('opens up with active vendor access');
    for (const b of el(fixture).querySelectorAll<HTMLButtonElement>('[role="group"] button')) {
      expect(b.disabled).toBe(true);
    }
    expect(el(fixture).querySelector(testid('add-row'))).toBeNull();
  });

  it('a retired row lets a pressed answer be cleared and nothing else', async () => {
    const retired = {
      ...PROCORE,
      retired_at: '2026-09-20T00:00:00.000Z',
      retired_by: 'owner' as const,
    };
    const api = makeApi([retired]);
    await setup(api, retired);
    const fixture = await mount(IntegrationSharedData, retired);
    el(fixture).querySelector<HTMLButtonElement>(testid('change-submittals'))!.click();
    await settle(fixture);
    expect(el(fixture).querySelector<HTMLButtonElement>(testid('yes-submittals'))!.disabled).toBe(
      false,
    );
    expect(el(fixture).querySelector<HTMLButtonElement>(testid('no-submittals'))!.disabled).toBe(
      true,
    );
    expect(el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.disabled).toBe(true);
  });
});

describe('the answer lock (AECI-1246)', () => {
  it('an answered row shows its answer as text and a Change link; an unanswered row keeps the toggles', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    expect(el(fixture).querySelector(testid('answer-submittals'))?.textContent).toContain('Yes');
    const change = el(fixture).querySelector<HTMLButtonElement>(testid('change-submittals'))!;
    expect(change.textContent?.trim()).toBe('Change');
    expect(change.getAttribute('aria-label')).toBe(
      'Change your answer: Submittals come from Procore',
    );
    expect(el(fixture).querySelector(testid('yes-submittals'))).toBeNull();
    expect(el(fixture).querySelector(testid('yes-models'))).not.toBeNull();
    expect(el(fixture).querySelector(testid('change-models'))).toBeNull();
  });

  it('Change reveals the toggles and focuses the pressed one; Escape puts the row back', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mountLive();
    el(fixture).querySelector<HTMLButtonElement>(testid('change-submittals'))!.click();
    await settle(fixture);
    const yes = el(fixture).querySelector<HTMLButtonElement>(testid('yes-submittals'))!;
    expect(yes.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(yes);
    // Only that row opened.
    expect(el(fixture).querySelector(testid('yes-rfis'))).toBeNull();

    yes.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle(fixture);
    expect(el(fixture).querySelector(testid('yes-submittals'))).toBeNull();
    expect(document.activeElement).toBe(el(fixture).querySelector(testid('change-submittals')));
    expect(api.upsertAttestation).not.toHaveBeenCalled();
    el(fixture).remove();
  });

  it('a one-click Yes on an unanswered row lands as text, with focus on Change', async () => {
    const api = makeApi([PROCORE]);
    api.upsertAttestation.mockResolvedValue({ claim: echo(claim('models'), true, null) });
    await setup(api, PROCORE);
    const fixture = await mountLive();
    el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.click();
    await settle(fixture);
    expect(el(fixture).querySelector(testid('yes-models'))).toBeNull();
    expect(document.activeElement).toBe(el(fixture).querySelector(testid('change-models')));
    el(fixture).remove();
  });

  it('saving a No through Change puts the row back to text', async () => {
    const api = makeApi([PROCORE]);
    const submittals = claim('submittals');
    api.upsertAttestation.mockResolvedValue({
      claim: echo(submittals, false, 'Not any more.'),
    });
    await setup(api, PROCORE);
    const fixture = await mountLive();
    el(fixture).querySelector<HTMLButtonElement>(testid('change-submittals'))!.click();
    await settle(fixture);
    el(fixture).querySelector<HTMLButtonElement>(testid('no-submittals'))!.click();
    await settle(fixture);
    const note = el(fixture).querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = 'Not any more.';
    note.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(testid('answer-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(el(fixture).querySelector(testid('answer-submittals'))?.textContent).toContain('No');
    expect(el(fixture).querySelector(testid('no-submittals'))).toBeNull();
    el(fixture).remove();
  });

  it('without access an answered row offers no Change', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE, VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
    expect(el(fixture).querySelector(testid('answer-submittals'))).not.toBeNull();
    expect(el(fixture).querySelector(testid('change-submittals'))).toBeNull();
  });
});

describe('a submitted change (AECI-1246)', () => {
  const own = (asserted: boolean, note: string | null = null) => [
    {
      slot: 'vendor_a' as const,
      asserted,
      note,
      introduced_version_id: null,
      deprecated_version_id: null,
      updated_at: '2026-10-01T00:00:00.000Z',
    },
  ];
  const DENIED: VendorClaim = {
    ...claim('models'),
    id: 'denied-docs',
    data_object_slug: 'documents',
    data_object_name: 'Documents',
    direction: 'outbound',
    agreement: 'single_source',
    mine: own(false, 'They go both ways.'),
    counterparty: null,
    added_by: null,
    disagreement: null,
  };
  const CORRECTION: VendorClaim = {
    ...DENIED,
    id: 'corrected-docs',
    direction: 'both',
    mine: own(true),
    added_by: 'you',
  };
  const withPair = (correction: VendorClaim = CORRECTION, extra: VendorClaim[] = []) => ({
    ...PROCORE,
    claims: [claim('models'), DENIED, correction, ...extra],
  });

  async function mountPair(integration = withPair()) {
    const api = makeApi([integration]);
    api.getIntegrations.mockResolvedValue({ integrations: [integration], owned: [] });
    await setup(api, integration);
    const fixture = await mountLive();
    return { api, fixture, integration };
  }

  afterEach(() => document.body.replaceChildren());

  it('folds the correction into a box under the denied row', async () => {
    const { fixture } = await mountPair();
    expect(el(fixture).querySelectorAll('th[scope="row"]')).toHaveLength(2);
    expect(el(fixture).querySelector('h3')?.textContent).toContain("Data that's shared (2)");
    const box = el(fixture).querySelector(testid('change-box-documents'))!;
    // The box is the row right after the denied row.
    expect(el(fixture).querySelector(testid('data-row-documents'))!.nextElementSibling).toBe(box);
    const cell = box.querySelector('td')!;
    expect(cell.getAttribute('colspan')).toBe('4');
    expect(cell.id).toBe('change-denied-docs');
    expect(cell.getAttribute('tabindex')).toBe('-1');
    expect(cell.classList).toContain('id-change-box');
    expect(box.textContent).toContain('You submitted a change');
    expect(box.textContent).toContain('Documents: To Procore becomes Both ways');
    expect(box.textContent).toContain('Your reason: They go both ways.');
    expect(box.textContent).toContain('Procore Technologies has not answered yet.');
    expect(box.querySelector(testid('change-box-change-documents'))).not.toBeNull();
    expect(box.querySelector(testid('change-box-cancel-documents'))).not.toBeNull();
  });

  it('the denied row reads "No" as text with no Change, and its pill says "Change submitted"', async () => {
    const { fixture } = await mountPair();
    const row = el(fixture).querySelector(testid('data-row-documents'))!;
    expect(row.querySelector(testid('answer-documents'))?.textContent).toContain('No');
    expect(row.querySelector(testid('change-documents'))).toBeNull();
    expect(row.querySelector('[role="group"]')).toBeNull();
    expect(row.textContent).toContain('Change submitted');
    expect(row.textContent).not.toContain('You said this is wrong');
  });

  it('says when the other company agrees, and when it disagrees with the flag', async () => {
    const agrees = await mountPair(
      withPair({
        ...CORRECTION,
        agreement: 'confirmed',
        counterparty: { asserted: true, note: null },
      }),
    );
    expect(text(agrees.fixture)).toContain('Procore Technologies agrees.');

    const disputed = {
      ...CORRECTION,
      agreement: 'conflict' as const,
      counterparty: { asserted: false, note: 'Only one way.' },
      disagreement: { id: CORRECTION.id, raised_at: '2026-10-02T00:00:00.000Z' },
    };
    const disagrees = await mountPair(withPair(disputed));
    const line = el(disagrees.fixture).querySelector(testid('change-answer-documents'))!;
    expect(line.textContent).toContain('Procore Technologies disagrees.');
    expect(line.textContent).toContain('Only one way.');
    expect(
      line.querySelector('button[aria-label="Open disagreement on Documents"]'),
    ).not.toBeNull();
  });

  it('shows no answer line when the caller holds both endpoints', async () => {
    const both = { ...withPair(), slots: ['vendor_a', 'vendor_b'] as ('vendor_a' | 'vendor_b')[] };
    const { fixture } = await mountPair(both);
    expect(el(fixture).querySelector(testid('change-box-documents'))).not.toBeNull();
    expect(el(fixture).querySelector(testid('change-answer-documents'))).toBeNull();
  });

  it('two candidate corrections mean no box, and every row renders', async () => {
    const second = { ...CORRECTION, id: 'corrected-docs-2', direction: 'inbound' as const };
    const { fixture } = await mountPair(withPair(CORRECTION, [second]));
    expect(el(fixture).querySelector(testid('change-box-documents'))).toBeNull();
    expect(el(fixture).querySelectorAll('th[scope="row"]')).toHaveLength(4);
  });

  it('Cancel withdraws the Yes on the correction, then the No, with one announcement', async () => {
    const { api, fixture, integration } = await mountPair();
    const cleared = {
      ...integration,
      claims: integration.claims.map((c) =>
        c.id === DENIED.id || c.id === CORRECTION.id ? { ...c, mine: [] } : c,
      ),
    };
    api.getIntegrations.mockResolvedValue({ integrations: [cleared], owned: [] });
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    el(fixture).querySelector<HTMLButtonElement>(testid('change-box-cancel-documents'))!.click();
    await settle(fixture, 6);
    expect(api.retractAttestation.mock.calls.map((c) => c[0])).toEqual([CORRECTION.id, DENIED.id]);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith(
      'Documents: your change is cancelled and your answers are cleared.',
    );
    expect(el(fixture).querySelector(testid('change-box-documents'))).toBeNull();
    const row = el(fixture).querySelector(testid('data-row-documents'))!;
    expect(row.textContent).toContain('Needs your answer');
    expect(row.querySelector('[role="group"]')).not.toBeNull();
  });

  async function openChange() {
    const ctx = await mountPair();
    el(ctx.fixture)
      .querySelector<HTMLButtonElement>(testid('change-box-change-documents'))!
      .click();
    await settle(ctx.fixture);
    return ctx;
  }

  function submit(fixture: Parameters<typeof el>[0]) {
    el(fixture)
      .querySelector<HTMLFormElement>(testid('answer-form'))!
      .dispatchEvent(new Event('submit'));
  }

  it('Change opens the reason form in the box, prefilled', async () => {
    const { fixture } = await openChange();
    const box = el(fixture).querySelector(testid('change-box-documents'))!;
    const form = box.querySelector(testid('answer-form'))!;
    expect(form).not.toBeNull();
    expect(form.querySelector<HTMLInputElement>('input[value="direction"]')!.checked).toBe(true);
    expect((form.querySelector('select') as HTMLSelectElement).value).toBe('both');
    expect(form.querySelector<HTMLTextAreaElement>('textarea')!.value).toBe('They go both ways.');
    expect(
      box.querySelector(testid('change-box-change-documents'))!.getAttribute('aria-expanded'),
    ).toBe('true');
  });

  it('the same direction re-saves the No with the new reason, and nothing else', async () => {
    const { api, fixture } = await openChange();
    api.upsertAttestation.mockResolvedValue({ claim: { ...DENIED, mine: own(false, 'Both.') } });
    const note = el(fixture).querySelector<HTMLTextAreaElement>('textarea')!;
    note.value = 'Both.';
    note.dispatchEvent(new Event('input'));
    submit(fixture);
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledTimes(1);
    expect(api.upsertAttestation).toHaveBeenCalledWith(
      DENIED.id,
      expect.objectContaining({ asserted: false, note: 'Both.' }),
      PROCORE.context_product.id,
    );
    expect(api.retractAttestation).not.toHaveBeenCalled();
    expect(api.createClaim).not.toHaveBeenCalled();
  });

  it('a new direction withdraws the Yes on the correction, then adds the new one', async () => {
    const { api, fixture } = await openChange();
    api.upsertAttestation.mockResolvedValue({ claim: DENIED });
    api.createClaim.mockResolvedValue({
      claim: { ...CORRECTION, id: 'corrected-docs-in', direction: 'inbound' },
    });
    const select = el(fixture).querySelector('select') as HTMLSelectElement;
    select.value = 'inbound';
    select.dispatchEvent(new Event('change'));
    submit(fixture);
    await settle(fixture, 6);
    expect(api.retractAttestation).toHaveBeenCalledWith(CORRECTION.id);
    expect(api.createClaim).toHaveBeenCalledWith(
      expect.objectContaining({ data_object: 'documents', direction: 'inbound', note: null }),
    );
    const order = [
      api.retractAttestation.mock.invocationCallOrder[0]!,
      api.upsertAttestation.mock.invocationCallOrder[0]!,
      api.createClaim.mock.invocationCallOrder[0]!,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('another "what\'s wrong" withdraws the Yes on the correction and saves the No alone', async () => {
    const { api, fixture } = await openChange();
    api.upsertAttestation.mockResolvedValue({ claim: DENIED });
    el(fixture).querySelector<HTMLInputElement>('input[value="not-shared"]')!.click();
    await settle(fixture);
    submit(fixture);
    await settle(fixture, 6);
    expect(api.retractAttestation).toHaveBeenCalledWith(CORRECTION.id);
    expect(api.upsertAttestation).toHaveBeenCalledWith(
      DENIED.id,
      expect.objectContaining({ asserted: false, note: 'They go both ways.' }),
      PROCORE.context_product.id,
    );
    expect(api.createClaim).not.toHaveBeenCalled();
  });
});
