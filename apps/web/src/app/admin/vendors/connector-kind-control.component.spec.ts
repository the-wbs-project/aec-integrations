/**
 * AECI-2036 — the connector kind control on the Products tab of `/admin/vendors/:id`.
 * A pick, then an explicit Save, over `PATCH /api/admin/products/:id/connector-kind`.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AecSelect } from '../../shared/aec-select/aec-select';
import { AdminVendorsApi } from './admin-vendors-api';
import { ConnectorKindControl } from './connector-kind-control';

const PRODUCT_ID = '00000000-0000-4000-8000-000000000031';

let api: { setConnectorKind: ReturnType<typeof vi.fn> };

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    setConnectorKind: vi.fn(async (id: string, kind: string | null) => ({
      id,
      connector_kind: kind,
      changed: true,
    })),
  };
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), { provide: AdminVendorsApi, useValue: api }],
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(kind: 'integration_platform' | 'sync_service' | null = null) {
  const fixture = TestBed.createComponent(ConnectorKindControl);
  fixture.componentRef.setInput('productId', PRODUCT_ID);
  fixture.componentRef.setInput('productName', 'Rivets Sync');
  fixture.componentRef.setInput('kind', kind);
  const saved = vi.fn();
  const announce = vi.fn();
  fixture.componentInstance.saved.subscribe(saved);
  fixture.componentInstance.announce.subscribe(announce);
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const select = fixture.debugElement.query(By.directive(AecSelect)).componentInstance as AecSelect;
  const saveButton = () =>
    [...el.querySelectorAll('button')].find((b) =>
      ['Save type', 'Saving…'].includes(b.textContent?.trim() ?? ''),
    )!;
  return { fixture, el, select, saveButton, saved, announce };
}

describe('ConnectorKindControl', () => {
  it('asks the host to close its dialog on Cancel (AECI-2202)', async () => {
    const ctx = await setup();
    const cancelled = vi.fn();
    ctx.fixture.componentInstance.cancelled.subscribe(cancelled);
    [...ctx.el.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Cancel')!.click();
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it('labels the stored kind and keeps Save off until the pick changes', async () => {
    const { el, saveButton } = await setup('sync_service');
    expect(el.textContent).toContain('Connector type');
    expect(el.textContent).toContain('Sync Service');
    expect(saveButton().disabled).toBe(true);
  });

  it('reads an unclassified product as Connector', async () => {
    const { el } = await setup(null);
    expect(el.textContent).toContain('Not set (shows as Connector)');
  });

  it('saves a new pick, announces it and tells the host', async () => {
    const { fixture, select, saveButton, saved, announce } = await setup(null);
    select.changed.emit('sync_service');
    fixture.detectChanges();
    expect(saveButton().disabled).toBe(false);
    saveButton().click();
    await fixture.whenStable();
    expect(api.setConnectorKind).toHaveBeenCalledWith(PRODUCT_ID, 'sync_service');
    expect(saved).toHaveBeenCalledWith('sync_service');
    expect(announce).toHaveBeenCalledWith('Connector type for Rivets Sync saved: Sync Service.');
  });

  it('clears the kind with null', async () => {
    const { fixture, select, saveButton } = await setup('integration_platform');
    select.changed.emit(null);
    fixture.detectChanges();
    saveButton().click();
    await fixture.whenStable();
    expect(api.setConnectorKind).toHaveBeenCalledWith(PRODUCT_ID, null);
  });

  it('says so when the product is no longer a connector', async () => {
    api.setConnectorKind.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'CONNECTOR_KIND_NOT_CONNECTOR' } },
      }),
    );
    const { fixture, el, select, saveButton, saved } = await setup(null);
    select.changed.emit('integration_platform');
    fixture.detectChanges();
    saveButton().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This product is no longer a connector',
    );
    expect(saved).not.toHaveBeenCalled();
  });

  it('says so when a live subscription blocks the change (AECI-2044)', async () => {
    api.setConnectorKind.mockRejectedValueOnce(
      new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'CONNECTOR_KIND_SUBSCRIBED' } },
      }),
    );
    const { fixture, el, select, saveButton, saved } = await setup('sync_service');
    select.changed.emit('integration_platform');
    fixture.detectChanges();
    saveButton().click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'This product holds a live Managed subscription',
    );
    expect(saved).not.toHaveBeenCalled();
  });
});
