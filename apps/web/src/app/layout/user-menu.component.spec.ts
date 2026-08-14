import { provideZonelessChangeDetection, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
import { VendorStatus } from '../vendor/vendor-status';

import { UserMenu } from './user-menu';

/**
 * The user-menu trigger + its pending-review badge (AECI-259). The dropdown
 * panel renders into a CDK overlay that only mounts on click, and opening it
 * needs a real signed-in session, which no unit/e2e harness can fake — the same
 * constraint that keeps `SiteHeader`'s coverage at the component-spec level. So
 * the menu items (Account / Admin section / Sign out) are verified manually / on
 * staging, not in an automated overlay-open test. Here we pin the
 * always-rendered trigger: its accessible name + popup semantics, the badge's
 * gating (admin AND pending > 0), exact count, the "9+" cap, and that the count
 * is wired to the trigger via `aria-describedby` so assistive tech announces it.
 */
describe('UserMenu trigger + badge', () => {
  let isAdmin: WritableSignal<boolean>;
  let pendingReviews: WritableSignal<number | null>;

  beforeEach(() => {
    isAdmin = signal(false);
    pendingReviews = signal<number | null>(null);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AdminStatus, useValue: { isAdmin } },
        { provide: AdminSummaryStore, useValue: { pendingReviews } },
        { provide: AuthService, useValue: {} },
        // The menu's "Vendor dashboard" item reads VendorStatus; stubbing it (as
        // site-header stubs SessionStatus) severs the real VendorStatus →
        // SessionStatus → AuthService probe chain, so the empty AuthService stub
        // above never hits the afterNextRender `isConfigured()` call.
        { provide: VendorStatus, useValue: { isVendor: signal(false) } },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(UserMenu);
    fixture.detectChanges();
    return fixture;
  }

  function trigger(el: HTMLElement): HTMLButtonElement {
    return el.querySelector('button[brnPopoverTrigger]') ?? el.querySelector('button')!;
  }

  it('renders a labelled, button-type trigger with collapsed popup semantics', () => {
    const el = render().nativeElement as HTMLElement;
    const button = trigger(el);
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-label')).toBe('Account menu');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows no badge for a non-admin even with pending reviews', () => {
    pendingReviews.set(5);
    const el = render().nativeElement as HTMLElement;
    expect(trigger(el).querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('shows no badge for an admin with zero pending reviews', () => {
    isAdmin.set(true);
    pendingReviews.set(0);
    const el = render().nativeElement as HTMLElement;
    expect(trigger(el).querySelector('span[aria-hidden="true"]')).toBeNull();
  });

  it('shows the exact count and an sr-only label for an admin with pending reviews', () => {
    isAdmin.set(true);
    pendingReviews.set(3);
    const el = render().nativeElement as HTMLElement;
    const button = trigger(el);
    expect(button.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('3');
    const srLabel = button.querySelector('span.sr-only');
    expect(srLabel?.textContent?.trim()).toContain('3 reviews pending moderation');
    // The label sits inside a button with its own aria-label, so it's only
    // announced when referenced — the trigger must point at it via described-by.
    const describedBy = button.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(srLabel?.id).toBe(describedBy);
  });

  it('drops the described-by reference when there is no badge', () => {
    isAdmin.set(true);
    pendingReviews.set(0);
    const el = render().nativeElement as HTMLElement;
    expect(trigger(el).getAttribute('aria-describedby')).toBeNull();
  });

  it('caps the badge at "9+" beyond nine pending reviews', () => {
    isAdmin.set(true);
    pendingReviews.set(12);
    const el = render().nativeElement as HTMLElement;
    expect(trigger(el).querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('9+');
  });
});
