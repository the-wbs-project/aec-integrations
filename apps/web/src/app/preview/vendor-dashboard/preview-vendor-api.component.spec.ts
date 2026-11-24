/**
 * The vendor dashboard preview's fake API (`preview-vendor-api.ts`, AECI-2045 QA).
 *
 * What these pin:
 * - **The fake implements every `VendorApi` method.** A method the preview does not
 *   override falls through to the real client, which has no session there and answers
 *   `401`: the QA pass found "That change could not be saved" on every Sync Service write
 *   for that reason. A new `VendorApi` method now fails this spec until it gets a fake.
 * - **The Sync Service writes work against the fixture**: an owner flow answered Yes,
 *   No and cleared, a direction change, a row added, a pair created (and refused as a
 *   duplicate), a removal filed and withdrawn (the pair leaves and returns), a report
 *   filed and withdrawn, an owner's accept on a received data flow report, and a restore
 *   refused on a pair an endpoint vendor removed.
 */
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';

import { VendorApi } from '../../vendor/vendor-api';
import { VENDOR_SEATS_FIXTURE } from '../../vendor/vendor-fixtures';

import {
  PREVIEW_ENDPOINT_PAIR_ID,
  PREVIEW_RECEIVED_FLOW_REPORT,
  PREVIEW_SYNC_ME,
  PREVIEW_VETOED_PAIR_ID,
} from './preview-sync-fixtures';
import { PREVIEW_SYNC_INTEGRATIONS, PreviewVendorApi } from './preview-vendor-api';

const PAIR = '00000000-0000-4000-8000-000000005263';
const COMMITMENTS = '00000000-0000-4000-8000-000000005264';
const INVOICES = '00000000-0000-4000-8000-000000005265';
const SYNC_PRODUCT = '00000000-0000-4000-8000-000000005260';
const PRIMARY = PREVIEW_SYNC_ME.products.find((p) => p.is_primary)!.id;

/** Every method a class declares on its own prototype, constructor aside. */
function ownMethods(proto: object): string[] {
  return Object.getOwnPropertyNames(proto).filter(
    (name) =>
      name !== 'constructor' &&
      typeof Object.getOwnPropertyDescriptor(proto, name)?.value === 'function',
  );
}

let api: PreviewVendorApi;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      PreviewVendorApi,
    ],
  });
  api = TestBed.inject(PreviewVendorApi);
  api.setFixture(PREVIEW_SYNC_ME, VENDOR_SEATS_FIXTURE, PREVIEW_SYNC_INTEGRATIONS, undefined, true);
});

async function flowsOf(id: string) {
  const list = await api.getIntegrations();
  return list.owned!.find((row) => row.id === id)!.flows;
}

describe('PreviewVendorApi', () => {
  it('overrides every VendorApi method, so no preview action reaches the real API', () => {
    const missing = ownMethods(VendorApi.prototype).filter(
      (name) => !Object.prototype.hasOwnProperty.call(PreviewVendorApi.prototype, name),
    );
    expect(missing).toEqual([]);
  });

  it('answers an owner flow Yes, then No, then clears it', async () => {
    const yes = await api.setOwnerFlowAnswer(INVOICES, true);
    expect(yes.flows.find((f) => f.id === INVOICES)).toMatchObject({
      answer: 'yes',
      agreement: 'owner_confirmed',
    });
    await api.setOwnerFlowAnswer(INVOICES, false);
    expect((await flowsOf(PAIR)).find((f) => f.id === INVOICES)?.answer).toBe('no');
    await api.clearOwnerFlowAnswer(INVOICES);
    expect((await flowsOf(PAIR)).find((f) => f.id === INVOICES)?.answer).toBeNull();
  });

  it('changes a direction: the old flow is answered No and the new one confirmed', async () => {
    const res = await api.changeOwnerFlow(COMMITMENTS, { direction: 'both' });
    const commitments = res.flows.filter((f) => f.data_object_slug === 'commitments');
    expect(commitments.find((f) => f.id === COMMITMENTS)?.answer).toBe('no');
    expect(commitments.find((f) => f.direction === 'both')?.answer).toBe('yes');
    await expect(api.changeOwnerFlow(COMMITMENTS, { direction: 'outbound' })).rejects.toThrow();
  });

  it('adds a confirmed row', async () => {
    const res = await api.addOwnerFlow(PAIR, { data_object: 'rfis', direction: 'outbound' });
    expect(res.flows.at(-1)).toMatchObject({ data_object_slug: 'rfis', answer: 'yes' });
  });

  it('creates a Sync Service pair born claimed, and refuses the same pair twice', async () => {
    const body = {
      connector_product_id: SYNC_PRODUCT,
      product_id: '00000000-0000-4000-8000-000000005305',
      counterpart_product_id: '00000000-0000-4000-8000-000000005306',
      name: 'Revu and Sage',
      direction: 'outbound' as const,
    };
    await api.createSyncServicePair(body);
    const created = (await api.getIntegrations()).owned!.find((r) => r.name === 'Revu and Sage');
    expect(created).toMatchObject({ sync_service: true, flows_editable: true });
    expect(created!.claimed_at).not.toBeNull();
    await expect(api.createSyncServicePair(body)).rejects.toMatchObject({
      error: { error: { code: 'INTEGRATION_ALREADY_ON_RECORD' } },
    });
  });

  it('files a removal, which takes the pair off the product, and withdraws it', async () => {
    const before = await api.listProductConnectors(PRIMARY);
    expect(
      before.connectors.some((g) => g.delivered.some((d) => d.id === PREVIEW_ENDPOINT_PAIR_ID)),
    ).toBe(true);
    const { veto } = await api.fileVeto(PREVIEW_ENDPOINT_PAIR_ID, 'Not authorised');
    expect((await api.listVetoes()).filed[0]).toMatchObject({ id: veto.id, in_force: true });
    const during = await api.listProductConnectors(PRIMARY);
    expect(
      during.connectors.some((g) => g.delivered.some((d) => d.id === PREVIEW_ENDPOINT_PAIR_ID)),
    ).toBe(false);
    const back = await api.withdrawVeto(veto.id);
    expect(back.pair_public).toBe(true);
    const after = await api.listProductConnectors(PRIMARY);
    expect(
      after.connectors.some((g) => g.delivered.some((d) => d.id === PREVIEW_ENDPOINT_PAIR_ID)),
    ).toBe(true);
  });

  it('files and withdraws a data flow report, and marks the flow as reported meanwhile', async () => {
    const target = (await api.listProductConnectors(PRIMARY)).connectors
      .flatMap((g) => g.delivered_contest_targets)
      .find((t) => t.id === PREVIEW_ENDPOINT_PAIR_ID)!;
    const claimId = target.sync_service_rights!.flows[0]!.claim_id;
    const { contest } = await api.submitPairContest(PREVIEW_ENDPOINT_PAIR_ID, {
      kind: 'data_flow',
      claim_id: claimId,
      reason: 'Wrong way',
    });
    expect(contest.routed_to).toBe('owner');
    const reported = (await api.listProductConnectors(PRIMARY)).connectors
      .flatMap((g) => g.delivered_contest_targets)
      .find((t) => t.id === PREVIEW_ENDPOINT_PAIR_ID)!;
    expect(reported.sync_service_rights!.open_flow_claim_ids).toContain(claimId);
    await api.withdrawPairContest(contest.id);
    expect((await api.listPairContests()).submitted[0]!.status).toBe('withdrawn');
  });

  it('lets the owner accept a received data flow report, which redirects the flow', async () => {
    const { contest } = await api.decidePairContest(PREVIEW_RECEIVED_FLOW_REPORT.id, {
      decision: 'accept',
    });
    expect(contest).toMatchObject({ status: 'accepted', accept_mode: 'flow-redirected' });
    const invoices = (await flowsOf(PAIR)).filter((f) => f.data_object_slug === 'invoices');
    expect(invoices.find((f) => f.id === INVOICES)?.answer).toBe('no');
    expect(invoices.find((f) => f.direction === 'both')?.answer).toBe('yes');
  });

  it('refuses to restore a pair an endpoint vendor removed', async () => {
    await api.retireIntegration(PREVIEW_VETOED_PAIR_ID);
    await expect(api.restoreIntegration(PREVIEW_VETOED_PAIR_ID)).rejects.toMatchObject({
      error: { error: { code: 'INTEGRATION_VETOED' } },
    });
  });

  it('counts "Confirm data flows" on a Sync Service from the owner flows', async () => {
    const step = async () =>
      (await api.getProductChecklist(SYNC_PRODUCT)).steps.find(
        (s) => s.key === 'confirm_data_flows',
      )!.status;
    expect(await step()).toBe('todo');
    await api.setOwnerFlowAnswer(INVOICES, true);
    expect(await step()).toBe('done');
  });
});
