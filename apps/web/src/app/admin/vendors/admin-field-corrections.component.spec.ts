/**
 * AECI-1237 — "Field corrections" on `/admin/vendors/:id`: the active-lock list and
 * the "Correct a field" form (`STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5).
 *
 * What these pin:
 *   1. The form is a second step: opening it sends nothing.
 *   2. A correction needs a vendor reason; without one nothing is sent.
 *   3. The request names the record, the field, the parsed value, the reason and the
 *      internal note, and the new lock joins the list with an announcement.
 *   4. Lift needs a reason, and drops the lock from the list.
 *   5. A refusal from the API is said in words, not swallowed.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminFieldOverride } from '@aeci/shared';

import { AdminFieldCorrections, fieldCorrectionErrorMessage } from './admin-field-corrections';
import { AdminVendorsApi } from './admin-vendors-api';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const VENDOR_ID = '00000000-0000-4000-8000-000000000010';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000020';
const REASON = 'The number on file reaches a different company.';

function makeLock(over: Partial<AdminFieldOverride> = {}): AdminFieldOverride {
  return {
    id: '00000000-0000-4000-8000-000000000101',
    entity_type: 'vendor',
    entity_id: VENDOR_ID,
    entity_name: 'Autodesk',
    field: 'phone_number',
    value: '+1 555 0100',
    reason: REASON,
    internal_note: 'Checked the register.',
    vendor_id: VENDOR_ID,
    set_by: '00000000-0000-4000-8000-000000000090',
    set_at: '2026-10-04T00:00:00.000Z',
    lifted_by: null,
    lifted_at: null,
    lift_reason: null,
    ...over,
  };
}

let api: {
  listFieldOverrides: ReturnType<typeof vi.fn>;
  listProducts: ReturnType<typeof vi.fn>;
  listIntegrations: ReturnType<typeof vi.fn>;
  setFieldOverride: ReturnType<typeof vi.fn>;
  liftFieldOverride: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    listFieldOverrides: vi.fn(),
    listProducts: vi.fn().mockResolvedValue({
      data: [{ id: PRODUCT_ID, name: 'Revit' }],
      page: 1,
      perPage: 100,
      total: 1,
    }),
    listIntegrations: vi.fn().mockResolvedValue({ data: [], page: 1, perPage: 100, total: 0 }),
    setFieldOverride: vi.fn(),
    liftFieldOverride: vi.fn(),
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
  for (let i = 0; i < 3; i++) {
    fixture.detectChanges();
    await flush();
  }
}

async function create(locks: AdminFieldOverride[] = []) {
  api.listFieldOverrides.mockResolvedValue({ overrides: locks });
  const fixture = TestBed.createComponent(AdminFieldCorrections);
  fixture.componentRef.setInput('vendorId', VENDOR_ID);
  fixture.componentRef.setInput('vendorName', 'Autodesk');
  const announced: string[] = [];
  fixture.componentInstance.announce.subscribe((m) => announced.push(m));
  await settle(fixture);
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, el, announced };
}

const byId = (el: HTMLElement, suffix: string) =>
  el.querySelector(`#admin-field-corrections-${VENDOR_ID}-${suffix}`) as
    | HTMLInputElement
    | HTMLSelectElement
    | HTMLTextAreaElement
    | HTMLButtonElement;

function choose(el: HTMLElement, suffix: string, value: string): void {
  const select = byId(el, suffix) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

function type(el: HTMLElement, suffix: string, value: string): void {
  const input = byId(el, suffix) as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function openForm(fixture: ComponentFixture<AdminFieldCorrections>, el: HTMLElement) {
  (byId(el, 'open') as HTMLButtonElement).click();
  await settle(fixture);
}

async function fillPhone(fixture: ComponentFixture<AdminFieldCorrections>, el: HTMLElement) {
  choose(el, 'record', `vendor:${VENDOR_ID}`);
  await settle(fixture);
  choose(el, 'field', 'phone_number');
  await settle(fixture);
  type(el, 'value', '+1 555 0100');
  await settle(fixture);
}

describe('AdminFieldCorrections (AECI-1237)', () => {
  it('lists the active locks with the vendor reason and a Lift action', async () => {
    const { el } = await create([makeLock()]);
    const text = el.textContent ?? '';
    expect(text).toContain('Autodesk');
    expect(text).toContain('Phone number');
    expect(text).toContain('+1 555 0100');
    expect(text).toContain(REASON);
    expect(el.querySelector(`#admin-field-lock-lift-${makeLock().id}`)).not.toBeNull();
  });

  it('says so when nothing is locked', async () => {
    const { el } = await create();
    expect(el.textContent).toContain("No field is locked on this vendor's records.");
  });

  it('opens the form as a second step and offers the company and its products', async () => {
    const { fixture, el } = await create();
    expect(api.setFieldOverride).not.toHaveBeenCalled();
    await openForm(fixture, el);
    const options = Array.from((byId(el, 'record') as HTMLSelectElement).options).map((o) =>
      o.textContent?.trim(),
    );
    expect(options).toEqual(['Choose a record', 'Autodesk (company)', 'Revit (product)']);
    expect(api.setFieldOverride).not.toHaveBeenCalled();
  });

  it('offers every product past the first page of 100', async () => {
    const all = Array.from({ length: 230 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(1000 + i).padStart(12, '0')}`,
      name: `Product ${i}`,
    }));
    api.listProducts.mockImplementation(
      async (_id: string, query: { page: number; perPage: number }) => ({
        data: all.slice((query.page - 1) * query.perPage, query.page * query.perPage),
        page: query.page,
        perPage: query.perPage,
        total: all.length,
      }),
    );
    const { fixture, el } = await create();
    await openForm(fixture, el);
    await settle(fixture);
    const options = Array.from((byId(el, 'record') as HTMLSelectElement).options).map(
      (o) => o.value,
    );
    expect(api.listProducts.mock.calls.map((c) => (c[1] as { page: number }).page)).toEqual([
      1, 2, 3,
    ]);
    expect(options.filter((v) => v.startsWith('product:'))).toHaveLength(230);
    expect(options).toContain(`product:${all[229]!.id}`);
  });

  it('leaves mechanism_kind out on a connector-powered integration, as the server does', async () => {
    const endpoint = (n: number, name: string) => ({
      id: `00000000-0000-4000-8000-00000000003${n}`,
      slug: name.toLowerCase(),
      name,
    });
    const row = (id: string, name: string, connectorPowered: boolean) => ({
      id,
      anchor: 'integration',
      name,
      source: endpoint(1, 'Revit'),
      target: endpoint(2, 'Procore'),
      connector: null,
      connector_powered: connectorPowered,
      origin: 'aeci',
      claimed_at: '2026-09-01T00:00:00.000Z',
      retired_at: null,
      retired_by: null,
      pair_path: null,
      updated_at: '2026-09-01T00:00:00.000Z',
    });
    const POWERED = '00000000-0000-4000-8000-000000000041';
    const NATIVE = '00000000-0000-4000-8000-000000000042';
    api.listIntegrations.mockResolvedValue({
      data: [row(POWERED, 'Via Zapier', true), row(NATIVE, 'Native link', false)],
      page: 1,
      perPage: 100,
      total: 2,
    });
    const { fixture, el } = await create();
    await openForm(fixture, el);
    const fieldValues = async (key: string) => {
      choose(el, 'record', key);
      await settle(fixture);
      return Array.from((byId(el, 'field') as HTMLSelectElement).options).map((o) => o.value);
    };
    const powered = await fieldValues(`integration:${POWERED}`);
    expect(powered).toContain('name');
    expect(powered).not.toContain('mechanism_kind');
    expect(await fieldValues(`integration:${NATIVE}`)).toContain('mechanism_kind');
  });

  it('sends nothing without a reason for the vendor', async () => {
    const { fixture, el } = await create();
    await openForm(fixture, el);
    await fillPhone(fixture, el);
    (el.querySelector('form button[type="submit"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(api.setFieldOverride).not.toHaveBeenCalled();
    expect(el.textContent).toContain('Enter a reason for the vendor.');
    expect(byId(el, 'reason').getAttribute('aria-invalid')).toBe('true');
  });

  it('corrects the field, adds the lock to the list and announces it', async () => {
    api.setFieldOverride.mockResolvedValue({ override: makeLock() });
    const { fixture, el, announced } = await create();
    await openForm(fixture, el);
    await fillPhone(fixture, el);
    type(el, 'reason', REASON);
    type(el, 'note', 'Checked the register.');
    (el.querySelector('form button[type="submit"]') as HTMLButtonElement).click();
    await settle(fixture);

    expect(api.setFieldOverride).toHaveBeenCalledWith({
      entityType: 'vendor',
      entityId: VENDOR_ID,
      field: 'phone_number',
      value: '+1 555 0100',
      reason: REASON,
      internalNote: 'Checked the register.',
    });
    expect(el.textContent).toContain(REASON);
    expect(announced[0]).toContain('Field corrected and locked');
    expect(byId(el, 'form')).toBeNull();
  });

  it('says why when the field is already locked', async () => {
    api.setFieldOverride.mockRejectedValue(apiError(409, 'FIELD_OVERRIDE_ACTIVE'));
    const { fixture, el } = await create();
    await openForm(fixture, el);
    await fillPhone(fixture, el);
    type(el, 'reason', REASON);
    (el.querySelector('form button[type="submit"]') as HTMLButtonElement).click();
    await settle(fixture);
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('already locked');
  });

  it('lifts a lock with a reason and drops it from the list', async () => {
    api.liftFieldOverride.mockResolvedValue({ override: makeLock({ lifted_at: 'now' }) });
    const lock = makeLock();
    const { fixture, el, announced } = await create([lock]);
    (el.querySelector(`#admin-field-lock-lift-${lock.id}`) as HTMLButtonElement).click();
    await settle(fixture);

    // No reason: nothing sent.
    (
      el.querySelector(
        `#admin-field-lock-${lock.id}-form button[type="submit"]`,
      ) as HTMLButtonElement
    ).click();
    await settle(fixture);
    expect(api.liftFieldOverride).not.toHaveBeenCalled();

    const reason = el.querySelector(`#admin-field-lock-${lock.id}-reason`) as HTMLTextAreaElement;
    reason.value = 'The vendor sent the registry extract.';
    reason.dispatchEvent(new Event('input'));
    (
      el.querySelector(
        `#admin-field-lock-${lock.id}-form button[type="submit"]`,
      ) as HTMLButtonElement
    ).click();
    await settle(fixture);

    expect(api.liftFieldOverride).toHaveBeenCalledWith(
      lock.id,
      'The vendor sent the registry extract.',
      '',
    );
    expect(el.textContent).toContain("No field is locked on this vendor's records.");
    expect(announced[0]).toContain('Lock lifted');
  });
});

describe('fieldCorrectionErrorMessage', () => {
  it('names each refusal', () => {
    expect(fieldCorrectionErrorMessage(apiError(409, 'FIELD_OVERRIDE_NOT_VENDOR_HELD'))).toContain(
      'review app',
    );
    expect(fieldCorrectionErrorMessage(apiError(409, 'FIELD_OVERRIDE_LIFTED'))).toContain(
      'already lifted',
    );
    expect(fieldCorrectionErrorMessage(new Error('boom'))).toContain('Try again');
    expect(
      fieldCorrectionErrorMessage(
        new HttpErrorResponse({
          status: 400,
          error: { error: { code: 'VALIDATION_FAILED', message: 'x', field: 'field' } },
        }),
      ),
    ).toContain('cannot be corrected on this record');
    expect(fieldCorrectionErrorMessage(apiError(400, 'VALIDATION_FAILED'))).toContain(
      'Check the field, the value and the reason',
    );
  });
});
