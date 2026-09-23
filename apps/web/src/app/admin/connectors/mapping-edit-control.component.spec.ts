/**
 * AECI-724 — `MappingEditControl`, the admin UI over
 * `PATCH /api/admin/connector-stub-mappings/:id`.
 *
 * What is pinned:
 *
 *  1. **It sends the four editable columns and nothing else.** `decided_by` is
 *     server-stamped; a control that sent it would 400 against the strict body.
 *  2. **A decision status sends `productId: null`**, the §9a.4 two-column rule, and
 *     a product-bearing status with no product is refused before the request.
 *  3. **The refusals get their own copy**: the lane reclaimed mid-edit, and the
 *     conflict 409.
 *  4. **Host-owned chrome**: no live region of its own.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminConnectorMapping, ConnectorStubMappingEditResponse } from '@aeci/shared';

import { MappingEditApi } from './mapping-edit-api';
import { MappingEditControl } from './mapping-edit-control';

const PROCORE = { id: '00000000-0000-4000-8000-000000000800', name: 'Procore', slug: 'procore' };
const AUTODESK = {
  id: '00000000-0000-4000-8000-000000000801',
  name: 'Autodesk Build',
  slug: 'autodesk-build',
};

const MAPPING: AdminConnectorMapping = {
  id: 'fx-map-ag-1',
  status: 'mapped',
  product: PROCORE,
  confidence: 'high',
  evidence_url: null,
  decided_by: 'auto-name-match',
  decided_at: null,
  checked_at: null,
  notes: null,
  publishable: false,
};

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

@Component({
  selector: 'aec-test-host',
  imports: [MappingEditControl],
  template: `
    <aec-mapping-edit-control
      [mapping]="mapping"
      listing="Procore"
      idPrefix="t"
      (changed)="changes.push($event)"
      (announce)="announced.set($event)"
    />
  `,
})
class TestHost {
  readonly mapping = MAPPING;
  readonly announced = signal('');
  readonly changes: ConnectorStubMappingEditResponse[] = [];
}

const okResponse = (
  over: Partial<AdminConnectorMapping> = {},
): ConnectorStubMappingEditResponse => ({
  catalog_id: 'fx-cat-agave',
  stub_id: 'fx-stub-ag-procore',
  mapping: { ...MAPPING, decided_by: 'aeci-operator', publishable: true, ...over },
  changed: true,
});

async function setup(api: Partial<Record<keyof MappingEditApi, ReturnType<typeof vi.fn>>>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      {
        provide: MappingEditApi,
        useValue: {
          updateMapping: vi.fn(async () => okResponse()),
          searchProducts: vi.fn(async () => ({ data: [AUTODESK] })),
          ...api,
        },
      },
    ],
  });
  const fixture = TestBed.createComponent(TestHost);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const control = fixture.debugElement.children[0]!.componentInstance as MappingEditControl;
  const refresh = async () => {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { fixture, host: fixture.componentInstance, el, control, refresh };
}

function clickByText(el: HTMLElement, text: string): void {
  const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes(text));
  if (!button) throw new Error(`No button containing "${text}"`);
  button.click();
}

function submitForm(el: HTMLElement): void {
  el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
}

describe('MappingEditControl', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => vi.restoreAllMocks());

  it('opens a form prefilled from the row, with no live region of its own', async () => {
    const { el, refresh } = await setup({});
    clickByText(el, 'Edit');
    await refresh();
    expect(el.querySelector('form')).not.toBeNull();
    expect(el.textContent).toContain('Procore');
    expect(el.querySelector('[role="status"]')).toBeNull();
    expect(el.textContent).toContain('Saving records AECi as the decider');
  });

  it('re-points to a searched product and sends the four editable columns only', async () => {
    const updateMapping = vi.fn(async () => okResponse({ product: AUTODESK }));
    const { el, host, refresh } = await setup({ updateMapping });
    clickByText(el, 'Edit');
    await refresh();
    clickByText(el, 'Change');
    await refresh();

    const search = el.querySelector<HTMLInputElement>('#t-product')!;
    search.value = 'auto';
    search.dispatchEvent(new Event('input'));
    clickByText(el, 'Find');
    await refresh();
    clickByText(el, 'Autodesk Build');
    await refresh();

    submitForm(el);
    await refresh();

    expect(updateMapping).toHaveBeenCalledWith('fx-map-ag-1', {
      status: 'mapped',
      productId: AUTODESK.id,
      confidence: 'high',
      evidenceUrl: null,
    });
    expect(host.changes).toHaveLength(1);
    expect(host.announced()).toContain('saved');
    expect(el.querySelector('form')).toBeNull();
  });

  it('sends productId: null on a listing-level decision', async () => {
    const updateMapping = vi.fn(async () => okResponse({ status: 'no_record', product: null }));
    const { el, control, refresh } = await setup({ updateMapping });
    clickByText(el, 'Edit');
    await refresh();
    (control as unknown as { onStatusChange(v: string): void }).onStatusChange('no_record');
    await refresh();
    // A decision names no product, so the picker is gone.
    expect(el.querySelector('#t-product')).toBeNull();

    submitForm(el);
    await refresh();
    expect(updateMapping).toHaveBeenCalledWith(
      'fx-map-ag-1',
      expect.objectContaining({ status: 'no_record', productId: null }),
    );
  });

  it('refuses a matched status with no product before sending anything', async () => {
    const updateMapping = vi.fn();
    const { el, refresh } = await setup({ updateMapping });
    clickByText(el, 'Edit');
    await refresh();
    clickByText(el, 'Change');
    await refresh();
    submitForm(el);
    await refresh();
    expect(updateMapping).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Choose the product');
  });

  it('explains a lane reclaimed while the form was open', async () => {
    const updateMapping = vi.fn(async () => {
      throw new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'CATALOG_REVIEW_MANAGED', message: 'x' } },
      });
    });
    const { el, refresh } = await setup({ updateMapping });
    clickByText(el, 'Edit');
    await refresh();
    submitForm(el);
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'went back to the review app',
    );
  });

  it('explains a mapping conflict', async () => {
    const updateMapping = vi.fn(async () => {
      throw new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'MAPPING_CONFLICT', message: 'x' } },
      });
    });
    const { el, refresh } = await setup({ updateMapping });
    clickByText(el, 'Edit');
    await refresh();
    submitForm(el);
    await refresh();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('already has that mapping');
  });
});
