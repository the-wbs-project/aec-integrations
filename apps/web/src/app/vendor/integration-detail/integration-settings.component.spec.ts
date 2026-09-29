/**
 * AECI-1149 — Settings (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.7): retire and
 * restore, with an inline confirmation, by the caller's seat.
 */
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  INTEGRATION_OWNED_CLAIMED,
  INTEGRATION_PROCORE_DETAIL,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import {
  apiError,
  el,
  makeApi,
  mount,
  settle,
  setup,
  text,
} from './integration-detail-testing.harness';
import { IntegrationSettings } from './integration-settings';

afterEach(() => vi.restoreAllMocks());

const testid = (id: string) => `[data-testid="${id}"]`;

describe('Settings', () => {
  it('retires only after the confirm step, and announces', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.retireIntegration.mockResolvedValue({
      integration: { retired_at: '2026-09-28T00:00:00.000Z', retired_by: 'owner' },
      withdrawn_contest_ids: [],
    });
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await mount(IntegrationSettings, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('retire-open'))!.click();
    await settle(fixture);
    expect(api.retireIntegration).not.toHaveBeenCalled();
    expect(text(fixture)).toContain('Retire it now?');
    expect(document.activeElement?.getAttribute('data-testid')).toBe('retire-confirm');
    el(fixture).querySelector<HTMLButtonElement>(testid('retire-confirm'))!.click();
    await settle(fixture);
    expect(api.retireIntegration).toHaveBeenCalledWith(INTEGRATION_OWNED_CLAIMED.id);
    expect(announce).toHaveBeenCalledWith(
      'Integration retired. It no longer appears on the public page.',
    );
  });

  it('cancels back to the trigger without sending', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationSettings, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('retire-open'))!.click();
    await settle(fixture);
    [...el(fixture).querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Cancel')!
      .click();
    await settle(fixture);
    expect(el(fixture).querySelector(testid('retire-open'))).not.toBeNull();
    expect(api.retireIntegration).not.toHaveBeenCalled();
  });

  it('says why a retire was refused', async () => {
    const api = makeApi([INTEGRATION_OWNED_CLAIMED]);
    api.retireIntegration.mockRejectedValue(apiError(409, 'INTEGRATION_RETIRED'));
    await setup(api, INTEGRATION_OWNED_CLAIMED);
    const fixture = await mount(IntegrationSettings, INTEGRATION_OWNED_CLAIMED);
    el(fixture).querySelector<HTMLButtonElement>(testid('retire-open'))!.click();
    await settle(fixture);
    el(fixture).querySelector<HTMLButtonElement>(testid('retire-confirm'))!.click();
    await settle(fixture);
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('already retired');
  });

  it('offers Restore on a row the owner retired', async () => {
    const retired = {
      ...INTEGRATION_OWNED_CLAIMED,
      retired_at: '2026-09-20T00:00:00Z',
      retired_by: 'owner' as const,
    };
    const api = makeApi([retired]);
    await setup(api, retired);
    const fixture = await mount(IntegrationSettings, retired);
    expect(text(fixture)).toContain('This integration is retired');
    expect(el(fixture).querySelector(testid('restore'))).not.toBeNull();
  });

  it('says only AEC Integrations restores its own retire', async () => {
    const retired = {
      ...INTEGRATION_OWNED_CLAIMED,
      retired_at: '2026-09-20T00:00:00Z',
      retired_by: 'aeci' as const,
    };
    const api = makeApi([retired]);
    await setup(api, retired);
    const fixture = await mount(IntegrationSettings, retired);
    expect(text(fixture)).toContain('Retired by AEC Integrations on Sep 20, 2026');
    expect(text(fixture)).toContain('Only AEC Integrations can restore it.');
    expect(el(fixture).querySelector(testid('restore'))).toBeNull();
  });

  it('tells the unclaimed owner to claim first, and anyone else who retires', async () => {
    const unclaimed = { ...INTEGRATION_OWNED_CLAIMED, claimed_at: null };
    let api = makeApi([unclaimed]);
    await setup(api, unclaimed);
    let fixture = await mount(IntegrationSettings, unclaimed);
    expect(text(fixture)).toContain('Once you claim this integration');

    api = makeApi([INTEGRATION_PROCORE_DETAIL]);
    await setup(api, INTEGRATION_PROCORE_DETAIL);
    fixture = await mount(IntegrationSettings, INTEGRATION_PROCORE_DETAIL);
    expect(text(fixture)).toContain('Only the owner can retire an integration.');
  });

  it('offers no Retire on a connector-powered row without a plan', async () => {
    const connectorOwned = { ...INTEGRATION_OWNED_CLAIMED, attestable: false };
    const api = makeApi([connectorOwned]);
    await setup(api, connectorOwned, VENDOR_ME_UNVERIFIED_FIXTURE);
    const fixture = await mount(IntegrationSettings, connectorOwned);
    expect(el(fixture).querySelector(testid('retire-open'))).toBeNull();
    expect(text(fixture)).toContain('needs an active plan');
  });
});
