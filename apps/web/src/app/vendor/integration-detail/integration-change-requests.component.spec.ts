/**
 * AECI-1153 — "Change requests" (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.6).
 *
 * What these pin: the merged Open list (received, added by the other company,
 * disagreement, added by the caller, submitted), each kind's copy and actions;
 * the collapsed history with its dated rail; search and the All / Open / Closed
 * filter; Accept and Decline with a note; Withdraw behind an inline confirmation;
 * the request form's fields, its no-20-character-floor reason, and its send.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { VendorContest } from '@aeci/shared';

import {
  CONTEST_RECEIVED_CLOSED_ON_OWNED,
  CONTEST_RECEIVED_ON_OWNED,
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_CONTESTS_FIXTURE,
} from '../vendor-fixtures';

import { IntegrationChangeRequests } from './integration-change-requests';
import {
  buttonNamed,
  el,
  makeApi,
  mount,
  settle,
  setup,
  text,
} from './integration-detail-testing.harness';

afterEach(() => vi.restoreAllMocks());

const testid = (id: string) => `[data-testid="${id}"]`;
const PROCORE_CONTESTS = {
  submitted: VENDOR_CONTESTS_FIXTURE.submitted.filter(
    (c) => c.integration_id === INTEGRATION_PROCORE_DETAIL.id,
  ),
  received: [],
};
const OWNED_CONTESTS = {
  submitted: [],
  received: [CONTEST_RECEIVED_ON_OWNED, CONTEST_RECEIVED_CLOSED_ON_OWNED],
};

describe('the Open list', () => {
  it('merges the added row, the disagreement, the caller’s added row and its request, in order', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    const kinds = [
      ...el(fixture).querySelectorAll(`${testid('requests-open')} li[data-testid]`),
    ].map((li) => li.getAttribute('data-testid'));
    expect(kinds).toEqual([
      'request-item-added-them',
      'request-item-disagreement',
      'request-item-added-you',
      'request-item-submitted',
    ]);
    expect(text(fixture)).toContain('Procore Technologies added Documents. Is this right?');
    expect(text(fixture)).toContain(
      'Until you answer, the public page shows it as "Confirmed by Procore Technologies".',
    );
    expect(text(fixture)).toContain('Disagreement · raised Sep 12, 2026');
    expect(text(fixture)).toContain('Drawings: you say Yes, Procore Technologies says No');
    expect(text(fixture)).toContain('Replies coming soon');
    // §6.2's conflict sentence verbatim, and no dated review promise.
    expect(text(fixture)).toContain('If neither position changes within');
    expect(text(fixture)).not.toContain('reviews it on');
  });

  it('answers an added row Yes from the item', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    const documents = INTEGRATION_PROCORE_DETAIL.claims.find((c) => c.added_by === 'counterpart')!;
    api.upsertAttestation.mockResolvedValue({ claim: { ...documents, mine: [] } });
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`added-yes-${documents.id}`))!
      .click();
    await settle(fixture);
    expect(api.upsertAttestation).toHaveBeenCalledWith(
      documents.id,
      expect.objectContaining({ asserted: true }),
      INTEGRATION_PROCORE_DETAIL.context_product.id,
    );
  });

  it('opens the reason form in a disagreement to change the answer to No', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    const drawings = INTEGRATION_PROCORE_DETAIL.claims.find((c) => c.agreement === 'conflict')!;
    const change = el(fixture).querySelector<HTMLButtonElement>(
      testid(`change-answer-${drawings.id}`),
    )!;
    expect(change.textContent?.trim()).toBe('Change my answer to No');
    change.click();
    await settle(fixture);
    expect(text(fixture)).toContain('Why is this wrong?');
    expect(buttonNamed(fixture, /Edit my reason/)).toBeUndefined();
  });

  it('lets the owner accept or decline a received request with a note', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED], OWNED_CONTESTS);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_OWNED_CLAIMED);
    expect(text(fixture)).toContain('Change request from Trimble · sent Sep 22, 2026');
    expect(text(fixture)).toContain('Release stage: from Beta to Generally available');
    expect(text(fixture)).toContain('You own this integration.');
    const note = el(fixture).querySelector<HTMLTextAreaElement>(
      `#request-${CONTEST_RECEIVED_ON_OWNED.id}-note`,
    )!;
    note.value = 'Agreed.';
    note.dispatchEvent(new Event('input'));
    const accept = el(fixture).querySelector<HTMLButtonElement>(
      testid(`accept-${CONTEST_RECEIVED_ON_OWNED.id}`),
    )!;
    expect(accept.textContent).toContain(': Release stage');
    accept.click();
    await settle(fixture);
    expect(api.decideContest).toHaveBeenCalledWith(CONTEST_RECEIVED_ON_OWNED.id, {
      decision: 'accept',
      note: 'Agreed.',
    });
  });

  it('withdraws a submitted request only after an inline confirmation', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    const open = PROCORE_CONTESTS.submitted.find((c) => c.status === 'open')!;
    el(fixture)
      .querySelector<HTMLButtonElement>(testid(`withdraw-${open.id}`))!
      .click();
    await settle(fixture);
    expect(api.withdrawContest).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Withdraw this request? It cannot be reopened.');
    buttonNamed(fixture, 'Yes, withdraw it')!.click();
    await settle(fixture);
    expect(api.withdrawContest).toHaveBeenCalledWith(open.id);
  });
});

describe('the Closed list', () => {
  it('starts collapsed and opens to a dated rail', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED], OWNED_CONTESTS);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_OWNED_CLAIMED);
    const toggle = el(fixture).querySelector<HTMLButtonElement>(
      testid(`closed-toggle-${CONTEST_RECEIVED_CLOSED_ON_OWNED.id}`),
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const body = el(fixture).querySelector<HTMLElement>(
      `#${toggle.getAttribute('aria-controls')}`,
    )!;
    expect(body.hidden).toBe(true);
    toggle.click();
    await settle(fixture);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(body.hidden).toBe(false);
    expect(body.textContent).toContain('Trimble sent it to you.');
    expect(body.textContent).toContain('You accepted it.');
    expect(body.textContent).toContain('Agreed, thank you.');
  });
});

describe('search and filters', () => {
  it('filters both groups by text, and says so when nothing matches', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    const { state } = await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    state.requestQuery.set('disagreement');
    await settle(fixture);
    const kinds = [
      ...el(fixture).querySelectorAll(`${testid('requests-open')} li[data-testid]`),
    ].map((li) => li.getAttribute('data-testid'));
    expect(kinds).toEqual(['request-item-disagreement']);
    expect(text(fixture)).toContain('No closed requests match your search.');
  });

  it('hides Closed under Open, and Open under Closed', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    el(fixture).querySelector<HTMLButtonElement>(testid('requests-filter-open'))!.click();
    await settle(fixture);
    expect(el(fixture).querySelector(testid('requests-closed'))).toBeNull();
    el(fixture).querySelector<HTMLButtonElement>(testid('requests-filter-closed'))!.click();
    await settle(fixture);
    expect(el(fixture).querySelector(testid('requests-open'))).toBeNull();
    expect(
      el(fixture).querySelector(testid('requests-filter-closed'))!.getAttribute('aria-pressed'),
    ).toBe('true');
  });
});

describe('the request form', () => {
  it('offers the fields minus Direction, disables one already asked about, and sends', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    const sent: VendorContest = {
      ...PROCORE_CONTESTS.submitted[0]!,
      id: '00000000-0000-4000-8000-000000009999',
      field: 'mechanism_name',
    };
    api.submitContest.mockResolvedValue({ contest: sent });
    const { state } = await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    el(fixture).querySelector<HTMLButtonElement>(testid('request-correction'))!.click();
    await settle(fixture);
    const select = el(fixture).querySelector('#request-field') as unknown as HTMLSelectElement;
    const values = [...select.options].map((o) => o.value);
    expect(values).not.toContain('direction');
    expect(values).not.toContain('website');
    expect(values).not.toContain('mechanism_url');
    const pricing = [...select.options].find((o) => o.value === 'pricing_model')!;
    expect(pricing.disabled).toBe(true);
    expect(pricing.textContent).toContain('you already asked');

    // Release stage is inside a lost review's cooldown in the fixture.
    expect([...select.options].find((o) => o.value === 'maturity')!.textContent).toContain(
      'not until',
    );
    select.value = 'mechanism_name';
    select.dispatchEvent(new Event('change'));
    await settle(fixture);
    const value = el(fixture).querySelector<HTMLInputElement>('#request-value')!;
    expect(value.value).toBe('Native connector');
    value.value = 'Native connector v2';
    value.dispatchEvent(new Event('input'));
    const reason = el(fixture).querySelector<HTMLTextAreaElement>('#request-reason')!;
    reason.value = 'Short.';
    reason.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(testid('request-form'))!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.submitContest).toHaveBeenCalledWith(INTEGRATION_PROCORE_DETAIL.id, {
      field: 'mechanism_name',
      proposed_value: 'Native connector v2',
      reason: 'Short.',
      context_product_id: INTEGRATION_PROCORE_DETAIL.context_product.id,
    });
    expect(state.requestForm()).toBeNull();
  });

  it('says where a request goes: the claimed owner', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], PROCORE_CONTESTS);
    const { state } = await setup(api, INTEGRATION_PROCORE_DETAIL);
    state.openRequestForm('description');
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_PROCORE_DETAIL);
    expect(text(fixture)).toContain(
      'This goes to Procore Technologies, the owner. If they say no, you can ask AEC Integrations to review it.',
    );
  });

  it('is not offered to the owner', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED], OWNED_CONTESTS);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationChangeRequests, INTEGRATION_OWNED_CLAIMED);
    expect(el(fixture).querySelector(testid('request-correction'))).toBeNull();
  });
});
