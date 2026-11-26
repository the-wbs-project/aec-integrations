/**
 * AECI-2192 (ruling 66) — the Sync Service's view of a removal, and its objection, in
 * Messages (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11e.6, §11e.2b).
 *
 * What these pin:
 *   1. A removed pair shows who removed it, the fixed reason's label and when. An older
 *      removal shows its own words "as they wrote it".
 *   2. "Object to this removal" opens a form with exactly the three grounds.
 *   3. The form refuses no ground, no explanation, and "plainly false" with no https link.
 *   4. A valid objection sends one call with the ground, the explanation and the link.
 *   5. An open objection hides the action and shows its state. A decided one shows the note.
 *   6. Escape closes the form, as Cancel does (`aecCloseOnEscape`).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncServicePairVeto, VetoObjection } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalAnnouncer } from '../vendor-announcer';

import { VendorPairRightsList } from './vendor-pair-rights-list';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const product = (id: string, name: string) => ({ id, name, slug: name.toLowerCase() });

const VETO: SyncServicePairVeto = {
  id: '00000000-0000-4000-8000-000000000101',
  pair: {
    integration_id: '00000000-0000-4000-8000-000000000030',
    anchor: 'evidenced_pair',
    name: 'Procore and Acumatica (Rivets Sync)',
    connector: product('00000000-0000-4000-8000-000000000020', 'Rivets Sync'),
    product_a: product('00000000-0000-4000-8000-000000000010', 'Procore'),
    product_b: product('00000000-0000-4000-8000-000000000011', 'Acumatica'),
  },
  vendor_id: '00000000-0000-4000-8000-000000000002',
  vendor_name: 'Procore Inc',
  reason_code: 'not_supported',
  reason: 'We do not support this integration',
  filed_at: '2026-11-21T09:30:00.000Z',
  in_force: true,
  ended_at: null,
  ended_how: null,
  end_reason: null,
  end_note: null,
  objection: null,
  other_vetoes_in_force: 0,
  updated_at: '2026-11-21T09:30:00.000Z',
};

const OBJECTION: VetoObjection = {
  id: '00000000-0000-4000-8000-000000000201',
  ground: 'wrong_product',
  explanation: 'Our sync connects Procore to Sage.',
  source_url: null,
  vendor_name: 'Rivets',
  status: 'open',
  decision_note: null,
  decided_at: null,
  created_at: '2026-11-22T09:30:00.000Z',
};

let api: Record<string, ReturnType<typeof vi.fn>>;
let announced: string[];

function provide(received: SyncServicePairVeto[]): void {
  api = {
    listVetoes: vi.fn().mockResolvedValue({ filed: [], received }),
    listPairContests: vi.fn().mockResolvedValue({ submitted: [], received: [] }),
    fileVetoObjection: vi.fn().mockResolvedValue({ objection: OBJECTION }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      { provide: VendorPortalAnnouncer, useValue: { announce: (t: string) => announced.push(t) } },
    ],
  });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  announced = [];
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function mount(received: SyncServicePairVeto[] = [VETO]) {
  provide(received);
  const fixture = TestBed.createComponent(VendorPairRightsList);
  await settle(fixture);
  return fixture;
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const text = (f: ComponentFixture<unknown>) => el(f).textContent?.replace(/\s+/g, ' ') ?? '';
const buttonByText = (f: ComponentFixture<unknown>, label: string) =>
  [...el(f).querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
const type = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event('input'));
};
const alertText = (f: ComponentFixture<unknown>) =>
  el(f).querySelector('form [role="alert"]')?.textContent ?? '';

describe('VendorPairRightsList — a removal and its objection (AECI-2192)', () => {
  it('shows who removed it, the fixed reason and when, and nothing like a public label', async () => {
    const fixture = await mount();
    const t = text(fixture);
    expect(t).toContain('Removed by Procore Inc on');
    expect(t).toContain('Their reason: We do not support this integration');
    expect(t).toContain('The public page shows nothing about the removal');
    expect(buttonByText(fixture, 'Object to this removal')).toBeDefined();
  });

  it('shows an older removal’s own words as recorded', async () => {
    const fixture = await mount([
      { ...VETO, reason_code: null, reason: 'Our own words from before the list.' },
    ]);
    expect(text(fixture)).toContain(
      'Their reason, as they wrote it: Our own words from before the list.',
    );
  });

  it('offers exactly the three grounds and refuses an incomplete objection', async () => {
    const fixture = await mount();
    buttonByText(fixture, 'Object to this removal')!.click();
    await settle(fixture);
    const radios = [...el(fixture).querySelectorAll<HTMLInputElement>('form input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual([
      'unauthorised_account',
      'wrong_product',
      'reason_plainly_false',
    ]);
    expect(text(fixture)).toContain('on three grounds only');

    buttonByText(fixture, 'Send the objection')!.click();
    await settle(fixture);
    expect(alertText(fixture)).toContain('Choose one of the three grounds');

    radios[2]!.click();
    await settle(fixture);
    type(el(fixture).querySelector('form textarea')!, 'Procore lists it on its marketplace.');
    await settle(fixture);
    buttonByText(fixture, 'Send the objection')!.click();
    await settle(fixture);
    expect(alertText(fixture)).toContain('https link');
    expect(api['fileVetoObjection']).not.toHaveBeenCalled();

    type(
      el(fixture).querySelector('form input[type="url"]')!,
      'https://procore.example/apps/rivets',
    );
    await settle(fixture);
    buttonByText(fixture, 'Send the objection')!.click();
    await settle(fixture);
    expect(api['fileVetoObjection']).toHaveBeenCalledWith(VETO.id, {
      ground: 'reason_plainly_false',
      explanation: 'Procore lists it on its marketplace.',
      source_url: 'https://procore.example/apps/rivets',
    });
    expect(announced[0]).toContain('Objection sent to AEC Integrations');
  });

  it('sends no link on the other grounds', async () => {
    const fixture = await mount();
    buttonByText(fixture, 'Object to this removal')!.click();
    await settle(fixture);
    el(fixture).querySelectorAll<HTMLInputElement>('form input[type="radio"]')[1]!.click();
    await settle(fixture);
    expect(el(fixture).querySelector('form input[type="url"]')).toBeNull();
    type(el(fixture).querySelector('form textarea')!, 'Wrong product.');
    await settle(fixture);
    buttonByText(fixture, 'Send the objection')!.click();
    await settle(fixture);
    expect(api['fileVetoObjection']).toHaveBeenCalledWith(VETO.id, {
      ground: 'wrong_product',
      explanation: 'Wrong product.',
    });
  });

  it('an open objection hides the action and says where it is', async () => {
    const fixture = await mount([{ ...VETO, objection: OBJECTION }]);
    expect(buttonByText(fixture, 'Object to this removal')).toBeUndefined();
    expect(text(fixture)).toContain(
      'Your objection is with AEC Integrations. Ground: It named the wrong product.',
    );
  });

  it('a declined objection shows the outcome and the note, and a new one may follow', async () => {
    const fixture = await mount([
      {
        ...VETO,
        objection: { ...OBJECTION, status: 'declined', decision_note: 'The product is right.' },
      },
    ]);
    expect(text(fixture)).toContain('did not agree with your objection. The removal stands.');
    expect(text(fixture)).toContain('The product is right.');
    expect(buttonByText(fixture, 'Object to this removal')).toBeDefined();
  });

  it('Escape closes the objection form, as Cancel does', async () => {
    const fixture = await mount();
    buttonByText(fixture, 'Object to this removal')!.click();
    await settle(fixture);
    el(fixture)
      .querySelector('form textarea')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    await settle(fixture);
    expect(el(fixture).querySelector('form')).toBeNull();
  });
});
