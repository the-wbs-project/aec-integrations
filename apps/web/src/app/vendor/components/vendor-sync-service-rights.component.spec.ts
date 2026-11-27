/**
 * AECI-2042 — an endpoint vendor's three rights on a Sync Service pair, in the
 * Connectors section (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.6).
 *
 * What these pin:
 *   1. Nothing renders for a pair without `sync_service_rights` (another connector, or
 *      the owner).
 *   2. The removal needs a second step that says what happens, and a reason from the
 *      fixed list (AECI-2192, ruling 66), never free text.
 *   3. Submit sends the veto, announces it, and asks the section to reload.
 *   4. The existence report says the pair stays listed, and sends `kind: existence`.
 *   5. A data flow report sends the claim and the proposed direction.
 *   6. Cancel and Escape return focus to the form's opener (AECI-2191).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EvidencedPairContestTarget } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import { VendorSyncServiceRights } from './vendor-sync-service-rights';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const link = (id: string, name: string) => ({ id, name, slug: name.toLowerCase(), logo_url: null });

const TARGET: EvidencedPairContestTarget = {
  id: '00000000-0000-4000-8000-000000000030',
  name: 'Procore and Acumatica (Rivets Sync)',
  context_product: link('00000000-0000-4000-8000-000000000010', 'Procore'),
  other_product: link('00000000-0000-4000-8000-000000000011', 'Acumatica'),
  connector: link('00000000-0000-4000-8000-000000000020', 'Rivets Sync'),
  contestable_fields: {} as EvidencedPairContestTarget['contestable_fields'],
  endpoint_vendors: [],
  owner: { id: '00000000-0000-4000-8000-000000000001', name: 'Rivets' },
  is_owner: false,
  retired: false,
  sync_service_rights: {
    veto_id: null,
    open_reports: [],
    open_flow_claim_ids: [],
    flows: [
      {
        claim_id: '00000000-0000-4000-8000-000000000050',
        data_object_name: 'RFIs',
        direction: 'a_to_b',
      },
    ],
    flows_decided_by_owner: true,
  },
};

let api: Record<string, ReturnType<typeof vi.fn>>;
let announced: string[];

beforeEach(() => {
  TestBed.resetTestingModule();
  announced = [];
  api = {
    fileVeto: vi.fn().mockResolvedValue({ veto: {}, pair_public: false }),
    submitPairContest: vi.fn().mockResolvedValue({ contest: {} }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      { provide: VendorPortalAnnouncer, useValue: { announce: (t: string) => announced.push(t) } },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function mount(target = TARGET) {
  const fixture = TestBed.createComponent(VendorSyncServiceRights);
  fixture.componentRef.setInput('target', target);
  const changed = vi.fn();
  fixture.componentInstance.changed.subscribe(changed);
  await settle(fixture);
  return { fixture, changed };
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const buttonByText = (f: ComponentFixture<unknown>, text: string) =>
  [...el(f).querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const typeInto = (node: HTMLTextAreaElement | HTMLSelectElement, value: string, event: string) => {
  node.value = value;
  node.dispatchEvent(new Event(event));
};

describe('VendorSyncServiceRights', () => {
  it('renders nothing without sync_service_rights', async () => {
    const { fixture } = await mount({ ...TARGET, sync_service_rights: null });
    expect(el(fixture).querySelector('[data-sync-service-rights]')).toBeNull();
  });

  it('the removal says what happens and needs a reason from the fixed list (ruling 66)', async () => {
    const { fixture, changed } = await mount();
    buttonByText(fixture, 'Remove this integration from our product').click();
    await settle(fixture);
    const text = el(fixture).textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('off the public site at once');
    expect(text).toContain('The public page shows nothing about the removal');
    expect(text).toContain('Rivets is told at once, with the reason you pick and the time');
    expect(text).toContain('Rivets cannot bring it back or add it again');
    expect(text).toContain('can object to AEC Integrations on three grounds only');
    expect(text).toContain('You can withdraw the removal later');
    // No free text: the reason is a radio group of the three fixed reasons.
    expect(el(fixture).querySelector('form textarea')).toBeNull();
    const radios = [...el(fixture).querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual([
      'not_supported',
      'not_authorised',
      'no_longer_work_with',
    ]);
    expect(el(fixture).querySelector('fieldset')?.textContent).toContain(
      'We no longer work with this company',
    );
    expect(el(fixture).querySelector('fieldset legend')?.textContent).toContain('Your reason');
    expect(api['fileVeto']).not.toHaveBeenCalled();

    buttonByText(fixture, 'Remove it from our product').click();
    await settle(fixture);
    expect(api['fileVeto']).not.toHaveBeenCalled();
    expect(el(fixture).querySelector('[role="alert"]')?.textContent).toContain('Choose a reason');

    radios[1]!.click();
    await settle(fixture);
    buttonByText(fixture, 'Remove it from our product').click();
    await settle(fixture);
    expect(api['fileVeto']).toHaveBeenCalledWith(TARGET.id, 'not_authorised');
    expect(announced[0]).toContain('off the public site');
    expect(changed).toHaveBeenCalled();
  });

  it('closes each form on Escape as Cancel does (AECI-2133)', async () => {
    const { fixture } = await mount();
    for (const opener of [
      'Remove this integration from our product',
      'Report that it is not offered',
      'Report a wrong data flow',
    ]) {
      buttonByText(fixture, opener).click();
      await settle(fixture);
      el(fixture)
        .querySelector('form textarea, form input')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      await settle(fixture);
      expect(el(fixture).querySelector('form')).toBeNull();
    }
    expect(api['fileVeto']).not.toHaveBeenCalled();
    expect(api['submitPairContest']).not.toHaveBeenCalled();
  });

  it('Cancel and Escape return focus to the button that opened the form (AECI-2191)', async () => {
    const { fixture } = await mount();
    for (const opener of [
      'Remove this integration from our product',
      'Report that it is not offered',
      'Report a wrong data flow',
    ]) {
      buttonByText(fixture, opener).click();
      await settle(fixture);
      el(fixture).querySelector<HTMLElement>('form textarea, form input')!.focus();
      buttonByText(fixture, 'Cancel').click();
      await settle(fixture);
      expect(el(fixture).querySelector('form'), opener).toBeNull();
      expect(document.activeElement, opener).toBe(buttonByText(fixture, opener));

      buttonByText(fixture, opener).click();
      await settle(fixture);
      el(fixture)
        .querySelector('form textarea, form input')!
        .dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
      await settle(fixture);
      expect(document.activeElement, `${opener} (Escape)`).toBe(buttonByText(fixture, opener));
    }
  });

  it('ignores Escape while the removal sends (AECI-2133)', async () => {
    api['fileVeto']!.mockReturnValue(new Promise(() => undefined));
    const { fixture } = await mount();
    buttonByText(fixture, 'Remove this integration from our product').click();
    await settle(fixture);
    el(fixture).querySelector<HTMLInputElement>('input[type="radio"]')!.click();
    await settle(fixture);
    buttonByText(fixture, 'Remove it from our product').click();
    await settle(fixture);
    expect(api['fileVeto']).toHaveBeenCalled();
    el(fixture)
      .querySelector('form input')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(fixture);
    expect(el(fixture).querySelector('form')).not.toBeNull();
  });

  it('the existence report says the pair stays listed', async () => {
    const { fixture } = await mount();
    buttonByText(fixture, 'Report that it is not offered').click();
    await settle(fixture);
    expect(el(fixture).textContent).toContain('stays listed while we check');
    typeInto(el(fixture).querySelector('textarea')!, 'Discontinued.', 'input');
    buttonByText(fixture, 'Send').click();
    await settle(fixture);
    expect(api['submitPairContest']).toHaveBeenCalledWith(TARGET.id, {
      kind: 'existence',
      reason: 'Discontinued.',
    });
  });

  it('a data flow report names the flow and the proposed direction', async () => {
    const { fixture } = await mount();
    buttonByText(fixture, 'Report a wrong data flow').click();
    await settle(fixture);
    expect(el(fixture).textContent).toContain('Rivets keeps the data flows');
    const selects = el(fixture).querySelectorAll('select');
    typeInto(selects[1]!, 'both', 'change');
    typeInto(el(fixture).querySelector('textarea')!, 'It is two-way.', 'input');
    buttonByText(fixture, 'Send').click();
    await settle(fixture);
    expect(api['submitPairContest']).toHaveBeenCalledWith(TARGET.id, {
      kind: 'data_flow',
      claim_id: '00000000-0000-4000-8000-000000000050',
      reason: 'It is two-way.',
      proposed_direction: 'both',
    });
  });
});
