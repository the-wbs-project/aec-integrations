/**
 * AECI-2192 (ruling 66) — the admin queue's removals: the fixed reason, the objection
 * with Accept and Decline, and "End this removal" with a required end reason
 * (`ADMIN_PANEL_SPEC.md` §5.12).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminVeto } from '@aeci/shared';

import { AdminContestsApi } from './admin-contests-api';
import { AdminPairRights } from './admin-pair-rights';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const product = (id: string, name: string) => ({ id, name, slug: name.toLowerCase() });

const VETO: AdminVeto = {
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
  objection: {
    id: '00000000-0000-4000-8000-000000000201',
    ground: 'reason_plainly_false',
    explanation: 'Procore lists this sync on its marketplace.',
    source_url: 'https://procore.example/apps/rivets',
    vendor_name: 'Rivets',
    status: 'open',
    decision_note: null,
    decided_at: null,
    created_at: '2026-11-22T09:30:00.000Z',
  },
  other_vetoes_in_force: 0,
  updated_at: '2026-11-22T09:30:00.000Z',
  owner_name: 'Rivets',
  // Received Sunday 22 November 2026: day 5 is Monday 30 November (Thanksgiving skipped).
  objection_answer_due: '2026-12-01T05:00:00.000Z',
};

let api: Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    listPairContests: vi.fn().mockResolvedValue({ data: [] }),
    listVetoes: vi.fn().mockResolvedValue({ data: [VETO] }),
    liftVeto: vi.fn().mockResolvedValue({ veto: VETO, pair_public: true }),
    decideVetoObjection: vi.fn().mockResolvedValue({ objection: VETO.objection }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminContestsApi, useValue: api as unknown as AdminContestsApi },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
}

async function mount() {
  const fixture = TestBed.createComponent(AdminPairRights);
  await settle(fixture);
  return fixture;
}

const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;
const text = (f: ComponentFixture<unknown>) => el(f).textContent?.replace(/\s+/g, ' ') ?? '';
const buttonsByText = (f: ComponentFixture<unknown>, label: string) =>
  [...el(f).querySelectorAll('button')].filter(
    (b) => b.textContent?.trim() === label && !b.closest('form[hidden]'),
  );
const type = (node: HTMLTextAreaElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event('input'));
};

describe('AdminPairRights — removals and objections (AECI-2192)', () => {
  it('lists the removal with its fixed reason, and the objection with its ground and link', async () => {
    const fixture = await mount();
    const t = text(fixture);
    expect(t).toContain('Removed by Procore Inc on');
    expect(t).toContain('Reason the vendor gave: We do not support this integration');
    expect(t).toContain('Objection from Rivets');
    expect(t).toContain('Ground: Its reason is plainly false on its face');
    expect(t).toContain('Procore lists this sync on its marketplace.');
    expect(el(fixture).querySelector('[data-admin-objection] a')?.getAttribute('href')).toBe(
      'https://procore.example/apps/rivets',
    );
    expect(t).toContain('not whether the vendor should support the integration');
  });

  it("shows the objection's received date and its answer-by date, and marks it overdue once past", async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-12-02T12:00:00.000Z'));
    const fixture = await mount();
    const t = text(fixture);
    expect(t).toContain('Received Nov 22, 2026');
    expect(t).toContain('Answer by Nov 30, 2026');
    expect(el(fixture).querySelector('[data-testid="objection-overdue"]')?.textContent).toContain(
      'Answer overdue',
    );
  });

  it('does not mark an objection overdue before its answer-by date', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-25T12:00:00.000Z'));
    const fixture = await mount();
    expect(el(fixture).querySelector('[data-testid="objection-overdue"]')).toBeNull();
  });

  it('a stored reason outside the list reads as the generic line', async () => {
    api['listVetoes']!.mockResolvedValue({
      data: [{ ...VETO, reason_code: 'unrecognised', reason: 'It is not offered for our product' }],
    });
    const fixture = await mount();
    const t = text(fixture);
    expect(t).toContain('Reason the vendor gave: The vendor gave another reason');
    expect(t).not.toContain('It is not offered for our product');
  });

  it('accepting an objection needs a note and sends the decision', async () => {
    const fixture = await mount();
    buttonsByText(fixture, 'Accept and end the removal')[0]!.click();
    await settle(fixture);
    const form = el(fixture).querySelector<HTMLFormElement>(
      '[data-admin-objection] form:not([hidden])',
    )!;
    expect(form.textContent).toContain('Every listing of this integration returns');
    type(form.querySelector('textarea')!, 'Their marketplace page lists the sync.');
    await settle(fixture);
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle(fixture);
    expect(api['decideVetoObjection']).toHaveBeenCalledWith(VETO.objection!.id, {
      decision: 'accept',
      note: 'Their marketplace page lists the sync.',
    });
  });

  it('declining needs a note too', async () => {
    const fixture = await mount();
    buttonsByText(fixture, 'Decline')[0]!.click();
    await settle(fixture);
    const forms = [
      ...el(fixture).querySelectorAll<HTMLFormElement>('[data-admin-objection] form:not([hidden])'),
    ];
    const form = forms[0]!;
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle(fixture);
    expect(api['decideVetoObjection']).not.toHaveBeenCalled();
    type(form.querySelector('textarea')!, 'The page does not list it.');
    await settle(fixture);
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle(fixture);
    expect(api['decideVetoObjection']).toHaveBeenCalledWith(VETO.objection!.id, {
      decision: 'decline',
      note: 'The page does not list it.',
    });
  });

  it('"End this removal" needs one of the five end reasons and a note', async () => {
    const fixture = await mount();
    buttonsByText(fixture, 'End this removal')[0]!.click();
    await settle(fixture);
    const form = el(fixture).querySelector<HTMLFormElement>(`#lift-form-${VETO.id}`)!;
    const radios = [...form.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios.map((r) => r.value)).toEqual([
      'unauthorised_account',
      'wrong_product',
      'reason_plainly_false',
      'claim_ended_or_suspended',
      'law_requires',
    ]);
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle(fixture);
    expect(api['liftVeto']).not.toHaveBeenCalled();
    expect(form.querySelector('[role="alert"]')?.textContent).toContain('Choose why');
    radios[3]!.click();
    type(form.querySelector('textarea')!, 'Procore’s claim ended.');
    await settle(fixture);
    form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await settle(fixture);
    expect(api['liftVeto']).toHaveBeenCalledWith(
      VETO.id,
      'claim_ended_or_suspended',
      'Procore’s claim ended.',
    );
  });
});
