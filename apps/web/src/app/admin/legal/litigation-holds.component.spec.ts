/**
 * `AdminLitigationHolds` on `/admin/legal` (AECI-1638, `ADMIN_PANEL_SPEC.md` §5.22b).
 *
 * What these tests hold in place:
 *
 *  1. **Open holds are listed with their scope, reason and matter**, and an empty list
 *     says the prune runs as the Privacy Policy describes.
 *  2. **Place needs a reason, and a vendor hold needs a vendor id.** A missing field is
 *     marked invalid and nothing is sent. A valid form sends the body the API parses.
 *  3. **A global hold cannot be placed twice**: the radio is disabled while one is open.
 *  4. **Release needs a reason** and sends it. A refused write shows its reason as an alert.
 */

import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateLitigationHoldRequest,
  LitigationHold,
  LitigationHoldsResponse,
} from '@aeci/shared';

import { AdminLegalApi } from './admin-legal-api';
import { AdminLitigationHolds, holdErrorMessage } from './litigation-holds';

const hold = (over: Partial<LitigationHold> = {}): LitigationHold => ({
  id: 'h-1',
  scope: 'vendor',
  vendor_id: 'v-1',
  vendor_name: 'Acme',
  reason: 'Demand letter received',
  matter_reference: 'AECI-9999',
  placed_by: 'admin-1',
  placed_at: '2026-11-17T10:00:00.000Z',
  released_at: null,
  released_by: null,
  release_reason: null,
  ...over,
});

const settle = () => new Promise((r) => setTimeout(r));

async function setup(
  data: LitigationHoldsResponse,
  opts: { place?: HttpErrorResponse; release?: HttpErrorResponse } = {},
) {
  const api = {
    litigationHolds: vi.fn(async () => structuredClone(data)),
    placeHold: vi.fn(async (body: CreateLitigationHoldRequest) => {
      if (opts.place) throw opts.place;
      return { hold: hold({ scope: body.scope, vendor_id: body.vendor_id ?? null }) };
    }),
    releaseHold: vi.fn(async (id: string, reason: string) => {
      if (opts.release) throw opts.release;
      return {
        hold: hold({ id, released_at: '2026-11-17T11:00:00.000Z', release_reason: reason }),
      };
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: AdminLegalApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(AdminLitigationHolds);
  document.body.appendChild(fixture.nativeElement);
  fixture.detectChanges();
  await fixture.whenStable();
  await settle();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const rerender = async () => {
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const click = async (selector: string) => {
    const target = el.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`no element for ${selector}`);
    target.click();
    await rerender();
  };
  const buttonByText = (text: string) =>
    [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === text,
    );
  const type = async (selector: string, value: string) => {
    const input = el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
    if (!input) throw new Error(`no input for ${selector}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await rerender();
  };
  const submit = async (selector: string) => {
    el.querySelector<HTMLFormElement>(selector)?.dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    await rerender();
    await rerender();
  };
  return { el, api, click, buttonByText, type, submit, rerender };
}

const EMPTY: LitigationHoldsResponse = {
  generated_at: '2026-11-17T12:00:00.000Z',
  open: [],
  released: [],
};

describe('AdminLitigationHolds', () => {
  it('lists an open hold with its scope, reason and matter', async () => {
    const { el } = await setup({ ...EMPTY, open: [hold()] });
    const card = el.querySelector('[data-testid="hold-open"]');
    expect(card?.textContent).toContain('Vendor: Acme');
    expect(card?.textContent).toContain('Demand letter received');
    expect(card?.textContent).toContain('AECI-9999');
    expect(card?.querySelector('a')?.getAttribute('href')).toBe('/admin/vendors/v-1');
  });

  it('says the prune runs as described when no hold is open', async () => {
    const { el } = await setup(EMPTY);
    expect(el.querySelector('[data-testid="holds-empty"]')?.textContent).toContain(
      'No hold is open',
    );
  });

  it('refuses to place a vendor hold with no vendor id or reason, and sends nothing', async () => {
    const { el, api, buttonByText, submit } = await setup(EMPTY);
    buttonByText('Place a hold')?.click();
    await settle();
    await submit('[data-testid="hold-place-form"]');

    expect(api.placeHold).not.toHaveBeenCalled();
    expect(el.querySelector('#admin-hold-vendor')?.getAttribute('aria-invalid')).toBe('true');
    expect(el.querySelector('#admin-hold-reason')?.getAttribute('aria-invalid')).toBe('true');
    expect(el.querySelector('#admin-hold-reason')?.getAttribute('aria-describedby')).toBe(
      'admin-hold-reason-error',
    );
  });

  it('places a vendor hold with the body the API parses, then re-reads the list', async () => {
    const { api, buttonByText, type, submit, rerender } = await setup(EMPTY);
    buttonByText('Place a hold')?.click();
    await rerender();
    await type('#admin-hold-vendor', '  v-1 ');
    await type('#admin-hold-reason', 'Demand letter');
    await type('#admin-hold-matter', 'AECI-9999');
    await submit('[data-testid="hold-place-form"]');

    expect(api.placeHold).toHaveBeenCalledWith({
      scope: 'vendor',
      vendor_id: 'v-1',
      reason: 'Demand letter',
      matter_reference: 'AECI-9999',
    });
    expect(api.litigationHolds).toHaveBeenCalledTimes(2);
  });

  it('places a global hold with no vendor id', async () => {
    const { api, el, buttonByText, type, submit, rerender } = await setup(EMPTY);
    buttonByText('Place a hold')?.click();
    await rerender();
    el.querySelector<HTMLInputElement>('#admin-hold-scope-global')?.dispatchEvent(
      new Event('change'),
    );
    await rerender();
    expect(el.querySelector('#admin-hold-vendor')).toBeNull();
    await type('#admin-hold-reason', 'Subpoena');
    await submit('[data-testid="hold-place-form"]');

    expect(api.placeHold).toHaveBeenCalledWith({
      scope: 'global',
      vendor_id: null,
      reason: 'Subpoena',
      matter_reference: null,
    });
  });

  it('disables the global choice while a global hold is open', async () => {
    const { el, buttonByText, rerender } = await setup({
      ...EMPTY,
      open: [hold({ scope: 'global', vendor_id: null, vendor_name: null })],
    });
    buttonByText('Place a hold')?.click();
    await rerender();
    expect(el.querySelector<HTMLInputElement>('#admin-hold-scope-global')?.disabled).toBe(true);
  });

  it('shows a refused place as an alert', async () => {
    const { el, buttonByText, type, submit, rerender } = await setup(EMPTY, {
      place: new HttpErrorResponse({
        status: 409,
        error: { error: { code: 'LITIGATION_HOLD_EXISTS', message: 'exists' } },
      }),
    });
    buttonByText('Place a hold')?.click();
    await rerender();
    await type('#admin-hold-vendor', 'v-1');
    await type('#admin-hold-reason', 'Demand');
    await submit('[data-testid="hold-place-form"]');

    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'An open hold already covers this scope',
    );
  });

  it('releases a hold only with a reason', async () => {
    const { el, api, buttonByText, type, submit, rerender } = await setup({
      ...EMPTY,
      open: [hold()],
    });
    buttonByText('Release hold')?.click();
    await rerender();
    const form = '[data-testid="hold-open"] form';
    await submit(form);
    expect(api.releaseHold).not.toHaveBeenCalled();
    expect(el.querySelector('#admin-hold-release-h-1')?.getAttribute('aria-invalid')).toBe('true');

    await type('#admin-hold-release-h-1', 'Matter settled');
    await submit(form);
    expect(api.releaseHold).toHaveBeenCalledWith('h-1', 'Matter settled');
  });

  it('lists recently released holds', async () => {
    const { el } = await setup({
      ...EMPTY,
      released: [
        hold({ released_at: '2026-11-17T11:00:00.000Z', release_reason: 'Matter settled' }),
      ],
    });
    expect(el.querySelector('[data-testid="holds-released"]')?.textContent).toContain(
      'Matter settled',
    );
  });

  it('maps each refusal to a sentence', () => {
    const err = (status: number, code?: string) =>
      new HttpErrorResponse({ status, error: code ? { error: { code } } : null });
    expect(holdErrorMessage(err(409, 'LITIGATION_HOLD_RELEASED'))).toContain('already released');
    expect(holdErrorMessage(err(404))).toContain('No vendor or hold has that id');
    expect(holdErrorMessage(err(429))).toContain('Too many changes');
    expect(holdErrorMessage(new Error('x'))).toContain('Something went wrong');
  });
});

describe('AdminLitigationHolds focus and buttons (AECI-2128)', () => {
  const escape = (target: EventTarget | null) =>
    target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

  it('Escape closes the place form and returns focus to "Place a hold"', async () => {
    const { el, click, rerender } = await setup(EMPTY);
    await click('#admin-hold-place-open');
    escape(el.querySelector('#admin-hold-reason'));
    await rerender();
    expect(el.querySelector('[data-testid="hold-place-form"]')).toBeNull();
    expect(document.activeElement?.id).toBe('admin-hold-place-open');
  });

  it('Escape does nothing while a place is in flight', async () => {
    const { el, api, click, type, submit, rerender } = await setup(EMPTY);
    let resolve!: () => void;
    api.placeHold.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = () => r({ hold: hold() });
        }),
    );
    await click('#admin-hold-place-open');
    await type('#admin-hold-vendor', 'v-1');
    await type('#admin-hold-reason', 'Demand');
    await submit('[data-testid="hold-place-form"]');
    escape(el.querySelector('#admin-hold-reason'));
    await rerender();
    expect(el.querySelector('[data-testid="hold-place-form"]')).not.toBeNull();
    resolve();
    await rerender();
    await rerender();
  });

  it('a refused place moves focus to its error', async () => {
    const { el, click, type, submit } = await setup(EMPTY, {
      place: new HttpErrorResponse({ status: 429 }),
    });
    await click('#admin-hold-place-open');
    await type('#admin-hold-vendor', 'v-1');
    await type('#admin-hold-reason', 'Demand');
    await submit('[data-testid="hold-place-form"]');
    expect(document.activeElement?.id).toBe('admin-hold-place-failed');
    expect(el.querySelector('#admin-hold-place-failed')?.getAttribute('role')).toBe('alert');
  });

  it('Escape closes the release form and returns focus to its Release hold button', async () => {
    const { el, click, rerender } = await setup({ ...EMPTY, open: [hold()] });
    await click('#admin-hold-release-open-h-1');
    escape(el.querySelector('#admin-hold-release-h-1'));
    await rerender();
    expect(el.querySelector('[data-testid="hold-release-form"]')).toBeNull();
    expect(document.activeElement?.id).toBe('admin-hold-release-open-h-1');
  });

  it('Escape does nothing while a release is in flight', async () => {
    const { el, api, click, type, submit, rerender } = await setup({ ...EMPTY, open: [hold()] });
    let resolve!: () => void;
    api.releaseHold.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = () => r({ hold: hold({ released_at: '2026-11-17T11:00:00.000Z' }) });
        }),
    );
    await click('#admin-hold-release-open-h-1');
    await type('#admin-hold-release-h-1', 'Matter settled');
    await submit('[data-testid="hold-release-form"]');
    escape(el.querySelector('#admin-hold-release-h-1'));
    await rerender();
    expect(el.querySelector('[data-testid="hold-release-form"]')).not.toBeNull();
    resolve();
    await rerender();
    await rerender();
  });

  it('a release with the place form open lands focus on the section heading', async () => {
    const { el, click, type, submit, rerender } = await setup({ ...EMPTY, open: [hold()] });
    await click('#admin-hold-place-open');
    await click('#admin-hold-release-open-h-1');
    await type('#admin-hold-release-h-1', 'Matter settled');
    await submit('[data-testid="hold-release-form"]');
    await rerender();
    // "Place a hold" is not rendered while its form is open.
    expect(el.querySelector('[data-testid="hold-place-form"]')).not.toBeNull();
    expect(el.querySelector('#admin-hold-place-open')).toBeNull();
    expect(document.activeElement?.id).toBe('admin-legal-holds-h');
  });

  it('a release with the place form closed lands focus on "Place a hold"', async () => {
    const { click, type, submit, rerender } = await setup({ ...EMPTY, open: [hold()] });
    await click('#admin-hold-release-open-h-1');
    await type('#admin-hold-release-h-1', 'Matter settled');
    await submit('[data-testid="hold-release-form"]');
    await rerender();
    expect(document.activeElement?.id).toBe('admin-hold-place-open');
  });

  it('a refused release moves focus to its error', async () => {
    const { click, type, submit } = await setup(
      { ...EMPTY, open: [hold()] },
      { release: new HttpErrorResponse({ status: 429 }) },
    );
    await click('#admin-hold-release-open-h-1');
    await type('#admin-hold-release-h-1', 'Matter settled');
    await submit('[data-testid="hold-release-form"]');
    expect(document.activeElement?.id).toBe('admin-hold-release-failed-h-1');
  });

  it('openers are secondary; place confirms primary, release confirms danger', async () => {
    const { el, click, buttonByText } = await setup({ ...EMPTY, open: [hold()] });
    expect(el.querySelector('#admin-hold-place-open')?.className).toContain('aec-btn-secondary');
    expect(el.querySelector('#admin-hold-release-open-h-1')?.className).toContain(
      'aec-btn-secondary',
    );
    await click('#admin-hold-place-open');
    expect(buttonByText('Place the hold')?.className).toContain('aec-btn');
    expect(buttonByText('Place the hold')?.className).not.toContain('aec-btn-secondary');
    expect(buttonByText('Place the hold')?.className).toContain('bg-(--accent-primary)');
    await click('#admin-hold-release-open-h-1');
    expect(buttonByText('Release the hold')?.className).toContain('status-error');
  });
});
