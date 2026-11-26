/**
 * AECI-2139 — "Data flows" in Field corrections on `/admin/vendors/:id`: the live
 * corrections and the "Correct a data flow" form (`STAGE_2_ATTESTATIONS_SPEC.md` §14.10).
 *
 * What these pin:
 *   1. The form offers only claimed connector-powered rows, and only public, uncorrected
 *      flows. A row the API would refuse says why before anything is sent.
 *   2. A correction needs an https source and an owner reason. A redirect needs a
 *      direction, and never offers the flow's own.
 *   3. The request names the flow, the action, the direction, the source, the reason and
 *      the note, and the new correction joins the list with an announcement.
 *   4. Lift needs a reason, and drops the correction from the list.
 *   5. A refusal from the API is said in words.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminFlowCorrection, AdminFlowsResponse } from '@aeci/shared';

import { AdminFlowCorrections, flowCorrectionErrorMessage } from './admin-flow-corrections';
import { AdminVendorsApi } from './admin-vendors-api';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const VENDOR_ID = '00000000-0000-4000-8000-000000000003';
const PAIR = '00000000-0000-4000-8000-000000000030';
const CLAIM_RFIS = '00000000-0000-4000-8000-000000000060';
const CLAIM_INVOICES = '00000000-0000-4000-8000-000000000061';
const SOURCE = 'https://rivets.example/docs';
const REASON = 'The Sync Service page lists no RFI sync.';

const endpoint = (id: string, name: string) => ({ id, name, slug: name.toLowerCase() });
const ROW = {
  id: PAIR,
  anchor: 'evidenced_pair' as const,
  name: 'Procore and Acumatica',
  source: endpoint('00000000-0000-4000-8000-000000000010', 'Procore'),
  target: endpoint('00000000-0000-4000-8000-000000000011', 'Acumatica'),
  connector: endpoint('00000000-0000-4000-8000-000000000013', 'Rivets Sync'),
  connector_powered: true,
  origin: 'aeci' as const,
  claimed_at: '2026-09-01T00:00:00.000Z',
  retired_at: null,
  retired_by: null,
  pair_path: null,
  updated_at: '2026-09-01T00:00:00.000Z',
};
const UNCLAIMED_ROW = { ...ROW, id: '00000000-0000-4000-8000-000000000031', claimed_at: null };

function makeCorrection(over: Partial<AdminFlowCorrection> = {}): AdminFlowCorrection {
  return {
    id: '00000000-0000-4000-8000-000000000500',
    claim_id: CLAIM_RFIS,
    replacement_claim_id: null,
    anchor_id: PAIR,
    anchor: 'evidenced_pair',
    integration_name: 'Procore and Acumatica',
    data_object_slug: 'rfis',
    data_object_name: 'RFIs',
    direction: 'a_to_b',
    replacement_direction: null,
    source_url: SOURCE,
    reason: REASON,
    internal_note: null,
    created_by: '00000000-0000-4000-8000-000000000090',
    created_at: '2026-11-26T00:00:00.000Z',
    retracted_at: null,
    retracted_by: null,
    retracted_reason: null,
    ...over,
  };
}

const FLOWS: AdminFlowsResponse = {
  anchor_id: PAIR,
  anchor: 'evidenced_pair',
  name: 'Procore and Acumatica',
  product_a: { id: ROW.source.id, name: 'Procore' },
  product_b: { id: ROW.target.id, name: 'Acumatica' },
  blocked: null,
  flows: [
    {
      claim_id: CLAIM_RFIS,
      data_object_slug: 'rfis',
      data_object_name: 'RFIs',
      direction: 'a_to_b',
      origin: 'aeci',
      public: true,
      agreement: 'unverified',
      owner_answer: null,
      correction: null,
    },
    {
      claim_id: CLAIM_INVOICES,
      data_object_slug: 'invoices',
      data_object_name: 'Invoices',
      direction: 'both',
      origin: 'aeci',
      public: false,
      agreement: 'unverified',
      owner_answer: 'no',
      correction: null,
    },
  ],
};

let api: Record<string, ReturnType<typeof vi.fn>>;

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    listFlowCorrections: vi.fn().mockResolvedValue({ corrections: [] }),
    listIntegrations: vi
      .fn()
      .mockResolvedValue({ data: [ROW, UNCLAIMED_ROW], page: 1, perPage: 100, total: 2 }),
    listFlows: vi.fn().mockResolvedValue(FLOWS),
    correctFlow: vi.fn().mockResolvedValue({ correction: makeCorrection() }),
    liftFlowCorrection: vi.fn().mockResolvedValue({ correction: makeCorrection() }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminVendorsApi, useValue: api as unknown as AdminVendorsApi },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 4; i++) {
    fixture.detectChanges();
    await flush();
  }
}

async function create(corrections: AdminFlowCorrection[] = []) {
  api['listFlowCorrections']!.mockResolvedValue({ corrections });
  const fixture = TestBed.createComponent(AdminFlowCorrections);
  fixture.componentRef.setInput('vendorId', VENDOR_ID);
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
  document.body.appendChild(fixture.nativeElement as HTMLElement);
  await settle(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, announced };
}

const byId = (el: HTMLElement, part: string) =>
  el.querySelector<HTMLInputElement & HTMLSelectElement & HTMLTextAreaElement>(
    `#admin-flow-corrections-${VENDOR_ID}-${part}`,
  )!;
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === label)!;
const choose = (node: HTMLSelectElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event('change'));
};
const type = (node: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  node.value = value;
  node.dispatchEvent(new Event('input'));
};

async function openOnRow(fixture: ComponentFixture<unknown>, el: HTMLElement): Promise<void> {
  button(el, 'Correct a data flow').click();
  await settle(fixture);
  choose(byId(el, 'record'), `evidenced_pair:${PAIR}`);
  await settle(fixture);
}

describe('AdminFlowCorrections', () => {
  it('lists nothing to send until the form is used, and offers only claimed delivered rows', async () => {
    const { fixture, el } = await create();
    expect(el.textContent).toContain('No data flow is corrected on this vendor');
    button(el, 'Correct a data flow').click();
    await settle(fixture);
    const options = [...byId(el, 'record').querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['', `evidenced_pair:${PAIR}`]);
    expect(api['correctFlow']).not.toHaveBeenCalled();
  });

  it('offers only the public flows of the row, and no direction equal to the flow’s own', async () => {
    const { fixture, el } = await create();
    await openOnRow(fixture, el);
    expect(api['listFlows']).toHaveBeenCalledWith('evidenced_pair', PAIR);
    const flows = [...byId(el, 'flow').querySelectorAll('option')].map((o) =>
      o.textContent?.trim(),
    );
    expect(flows).toEqual(['Choose a data flow', 'RFIs, Procore to Acumatica']);
    choose(byId(el, 'flow'), CLAIM_RFIS);
    await settle(fixture);
    el.querySelector<HTMLInputElement>('input[value="redirect"]')!.click();
    await settle(fixture);
    const directions = [...byId(el, 'direction').querySelectorAll('option')].map((o) => o.value);
    expect(directions).toEqual(['', 'b_to_a', 'both']);
  });

  it('says why a row cannot be corrected here', async () => {
    api['listFlows']!.mockResolvedValue({ ...FLOWS, blocked: 'not_sync_service', flows: [] });
    const { fixture, el } = await create();
    await openOnRow(fixture, el);
    expect(el.querySelector('[data-testid="flow-correction-blocked"]')?.textContent).toContain(
      'No Sync Service delivers this integration',
    );
  });

  it('needs a source and a reason, then sends the correction and lists it', async () => {
    const { fixture, el, announced } = await create();
    await openOnRow(fixture, el);
    choose(byId(el, 'flow'), CLAIM_RFIS);
    await settle(fixture);
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(el.textContent).toContain('Enter the source as a full https:// link.');
    type(byId(el, 'source'), 'http://rivets.example/docs');
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(api['correctFlow']).not.toHaveBeenCalled();
    type(byId(el, 'source'), SOURCE);
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(el.textContent).toContain('Enter a reason for the owner.');
    type(byId(el, 'reason'), REASON);
    type(byId(el, 'note'), 'Checked today.');
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(api['correctFlow']).toHaveBeenCalledWith(CLAIM_RFIS, {
      action: 'remove',
      sourceUrl: SOURCE,
      reason: REASON,
      internalNote: 'Checked today.',
    });
    expect(announced).toEqual([
      'Data flow removed. The rest of the integration stays listed, and the owner was told, with your reason.',
    ]);
    expect(el.querySelector('[data-testid="flow-correction-source"]')?.getAttribute('href')).toBe(
      SOURCE,
    );
  });

  it('a redirect needs a direction and sends it', async () => {
    const { fixture, el } = await create();
    await openOnRow(fixture, el);
    choose(byId(el, 'flow'), CLAIM_RFIS);
    await settle(fixture);
    el.querySelector<HTMLInputElement>('input[value="redirect"]')!.click();
    await settle(fixture);
    type(byId(el, 'source'), SOURCE);
    type(byId(el, 'reason'), REASON);
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(el.textContent).toContain('Choose the direction the data really moves.');
    expect(api['correctFlow']).not.toHaveBeenCalled();
    choose(byId(el, 'direction'), 'b_to_a');
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(api['correctFlow']).toHaveBeenCalledWith(
      CLAIM_RFIS,
      expect.objectContaining({ action: 'redirect', direction: 'b_to_a' }),
    );
  });

  it('says a refusal in words', async () => {
    api['correctFlow']!.mockRejectedValue(apiError(409, 'FLOW_DIRECTION_REMOVED_BY_OWNER'));
    const { fixture, el } = await create();
    await openOnRow(fixture, el);
    choose(byId(el, 'flow'), CLAIM_RFIS);
    type(byId(el, 'source'), SOURCE);
    type(byId(el, 'reason'), REASON);
    await settle(fixture);
    button(el, 'Correct the data flow').click();
    await settle(fixture);
    expect(byId(el, 'form-error').textContent).toContain(
      'The owner removed the flow in that direction.',
    );
    expect(flowCorrectionErrorMessage(apiError(409, 'FLOW_ALREADY_CORRECTED'))).toContain(
      'already corrected',
    );
  });

  it('lifts a correction with a reason and drops it from the list', async () => {
    const correction = makeCorrection({ replacement_direction: 'b_to_a' });
    const { fixture, el, announced } = await create([correction]);
    expect(el.textContent).toContain('RFIs, A to B');
    expect(el.textContent).toContain('Moved to B to A');
    button(el, 'Lift').click();
    await settle(fixture);
    button(el, 'Lift the correction').click();
    await settle(fixture);
    expect(api['liftFlowCorrection']).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Enter a reason for the owner.');
    type(
      el.querySelector<HTMLTextAreaElement>(`#admin-flow-correction-${correction.id}-reason`)!,
      'Wrong page.',
    );
    button(el, 'Lift the correction').click();
    await settle(fixture);
    expect(api['liftFlowCorrection']).toHaveBeenCalledWith(correction.id, 'Wrong page.');
    expect(announced).toEqual([
      'Correction lifted. The owner maintains the data flow again and was told why.',
    ]);
    expect(el.textContent).toContain('No data flow is corrected on this vendor');
  });
});
