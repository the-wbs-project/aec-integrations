/**
 * AECI-1046 — the Integrations tab on `/admin/vendors/:id`: the vendor-held rows a
 * vendor owns, and the admin retire and restore.
 *
 * What these pin:
 *   1. Each row offers exactly the action the API will take: Retire on a live row,
 *      Restore on an AECi retire, nothing on an owner retire.
 *   2. The action is a second step inside the page with a required reason. Opening
 *      it sends nothing; an empty reason sends nothing.
 *   3. Success updates the row and announces. A lost race reloads the list.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminVendorIntegrationRow } from '@aeci/shared';

import { AdminVendorsApi } from './admin-vendors-api';
import { VendorIntegrationsPanel, adminRetireErrorMessage } from './vendor-integrations-panel';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const VENDOR_ID = '00000000-0000-4000-8000-000000000010';

function makeRow(over: Partial<AdminVendorIntegrationRow> = {}): AdminVendorIntegrationRow {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    anchor: 'integration',
    connector: null,
    name: 'Revit for MicroStation',
    source: { id: '00000000-0000-4000-8000-000000000201', slug: 'revit', name: 'Revit' },
    target: {
      id: '00000000-0000-4000-8000-000000000202',
      slug: 'microstation',
      name: 'MicroStation',
    },
    origin: 'aeci',
    claimed_at: '2026-09-01T00:00:00.000Z',
    retired_at: null,
    retired_by: null,
    pair_path: '/products/microstation/integrations/revit',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

let api: {
  listIntegrations: ReturnType<typeof vi.fn>;
  setIntegrationRetired: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = { listIntegrations: vi.fn(), setIntegrationRetired: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: AdminVendorsApi, useValue: api as unknown as AdminVendorsApi },
    ],
  });
});
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
}

async function create(rows: AdminVendorIntegrationRow[]) {
  api.listIntegrations.mockResolvedValue({ data: rows, page: 1, perPage: 100, total: rows.length });
  const fixture = TestBed.createComponent(VendorIntegrationsPanel);
  fixture.componentRef.setInput('vendorId', VENDOR_ID);
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
  document.body.appendChild(fixture.nativeElement);
  await settle(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, announced };
}

const button = (el: Element, text: string) =>
  [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);

function typeReason(el: HTMLElement, value: string): void {
  const area = el.querySelector('textarea')!;
  area.value = value;
  area.dispatchEvent(new Event('input'));
}

describe('which action each row offers', () => {
  it('offers Retire on a live row, Restore on an AECi retire, and nothing on an owner retire', async () => {
    const { el } = await create([
      makeRow({ id: '00000000-0000-4000-8000-000000000101', name: 'A live one' }),
      makeRow({
        id: '00000000-0000-4000-8000-000000000102',
        name: 'B aeci',
        retired_at: '2026-09-21T00:00:00.000Z',
        retired_by: 'aeci',
      }),
      makeRow({
        id: '00000000-0000-4000-8000-000000000103',
        name: 'C owner',
        retired_at: '2026-09-20T00:00:00.000Z',
        retired_by: 'owner',
      }),
    ]);
    const rows = [...el.querySelectorAll('tbody tr')];
    expect(rows[0]!.textContent).toContain('Live');
    expect(button(rows[0]!, 'Retire')).toBeTruthy();
    expect(rows[1]!.textContent).toContain('Retired by AEC Integrations');
    expect(button(rows[1]!, 'Restore')).toBeTruthy();
    expect(rows[2]!.textContent).toContain('Retired by the owner');
    expect(rows[2]!.textContent).toContain('Only the owner can restore it');
    expect(rows[2]!.querySelector('button')).toBeNull();
    expect(api.listIntegrations).toHaveBeenCalledWith(VENDOR_ID, { page: 1, perPage: 100 });
  });

  it('says so when the vendor holds none', async () => {
    const { el } = await create([]);
    expect(el.textContent).toContain('This vendor holds no integrations.');
  });
});

describe('retire', () => {
  it('opens a form with a required reason and sends nothing until submitted', async () => {
    const { fixture, el } = await create([makeRow()]);
    button(el, 'Retire')!.click();
    await settle(fixture);
    expect(el.textContent).toContain('Retire this integration as AEC Integrations?');
    expect(el.textContent).toContain('It is not shown to the vendor.');
    expect(document.activeElement).toBe(el.querySelector('textarea'));
    expect(api.setIntegrationRetired).not.toHaveBeenCalled();

    // An empty reason is refused in the page.
    button(el, 'Retire integration')!.click();
    await settle(fixture);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Enter a reason.');
    expect(api.setIntegrationRetired).not.toHaveBeenCalled();
  });

  it('retires, updates the row and announces', async () => {
    const row = makeRow();
    api.setIntegrationRetired.mockResolvedValue({
      integration: {
        id: row.id,
        retired_at: '2026-09-22T00:00:00.000Z',
        retired_by: 'aeci',
        updated_at: '2026-09-22T00:00:00.000Z',
      },
      withdrawn_contest_ids: [],
    });
    const { fixture, el, announced } = await create([row]);
    button(el, 'Retire')!.click();
    await settle(fixture);
    typeReason(el, '  False listing.  ');
    button(el, 'Retire integration')!.click();
    await settle(fixture);
    expect(api.setIntegrationRetired).toHaveBeenCalledWith(row.id, 'retire', 'False listing.');
    expect(el.textContent).toContain('Retired by AEC Integrations');
    expect(button(el, 'Restore')).toBeTruthy();
    expect(announced[0]).toContain('Integration retired.');
  });

  it('Cancel closes the form and returns focus to the trigger', async () => {
    const { fixture, el } = await create([makeRow()]);
    button(el, 'Retire')!.click();
    await settle(fixture);
    button(el, 'Cancel')!.click();
    await settle(fixture);
    expect(el.querySelector('form')).toBeNull();
    expect(document.activeElement).toBe(button(el, 'Retire'));
  });

  it('reloads the list when the row changed under it', async () => {
    const { fixture, el, announced } = await create([makeRow()]);
    api.setIntegrationRetired.mockRejectedValue(apiError(409, 'INTEGRATION_RETIRED'));
    button(el, 'Retire')!.click();
    await settle(fixture);
    typeReason(el, 'Abuse.');
    button(el, 'Retire integration')!.click();
    await settle(fixture);
    expect(api.listIntegrations).toHaveBeenCalledTimes(2);
    expect(announced[0]).toContain('already retired');
  });
});

describe('an evidenced pair (AECI-1091)', () => {
  const pairRow = () =>
    makeRow({
      id: '00000000-0000-4000-8000-000000000109',
      anchor: 'evidenced_pair',
      name: 'Agave: Revit to MicroStation',
      connector: { id: '00000000-0000-4000-8000-000000000203', slug: 'agave', name: 'Agave Sync' },
    });

  it('names the connector on the row and in the retire form', async () => {
    const { fixture, el } = await create([pairRow()]);
    expect(el.querySelector('[data-testid="admin-integration-via"]')?.textContent).toContain(
      'Delivered through Agave Sync',
    );
    button(el, 'Retire')!.click();
    await settle(fixture);
    const body = el.querySelector('[data-testid="admin-retire-body-connector"]');
    expect(body?.textContent).toContain('stops counting on both products and on');
    expect(body?.textContent).toContain('Agave Sync');
    expect(api.setIntegrationRetired).not.toHaveBeenCalled();
  });

  it('retires a pair through the same route, by its id', async () => {
    const row = pairRow();
    api.setIntegrationRetired.mockResolvedValue({
      integration: {
        id: row.id,
        retired_at: '2026-09-23T00:00:00.000Z',
        retired_by: 'aeci',
        updated_at: '2026-09-23T00:00:00.000Z',
      },
      withdrawn_contest_ids: [],
    });
    const { fixture, el } = await create([row]);
    button(el, 'Retire')!.click();
    await settle(fixture);
    typeReason(el, 'False listing.');
    button(el, 'Retire integration')!.click();
    await settle(fixture);
    expect(api.setIntegrationRetired).toHaveBeenCalledWith(row.id, 'retire', 'False listing.');
    expect(el.textContent).toContain('Retired by AEC Integrations');
  });
});

describe('restore', () => {
  it('restores an AECi retire with a reason', async () => {
    const row = makeRow({ retired_at: '2026-09-21T00:00:00.000Z', retired_by: 'aeci' });
    api.setIntegrationRetired.mockResolvedValue({
      integration: {
        id: row.id,
        retired_at: null,
        retired_by: null,
        updated_at: '2026-09-22T00:00:00.000Z',
      },
      withdrawn_contest_ids: [],
    });
    const { fixture, el } = await create([row]);
    button(el, 'Restore')!.click();
    await settle(fixture);
    typeReason(el, 'Vendor corrected the listing.');
    button(el, 'Restore integration')!.click();
    await settle(fixture);
    expect(api.setIntegrationRetired).toHaveBeenCalledWith(
      row.id,
      'restore',
      'Vendor corrected the listing.',
    );
    expect(el.textContent).toContain('Live');
  });

  it('explains an owner retire refusal', () => {
    expect(adminRetireErrorMessage(apiError(409, 'INTEGRATION_RETIRED_BY_OWNER'))).toContain(
      'only the owner can restore it',
    );
  });
});
