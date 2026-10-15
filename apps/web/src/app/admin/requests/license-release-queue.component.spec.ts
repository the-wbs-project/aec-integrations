/**
 * The early-unassign section of `/admin/requests` (AECI-1373,
 * `docs/ADMIN_PANEL_SPEC.md` §5.17): the row, the approve confirmation, the required
 * decline reason, the badge decrement, the "Already decided" reload on a lost race
 * (no decrement), the license-moved refusal, decided rows, and the filter.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type { AdminLicenseReleaseRequest } from '@aeci/shared';

import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';
import { LicenseReleaseQueue } from './license-release-queue';

const VENDOR_ID = '00000000-0000-4000-8000-000000005200';
const PRODUCT_ID = '00000000-0000-4000-8000-000000005201';

function row(over: Partial<AdminLicenseReleaseRequest> = {}): AdminLicenseReleaseRequest {
  return {
    id: '00000000-0000-4000-8000-0000000081a1',
    status: 'open',
    license_id: 'lic-1',
    vendor_id: VENDOR_ID,
    vendor: { id: VENDOR_ID, slug: 'summit', name: 'Summit BIM' },
    billing_account_id: 'ba-1',
    product_id: PRODUCT_ID,
    product: { id: PRODUCT_ID, slug: 'summit-coord', name: 'Summit Coordination' },
    requested_by: '00000000-0000-4000-8000-000000000001',
    reason: 'We retired this product.',
    created_at: '2026-10-14T08:00:00.000Z',
    decided_by: null,
    decided_at: null,
    decision_note: null,
    license: {
      source: 'invoice',
      starts_at: '2026-01-01T00:00:00.000Z',
      ends_at: '2027-06-30T00:00:00.000Z',
      ended_at: null,
      assigned_product_id: PRODUCT_ID,
    },
    ...over,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

async function setup(rows: AdminLicenseReleaseRequest[], decide = vi.fn(async () => row())) {
  TestBed.resetTestingModule();
  const api = {
    listLicenseReleaseRequests: vi.fn(async () => ({
      data: rows,
      page: 1,
      perPage: 100,
      total: rows.length,
    })),
    decideLicenseReleaseRequest: decide,
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminRequestsApi, useValue: api },
    ],
  });
  const store = TestBed.inject(AdminSummaryStore);
  const decrement = vi.spyOn(store, 'decrement');
  const fixture = TestBed.createComponent(LicenseReleaseQueue);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  return { fixture, api, decrement, el: fixture.nativeElement as HTMLElement };
}

async function render(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await settle();
  fixture.detectChanges();
}

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
const action = (el: HTMLElement, key: string) =>
  el.querySelector<HTMLButtonElement>(`[data-decision="${key}"]`)!;
const live = (el: HTMLElement) => text(el.querySelector('[role="status"]'));

async function confirm(fixture: ComponentFixture<unknown>, el: HTMLElement): Promise<void> {
  el.querySelector('form')!.dispatchEvent(new Event('submit'));
  await render(fixture);
}

async function typeReason(fixture: ComponentFixture<unknown>, el: HTMLElement, value: string) {
  const area = el.querySelector<HTMLTextAreaElement>('textarea')!;
  area.value = value;
  area.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await render(fixture);
}

describe('LicenseReleaseQueue', () => {
  it('renders the section with its own h2, filter and an open row', async () => {
    const { el, api } = await setup([row()]);
    expect(api.listLicenseReleaseRequests).toHaveBeenCalledWith({
      status: 'open',
      page: 1,
      perPage: 100,
    });
    expect(text(el.querySelector('h2'))).toBe('Early-unassign requests');
    const group = el.querySelector('[role="group"]')!;
    expect(group.getAttribute('aria-labelledby')).toBe('admin-license-releases-heading');
    const card = el.querySelector('article')!;
    expect(text(card.querySelector('h3'))).toBe('Summit Coordination');
    expect(text(card)).toContain('Summit BIM');
    expect(text(card)).toContain('Term ends Jun 30, 2027');
    expect(text(card)).toContain('We retired this product.');
    expect(card.querySelector('a')?.getAttribute('href')).toBe(
      `/admin/vendors/${VENDOR_ID}?tab=billing`,
    );
  });

  it('approves after a confirmation that says what happens, and decrements the badge', async () => {
    const decide = vi.fn(async () => row({ status: 'approved' }));
    const { fixture, el, decrement } = await setup([row()], decide);
    action(el, 'approve').click();
    await render(fixture);
    expect(text(el.querySelector('[data-testid="license-release-summary"]'))).toContain(
      'stays live and its term dates do not change',
    );
    expect(decide).not.toHaveBeenCalled();
    await confirm(fixture, el);
    expect(decide).toHaveBeenCalledWith(row().id, { action: 'approve' });
    expect(decrement).toHaveBeenCalledWith('requests');
    expect(el.querySelectorAll('article')).toHaveLength(0);
    expect(live(el)).toContain('License freed from Summit Coordination');
  });

  it('requires a decline reason, then sends it trimmed', async () => {
    const decide = vi.fn(async () => row({ status: 'declined' }));
    const { fixture, el, decrement } = await setup([row()], decide);
    action(el, 'decline').click();
    await render(fixture);
    await confirm(fixture, el);
    expect(decide).not.toHaveBeenCalled();
    expect(text(el.querySelector('[role="alert"]'))).toBe('Enter a reason. The vendor sees it.');

    await typeReason(fixture, el, '  Not before renewal.  ');
    await confirm(fixture, el);
    expect(decide).toHaveBeenCalledWith(row().id, {
      action: 'decline',
      reason: 'Not before renewal.',
    });
    expect(decrement).toHaveBeenCalledWith('requests');
  });

  it('announces "Already decided" and reloads without decrementing on RELEASE_REQUEST_NOT_OPEN', async () => {
    const decide = vi.fn(async () => {
      throw apiError(409, 'RELEASE_REQUEST_NOT_OPEN');
    });
    const { fixture, el, api, decrement } = await setup([row()], decide);
    action(el, 'approve').click();
    await render(fixture);
    await confirm(fixture, el);
    expect(decrement).not.toHaveBeenCalled();
    expect(live(el)).toContain('Already decided');
    expect(api.listLicenseReleaseRequests).toHaveBeenCalledTimes(2);
  });

  it('keeps the form open and says to decline when the license moved', async () => {
    const decide = vi.fn(async () => {
      throw apiError(409, 'LICENSE_NOT_ASSIGNED');
    });
    const { fixture, el, decrement } = await setup([row()], decide);
    action(el, 'approve').click();
    await render(fixture);
    await confirm(fixture, el);
    expect(decrement).not.toHaveBeenCalled();
    expect(text(el.querySelector('[role="alert"]'))).toContain('Decline the request instead');
    expect(el.querySelector('form')).not.toBeNull();
  });

  it('disables Approve on a row whose license is no longer on the product', async () => {
    const { el } = await setup([
      row({
        license: {
          source: 'invoice',
          starts_at: '2026-01-01T00:00:00.000Z',
          ends_at: null,
          ended_at: null,
          assigned_product_id: null,
        },
      }),
    ]);
    expect(action(el, 'approve').disabled).toBe(true);
    expect(action(el, 'decline').disabled).toBe(false);
    expect(el.querySelector('[data-testid="license-release-moved"]')).not.toBeNull();
    expect(text(el.querySelector('article'))).toContain('Monthly, renews until cancelled');
  });

  it('shows a decided row with its outcome and no actions, and refetches on a filter change', async () => {
    const { fixture, el, api } = await setup([
      row({ status: 'declined', decision_note: 'Not yet.', product: null }),
    ]);
    const card = el.querySelector('article')!;
    expect(text(card.querySelector('h3'))).toBe('A product no longer on record');
    expect(text(card.querySelector('[data-testid="license-release-outcome"]'))).toBe(
      'Declined. Reason: Not yet.',
    );
    expect(el.querySelector('[data-decision]')).toBeNull();

    const approved = [...el.querySelectorAll('[role="group"] button')].find(
      (b) => text(b) === 'Approved',
    ) as HTMLButtonElement;
    approved.click();
    await render(fixture);
    expect(api.listLicenseReleaseRequests).toHaveBeenLastCalledWith({
      status: 'approved',
      page: 1,
      perPage: 100,
    });
    expect(approved.getAttribute('aria-pressed')).toBe('true');
  });

  it('says so when nothing matches the filter', async () => {
    const { el } = await setup([]);
    expect(text(el)).toContain('No early-unassign requests match this filter.');
  });
});
