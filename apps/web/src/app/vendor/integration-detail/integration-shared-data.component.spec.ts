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
 */
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
import { IntegrationSharedData } from './integration-shared-data';

afterEach(() => vi.restoreAllMocks());

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

  it('clears the answer when the pressed button is pressed again', async () => {
    const api = makeApi([PROCORE]);
    await setup(api, PROCORE);
    const fixture = await mount(IntegrationSharedData, PROCORE);
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
    expect(el(fixture).querySelector<HTMLButtonElement>(testid('yes-submittals'))!.disabled).toBe(
      false,
    );
    expect(el(fixture).querySelector<HTMLButtonElement>(testid('no-submittals'))!.disabled).toBe(
      true,
    );
    expect(el(fixture).querySelector<HTMLButtonElement>(testid('yes-models'))!.disabled).toBe(true);
  });
});
