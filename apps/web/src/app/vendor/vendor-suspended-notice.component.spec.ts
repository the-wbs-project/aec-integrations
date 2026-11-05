/**
 * `VendorSuspendedNotice` (AECI-1623): what a suspended vendor's seat sees. It reads nothing,
 * and its one call is the Stripe portal link. A failed call falls back to the notice email.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';

import { VendorApi } from './vendor-api';
import { VendorSuspendedNotice } from './vendor-suspended-notice';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve));

async function setup(openBillingPortal: ReturnType<typeof vi.fn>) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: VendorApi, useValue: { openBillingPortal } },
    ],
  });
  const fixture = TestBed.createComponent(VendorSuspendedNotice);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  const redirect = vi.fn();
  (fixture.componentInstance as unknown as { redirect: (url: string) => void }).redirect = redirect;
  fixture.detectChanges();
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const clickManage = async () => {
    el.querySelector('button')!.click();
    await settle();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  return { el, redirect, clickManage };
}

describe('VendorSuspendedNotice', () => {
  it('says what happened and where to look, and has one heading', async () => {
    const { el } = await setup(vi.fn());
    expect(el.querySelector('h1')?.textContent).toContain('suspended');
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    const text = (el.textContent ?? '').replace(/\s+/g, ' ');
    expect(text).toContain('Summit BIM');
    expect(text).toContain('owner seats and the billing email');
    expect(el.querySelector('a')?.getAttribute('href')).toBe('mailto:support@aecintegrations.com');
    expect(el.querySelector('button')?.textContent).toContain('Manage billing in Stripe');
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('moves to Stripe on success', async () => {
    const open = vi.fn(async () => ({ url: 'https://billing.stripe.test/s' }));
    const { redirect, clickManage } = await setup(open);
    await clickManage();
    expect(open).toHaveBeenCalledTimes(1);
    expect(redirect).toHaveBeenCalledWith('https://billing.stripe.test/s');
  });

  it('falls back to the notice email when the call fails', async () => {
    const open = vi.fn(async () => {
      throw { status: 403 };
    });
    const { el, redirect, clickManage } = await setup(open);
    await clickManage();
    expect(redirect).not.toHaveBeenCalled();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(
      'Reply to the notice email to cancel.',
    );
    expect(el.querySelector('button')?.disabled).toBe(false);
  });
});
