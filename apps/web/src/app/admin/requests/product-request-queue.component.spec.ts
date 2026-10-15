/**
 * The product request section of `/admin/requests` (AECI-1377,
 * `docs/ADMIN_PANEL_SPEC.md` §5.16, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6): what the
 * vendor typed, the three outcome forms, the badge decrement, the `422` for an
 * unpromoted product and the `422` for a request another admin decided.
 */
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AdminProductRequest } from '@aeci/shared';

import { PRODUCT_COMBOBOX_DEBOUNCE_MS } from '../../shared/product-combobox/product-combobox';
import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';
import { ProductRequestQueue } from './product-request-queue';

const PROCORE = {
  id: '00000000-0000-4000-8000-000000005301',
  slug: 'procore',
  name: 'Procore',
  logo_url: null,
  vendor: { id: '00000000-0000-4000-8000-000000005601', slug: 'p', name: 'Procore Inc' },
};

function row(over: Partial<AdminProductRequest> = {}): AdminProductRequest {
  return {
    id: '00000000-0000-4000-8000-0000000071a1',
    status: 'open',
    vendor_id: '00000000-0000-4000-8000-000000005200',
    vendor: { id: '00000000-0000-4000-8000-000000005200', slug: 'summit', name: 'Summit BIM' },
    requested_by: '00000000-0000-4000-8000-000000000001',
    context_product_id: '00000000-0000-4000-8000-000000005201',
    context_product: {
      id: '00000000-0000-4000-8000-000000005201',
      slug: 'summit-model-coordination',
      name: 'Summit Model Coordination',
    },
    name: 'Procore Cloud',
    maker: 'Procore Technologies',
    website: 'https://procore.example.com',
    body: 'We sync RFIs.',
    created_at: '2026-10-14T08:00:00.000Z',
    resolved_at: null,
    resolved_by: null,
    decline_reason: null,
    resolved_product: null,
    ...over,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

async function setup(rows: AdminProductRequest[], decide = vi.fn(async () => row())) {
  TestBed.resetTestingModule();
  const api = {
    listProductRequests: vi.fn(async () => ({
      data: rows,
      page: 1,
      perPage: 100,
      total: rows.length,
    })),
    decideProductRequest: decide,
    searchProducts: vi.fn(async () => ({ data: [PROCORE], total: 1, page: 1, perPage: 8 })),
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
  const fixture = TestBed.createComponent(ProductRequestQueue);
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
/** A row's decision button. The filter has buttons with the same labels. */
const action = (el: HTMLElement, key: string) =>
  el.querySelector<HTMLButtonElement>(`[data-decision="${key}"]`)!;
const button = (el: HTMLElement, label: string) =>
  [...el.querySelectorAll('button')].find((b) => text(b) === label)!;

async function pickProcore(fixture: ComponentFixture<unknown>, el: HTMLElement): Promise<void> {
  const input = el.querySelector<HTMLInputElement>('[data-product-combobox-input]')!;
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  input.value = 'pro';
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await render(fixture);
  await new Promise((resolve) => setTimeout(resolve, PRODUCT_COMBOBOX_DEBOUNCE_MS + 30));
  await render(fixture);
  const option = document.querySelector<HTMLElement>('[data-product-option]')!;
  option.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  option.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await render(fixture);
}

async function confirm(fixture: ComponentFixture<unknown>, el: HTMLElement): Promise<void> {
  el.querySelector('form')!.dispatchEvent(new Event('submit'));
  await render(fixture);
}

afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
  vi.restoreAllMocks();
});

describe('ProductRequestQueue', () => {
  it('lists open requests with the vendor, their product, the typed fields and the note', async () => {
    const { el, api } = await setup([row()]);
    expect(api.listProductRequests).toHaveBeenCalledWith({
      status: 'open',
      page: 1,
      perPage: 100,
    });
    expect(text(el.querySelector('h2'))).toBe('Product requests from vendors');
    const card = el.querySelector('article')!;
    expect(text(card.querySelector('h3'))).toBe('Procore Cloud');
    expect(text(card)).toMatch(/Maker\s*Procore Technologies/);
    expect(text(card)).toMatch(/Vendor\s*Summit BIM/);
    expect(text(card)).toMatch(/Their product\s*Summit Model Coordination/);
    expect(text(card)).toContain('https://procore.example.com');
    expect(text(card)).toContain('Note We sync RFIs.');
    const site = card.querySelector<HTMLAnchorElement>('a[target="_blank"]')!;
    expect(site.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    expect(site.getAttribute('href')).toBe('https://procore.example.com');
  });

  it('marks a request Added with the product chosen in the picker, and decrements the badge', async () => {
    const { fixture, el, api, decrement } = await setup([row()]);
    action(el, 'added').click();
    await render(fixture);
    await pickProcore(fixture, el);
    expect(text(el.querySelector('[data-testid="product-request-chosen"]'))).toContain('Procore');
    await confirm(fixture, el);
    expect(api.decideProductRequest).toHaveBeenCalledWith(row().id, {
      outcome: 'added',
      product_id: PROCORE.id,
    });
    expect(el.querySelector('article')).toBeNull();
    expect(decrement).toHaveBeenCalledWith('requests');
    expect(text(el.querySelector('[role="status"]'))).toContain('marked as added');
  });

  it('marks a request Already listed with the chosen product', async () => {
    const { fixture, el, api } = await setup([row()]);
    action(el, 'already_listed').click();
    await render(fixture);
    await pickProcore(fixture, el);
    await confirm(fixture, el);
    expect(api.decideProductRequest).toHaveBeenCalledWith(row().id, {
      outcome: 'already_listed',
      product_id: PROCORE.id,
    });
  });

  it('sends nothing for Added until a product is chosen', async () => {
    const { fixture, el, api } = await setup([row()]);
    action(el, 'added').click();
    await render(fixture);
    await confirm(fixture, el);
    expect(api.decideProductRequest).not.toHaveBeenCalled();
    expect(text(el.querySelector('[role="alert"]'))).toContain('Choose the product');
  });

  it('declines with a required reason the vendor is told it will see', async () => {
    const { fixture, el, api } = await setup([row()]);
    action(el, 'declined').click();
    await render(fixture);
    expect(text(el.querySelector('form'))).toContain('The vendor sees this reason.');
    await confirm(fixture, el);
    expect(api.decideProductRequest).not.toHaveBeenCalled();
    expect(text(el.querySelector('[role="alert"]'))).toContain('Enter a reason');

    const reason = el.querySelector<HTMLTextAreaElement>('textarea')!;
    reason.value = '  Not AEC software.  ';
    reason.dispatchEvent(new Event('input'));
    await render(fixture);
    await confirm(fixture, el);
    expect(api.decideProductRequest).toHaveBeenCalledWith(row().id, {
      outcome: 'declined',
      reason: 'Not AEC software.',
    });
  });

  it('keeps the form open and says so when the product is not promoted', async () => {
    const decide = vi.fn(async () => {
      throw apiError(422, 'PRODUCT_NOT_PROMOTED');
    });
    const { fixture, el, decrement } = await setup([row()], decide);
    action(el, 'added').click();
    await render(fixture);
    await pickProcore(fixture, el);
    await confirm(fixture, el);
    expect(el.querySelector('article')).not.toBeNull();
    expect(text(el.querySelector('[role="alert"]'))).toContain('not promoted yet');
    expect(decrement).not.toHaveBeenCalled();
  });

  it('drops a request another admin already decided, without touching the badge', async () => {
    const decide = vi.fn(async () => {
      throw apiError(422, 'INVALID_STATE_TRANSITION');
    });
    const { fixture, el, decrement } = await setup([row()], decide);
    action(el, 'declined').click();
    await render(fixture);
    const reason = el.querySelector<HTMLTextAreaElement>('textarea')!;
    reason.value = 'Out of scope.';
    reason.dispatchEvent(new Event('input'));
    await render(fixture);
    await confirm(fixture, el);
    expect(el.querySelector('article')).toBeNull();
    expect(text(el.querySelector('[role="status"]'))).toContain('already decided');
    expect(decrement).not.toHaveBeenCalled();
  });

  it('shows the outcome on a decided row, with no actions', async () => {
    const { el } = await setup([row({ status: 'declined', decline_reason: 'Not AEC software.' })]);
    expect(text(el.querySelector('[data-testid="product-request-outcome"]'))).toBe(
      'Declined. Reason: Not AEC software.',
    );
    expect(el.querySelector('[data-decision]')).toBeNull();
  });

  it('re-reads by status from the filter', async () => {
    const { fixture, el, api } = await setup([]);
    expect(text(el)).toContain('No product requests match this filter.');
    button(el, 'Declined').click();
    await render(fixture);
    expect(api.listProductRequests).toHaveBeenLastCalledWith({
      status: 'declined',
      page: 1,
      perPage: 100,
    });
  });
});
