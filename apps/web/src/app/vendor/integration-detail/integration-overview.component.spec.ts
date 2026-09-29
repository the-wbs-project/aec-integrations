/**
 * AECI-1150 — the Overview (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.3).
 *
 * What these pin: the claimed owner's pencils and the one-field PATCH; the
 * connector-powered row's frozen field; "Claim to edit" and Claim for the recorded
 * owner; "Request a change" for anyone else; the open-request flag in its place
 * (AECI-1143); no Direction row; the Owner row's action; the tooltip's text in the
 * DOM for assistive tech.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTEST_RECEIVED_ON_OWNED,
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_CONTESTS_FIXTURE,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import { IntegrationDetailState } from './integration-detail-state';
import {
  apiError,
  el,
  makeApi,
  mount,
  settle,
  setup,
  text,
} from './integration-detail-testing.harness';
import { IntegrationOverview } from './integration-overview';

afterEach(() => vi.restoreAllMocks());

const testid = (id: string) => `[data-testid="${id}"]`;

describe('the claimed owner', () => {
  it('gets a pencil on every editable row and no Direction row', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationOverview, INTEGRATION_OWNED_CLAIMED);
    for (const key of [
      'name',
      'description',
      'mechanism_kind',
      'mechanism_name',
      'maturity',
      'pricing_model',
      'pricing_url',
    ]) {
      expect(el(fixture).querySelector(testid(`edit-${key}`)), key).not.toBeNull();
    }
    expect(el(fixture).querySelector(testid('overview-row-direction'))).toBeNull();
    expect(text(fixture)).not.toContain('Request a change');
    expect(text(fixture)).toContain('Summit BIM (you)');
  });

  it('saves one field with its context product, then announces and closes', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.updateIntegration.mockResolvedValue({ integration: {} });
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await mount(IntegrationOverview, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('edit-maturity'))!.click();
    await settle(fixture);
    const input = el(fixture).querySelector<HTMLInputElement>(
      `${testid('overview-row-maturity')} input`,
    )!;
    input.value = 'Generally available';
    input.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(`${testid('overview-row-maturity')} form`)!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.updateIntegration).toHaveBeenCalledWith(INTEGRATION_OWNED_CLAIMED.id, {
      maturity: 'Generally available',
      context_product_id: INTEGRATION_OWNED_CLAIMED.context_product.id,
    });
    expect(announce).toHaveBeenCalledWith('Release stage saved. It is live on the public page.');
    expect(el(fixture).querySelector(`${testid('overview-row-maturity')} form`)).toBeNull();
  });

  it('refuses a bad pricing page link before sending', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationOverview, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('edit-pricing_url'))!.click();
    await settle(fixture);
    const input = el(fixture).querySelector<HTMLInputElement>(
      `${testid('overview-row-pricing_url')} input`,
    )!;
    input.value = 'not a link';
    input.dispatchEvent(new Event('input'));
    el(fixture)
      .querySelector<HTMLFormElement>(`${testid('overview-row-pricing_url')} form`)!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(api.updateIntegration).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('full web address');
  });

  it('maps a refusal to its own sentence in an alert', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.updateIntegration.mockRejectedValue(apiError(409, 'INTEGRATION_RETIRED'));
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationOverview, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('edit-name'))!.click();
    await settle(fixture);
    el(fixture)
      .querySelector<HTMLFormElement>(`${testid('overview-row-name')} form`)!
      .dispatchEvent(new Event('submit'));
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('retired');
  });

  it('keeps How you get it frozen on a connector-powered row', async () => {
    const connectorOwned = { ...INTEGRATION_OWNED_CLAIMED, attestable: false };
    const api = makeApi([connectorOwned]);
    await setup(api, connectorOwned);
    const fixture = await mount(IntegrationOverview, connectorOwned);
    expect(el(fixture).querySelector(testid('edit-mechanism_kind'))).toBeNull();
    expect(el(fixture).querySelector(testid('edit-name'))).not.toBeNull();
  });

  it('offers no pencils on a connector-powered row without a plan', async () => {
    const connectorOwned = { ...INTEGRATION_OWNED_CLAIMED, attestable: false };
    const api = makeApi([connectorOwned]);
    await setup(api, connectorOwned, VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await mount(IntegrationOverview, connectorOwned);
    expect(el(fixture).querySelectorAll('[data-testid^="edit-"]')).toHaveLength(0);
    expect(text(fixture)).toContain('needs an active plan');
  });

  it('flags a field with an open received request, and keeps the pencil', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED], {
      submitted: [],
      received: [CONTEST_RECEIVED_ON_OWNED],
    });
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationOverview, INTEGRATION_OWNED_CLAIMED);
    const flag = el(fixture).querySelector<HTMLButtonElement>(testid('flag-maturity'))!;
    expect(flag.getAttribute('aria-label')).toBe('Open change request on Release stage');
    const described = el(fixture).querySelector(`#${flag.getAttribute('aria-describedby')}`)!;
    expect(described.textContent).toContain('from Beta to Generally available');
    expect(described.textContent).not.toMatch(/→/);
  });
});

describe('the recorded owner before its claim', () => {
  it('gets Claim to edit on each row and Claim on the Owner row', async () => {
    const unclaimed = { ...INTEGRATION_OWNED_CLAIMED, claimed_at: null };
    const api = makeApi([unclaimed]);
    await setup(api, unclaimed);
    const fixture = await mount(IntegrationOverview, unclaimed);
    expect(text(fixture)).toContain('Claim to edit');
    expect(el(fixture).querySelector(testid('claim-integration'))).not.toBeNull();
  });

  it('claims, then revalidates the list', async () => {
    const unclaimed = { ...INTEGRATION_OWNED_CLAIMED, claimed_at: null };
    const api = makeApi([unclaimed]);
    await setup(api, unclaimed);
    const fixture = await mount(IntegrationOverview, unclaimed);
    api.getIntegrations.mockClear();
    el(fixture).querySelector<HTMLButtonElement>(testid('claim-integration'))!.click();
    await settle(fixture);
    expect(api.claimIntegration).toHaveBeenCalledWith(unclaimed.id);
    expect(api.getIntegrations).toHaveBeenCalled();
  });
});

describe('anyone else', () => {
  it('gets Request a change on contestable rows, never on the pricing page', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationOverview, INTEGRATION_PROCORE_DETAIL);
    expect(el(fixture).querySelector(testid('request-name'))).not.toBeNull();
    expect(el(fixture).querySelector(testid('request-pricing_url'))).toBeNull();
    expect(el(fixture).querySelectorAll('[data-testid^="edit-"]')).toHaveLength(0);
  });

  it('opens the request form on that field', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    const { state } = await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationOverview, INTEGRATION_PROCORE_DETAIL);
    el(fixture).querySelector<HTMLButtonElement>(testid('request-maturity'))!.click();
    expect(state.requestForm()?.field).toBe('maturity');
  });

  it('shows the flag instead of Request a change when the caller already asked (AECI-1143)', async () => {
    // The fixture's open submitted request is on pricing_model.
    const api = makeApi([INTEGRATION_PROCORE_DETAIL], {
      submitted: VENDOR_CONTESTS_FIXTURE.submitted.filter(
        (c) => c.integration_id === INTEGRATION_PROCORE_DETAIL.id,
      ),
      received: [],
    });
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationOverview, INTEGRATION_PROCORE_DETAIL);
    expect(el(fixture).querySelector(testid('flag-pricing_model'))).not.toBeNull();
    expect(el(fixture).querySelector(testid('request-pricing_model'))).toBeNull();
  });

  it('asks to be recorded as the owner when nobody is, and never twice', async () => {
    const both = VENDOR_INTEGRATIONS_FIXTURE.integrations[1]!;
    const api = makeApi([both]);
    const { state } = await setup(api, both);
    const fixture = await mount(IntegrationOverview, both);
    el(fixture).querySelector<HTMLButtonElement>(testid('ask-owner'))!.click();
    expect(state.requestForm()?.field).toBe('owner');

    const ownerRequest = {
      ...VENDOR_CONTESTS_FIXTURE.submitted[0]!,
      integration_id: both.id,
      field: 'owner' as const,
    };
    api.getContests.mockResolvedValue({ submitted: [ownerRequest], received: [] });
    await TestBed.inject(IntegrationDetailState).refreshContests();
    await settle(fixture);
    expect(el(fixture).querySelector(testid('ask-owner'))).toBeNull();
    expect(el(fixture).querySelector(testid('see-owner-request'))).not.toBeNull();
  });

  it('puts every tooltip’s text in the DOM for assistive tech', async () => {
    const api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    const fixture = await mount(IntegrationOverview, INTEGRATION_PROCORE_DETAIL);
    const info = el(fixture).querySelector<HTMLButtonElement>('button[aria-label="About Owner"]')!;
    const desc = el(fixture).querySelector(`#${info.getAttribute('aria-describedby')}`)!;
    expect(desc.textContent).toContain('Shows as "Offered by" on the public page.');
    expect(desc.textContent).toContain(
      'A request about the owner always goes to AEC Integrations.',
    );
  });
});

describe('a retired row', () => {
  it('offers no action on any row', async () => {
    const retired = { ...INTEGRATION_OWNED_CLAIMED, retired_at: '2026-09-20T00:00:00Z' };
    const api = makeApi([retired]);
    await setup(api, retired);
    const fixture = await mount(IntegrationOverview, retired);
    expect(el(fixture).querySelectorAll('[data-testid^="edit-"]')).toHaveLength(0);
    expect(text(fixture)).not.toContain('Request a change');
  });
});
