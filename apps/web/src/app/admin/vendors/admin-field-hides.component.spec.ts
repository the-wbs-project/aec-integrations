/**
 * AECI-1238 (§11d.7): "Values under review" on `/admin/vendors/:id`.
 *
 * The load-bearing assertions: nothing is sent before the confirm step, the field list is
 * the hide allow-list (no facets), the body carries every required field, the list shows
 * the three dates and the overdue marker only when decide-by passed with no status reply,
 * and Restore and "Record status reply" each send their own body.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { LOCALE_ID, provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminFieldHide } from '@aeci/shared';

import { AdminFieldHides } from './admin-field-hides';
import { AdminVendorsApi } from './admin-vendors-api';

const VENDOR_ID = '00000000-0000-4000-8000-000000000010';
const PRODUCT_ID = '00000000-0000-4000-8000-000000000031';
const HIDE_ID = '00000000-0000-4000-8000-000000000080';

function makeHide(over: Partial<AdminFieldHide> = {}): AdminFieldHide {
  return {
    id: HIDE_ID,
    entity_type: 'vendor',
    entity_id: VENDOR_ID,
    entity_name: 'Summit BIM',
    field: 'headquarters',
    reason: 'A reader sent a page that shows another headquarters.',
    internal_note: 'Ticket 77.',
    source_url: 'https://example.com/registry',
    received_at: '2026-11-02',
    vendor_id: VENDOR_ID,
    set_by: null,
    set_at: '2026-11-03T12:00:00.000Z',
    cleared_by: null,
    cleared_at: null,
    clear_kind: null,
    clear_reason: null,
    // Monday 2026-11-02: two business days end Wednesday, five end Monday 2026-11-09.
    hide_due: '2026-11-05T05:00:00.000Z',
    decide_due: '2026-11-10T05:00:00.000Z',
    last_status_reply: null,
    ...over,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

let api: {
  listFieldHides: ReturnType<typeof vi.fn>;
  setFieldHide: ReturnType<typeof vi.fn>;
  restoreFieldHide: ReturnType<typeof vi.fn>;
  recordFieldHideStatusReply: ReturnType<typeof vi.fn>;
  listProducts: ReturnType<typeof vi.fn>;
  listIntegrations: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    listFieldHides: vi.fn().mockResolvedValue({ hides: [] }),
    setFieldHide: vi.fn(async () => ({ hide: makeHide() })),
    restoreFieldHide: vi.fn(async () => ({ hide: makeHide() })),
    recordFieldHideStatusReply: vi.fn(async () => ({
      hide: makeHide({
        last_status_reply: {
          note: 'Told them we are checking.',
          at: '2026-11-09T10:00:00Z',
          by: null,
        },
      }),
    })),
    listProducts: vi.fn().mockResolvedValue({
      data: [
        {
          id: PRODUCT_ID,
          name: 'Revit',
          category_slugs: [],
          audience_slugs: [],
          phase_slugs: [],
          trade_slugs: [],
        },
      ],
      page: 1,
      perPage: 100,
      total: 1,
    }),
    listIntegrations: vi.fn().mockResolvedValue({ data: [], page: 1, perPage: 100, total: 0 }),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: LOCALE_ID, useValue: 'en-US' },
      { provide: AdminVendorsApi, useValue: api },
    ],
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function render(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

async function setup() {
  const fixture = TestBed.createComponent(AdminFieldHides);
  fixture.componentRef.setInput('vendorId', VENDOR_ID);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  const announce = vi.fn();
  fixture.componentInstance.announce.subscribe(announce);
  await render(fixture);
  return { fixture, el: fixture.nativeElement as HTMLElement, announce };
}

function button(el: HTMLElement, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll('button')].find(
    (b) => b.textContent?.replace(/\s+/g, ' ').trim() === text,
  );
  if (!found) throw new Error(`No button "${text}"`);
  return found as HTMLButtonElement;
}

function select(el: HTMLElement, id: string, value: string): void {
  const field = el.querySelector(`#${id}`) as unknown as HTMLSelectElement;
  field.value = value;
  field.dispatchEvent(new Event('change'));
}

function type(el: HTMLElement, id: string, value: string): void {
  const field = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
  field.value = value;
  field.dispatchEvent(new Event('input'));
}

function squash(el: Element | null): string {
  return el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

const P = `admin-field-hides-${VENDOR_ID}`;

describe('AdminFieldHides (AECI-1238)', () => {
  it('lists nothing when no value is under review', async () => {
    const { el } = await setup();
    expect(squash(el)).toContain("No value is under review on this vendor's records.");
  });

  it('offers the hide allow-list only: a product has no taxonomy facets', async () => {
    const { fixture, el } = await setup();
    button(el, 'Hide a value').click();
    await render(fixture);
    select(el, `${P}-record`, `product:${PRODUCT_ID}`);
    await render(fixture);
    const options = [...el.querySelectorAll<HTMLOptionElement>(`#${P}-field option`)].map(
      (o) => o.value,
    );
    expect(options).toEqual([
      '',
      'website',
      'tool_integrations_url',
      'api_docs_url',
      'description',
    ]);
  });

  it('sends nothing from step 1, then hides on confirm with every field', async () => {
    const { fixture, el, announce } = await setup();
    button(el, 'Hide a value').click();
    await render(fixture);
    // The received date defaults to today.
    expect((el.querySelector(`#${P}-received`) as HTMLInputElement).value).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    select(el, `${P}-record`, `vendor:${VENDOR_ID}`);
    await render(fixture);
    select(el, `${P}-field`, 'headquarters');
    type(el, `${P}-source`, 'http://example.com/not-https');
    type(el, `${P}-reason`, 'A reader sent a page that shows another headquarters.');
    await render(fixture);
    button(el, 'Review').click();
    await render(fixture);
    expect(squash(el)).toContain('Enter the source as a full https:// link.');
    expect(el.querySelector('[data-testid="field-hide-confirm"]')).toBeNull();

    type(el, `${P}-source`, 'https://example.com/registry');
    type(el, `${P}-received`, '2026-11-02');
    type(el, `${P}-note`, 'Ticket 77.');
    await render(fixture);
    button(el, 'Review').click();
    await render(fixture);
    expect(api.setFieldHide).not.toHaveBeenCalled();
    const confirm = squash(el.querySelector('[data-testid="field-hide-confirm"]'));
    expect(confirm).toContain('Hide Headquarters on Summit BIM (company).');
    expect(confirm).toContain('Under review. AEC Integrations is checking this detail.');

    button(el, 'Hide the value').click();
    await render(fixture);
    expect(api.setFieldHide).toHaveBeenCalledWith({
      entityType: 'vendor',
      entityId: VENDOR_ID,
      field: 'headquarters',
      sourceUrl: 'https://example.com/registry',
      receivedAt: '2026-11-02',
      reason: 'A reader sent a page that shows another headquarters.',
      internalNote: 'Ticket 77.',
    });
    expect(announce).toHaveBeenCalledOnce();
    expect(el.querySelectorAll('[data-testid="field-hide-row"]')).toHaveLength(1);
  });

  it('says why a hide was refused', async () => {
    api.setFieldHide.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'FIELD_HIDE_NOT_VENDOR_HELD', message: 'x' } },
      }),
    );
    const { fixture, el } = await setup();
    button(el, 'Hide a value').click();
    await render(fixture);
    select(el, `${P}-record`, `vendor:${VENDOR_ID}`);
    await render(fixture);
    select(el, `${P}-field`, 'website');
    type(el, `${P}-source`, 'https://example.com/registry');
    type(el, `${P}-reason`, 'Checking a request.');
    await render(fixture);
    button(el, 'Review').click();
    await render(fixture);
    button(el, 'Hide the value').click();
    await render(fixture);
    expect(squash(el)).toContain('No vendor holds this record');
  });

  it('shows received, hide-by and decide-by, and no overdue marker before decide-by', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T12:00:00.000Z'));
    api.listFieldHides.mockResolvedValue({ hides: [makeHide()] });
    const { el } = await setup();
    const row = squash(el.querySelector('[data-testid="field-hide-row"]'));
    expect(row).toContain('Received Nov 2, 2026');
    expect(row).toContain('Hide by Nov 4, 2026');
    expect(row).toContain('Decide by Nov 9, 2026');
    expect(el.querySelector('[data-testid="field-hide-overdue"]')).toBeNull();
  });

  it('marks a hide overdue past decide-by with no status reply, and not once one is recorded', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00.000Z'));
    api.listFieldHides.mockResolvedValue({
      hides: [
        makeHide(),
        makeHide({
          id: '00000000-0000-4000-8000-000000000081',
          field: 'website',
          last_status_reply: { note: 'Told them.', at: '2026-11-09T10:00:00Z', by: null },
        }),
      ],
    });
    const { el } = await setup();
    expect(el.querySelectorAll('[data-testid="field-hide-overdue"]')).toHaveLength(1);
    expect(squash(el.querySelector('[data-testid="field-hide-last-reply"]'))).toContain(
      'Told them.',
    );
  });

  it('records a status reply with its note', async () => {
    api.listFieldHides.mockResolvedValue({ hides: [makeHide()] });
    const { fixture, el, announce } = await setup();
    button(el, 'Record status reply').click();
    await render(fixture);
    type(el, `admin-field-hide-${HIDE_ID}-text`, 'Told them we are checking.');
    await render(fixture);
    button(el, 'Record the reply').click();
    await render(fixture);
    expect(api.recordFieldHideStatusReply).toHaveBeenCalledWith(
      HIDE_ID,
      'Told them we are checking.',
    );
    expect(announce).toHaveBeenCalledOnce();
    expect(squash(el.querySelector('[data-testid="field-hide-last-reply"]'))).toContain(
      'Told them we are checking.',
    );
  });

  it('restores with a reason and drops the row', async () => {
    api.listFieldHides.mockResolvedValue({ hides: [makeHide()] });
    const { fixture, el } = await setup();
    button(el, 'Restore').click();
    await render(fixture);
    button(el, 'Restore the value').click();
    await render(fixture);
    expect(api.restoreFieldHide).not.toHaveBeenCalled();
    expect(squash(el)).toContain('Enter a reason for the vendor.');
    type(el, `admin-field-hide-${HIDE_ID}-text`, 'The value checks out.');
    await render(fixture);
    button(el, 'Restore the value').click();
    await render(fixture);
    expect(api.restoreFieldHide).toHaveBeenCalledWith(HIDE_ID, 'The value checks out.');
    expect(el.querySelector('[data-testid="field-hide-row"]')).toBeNull();
  });
});
