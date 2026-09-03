import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
import { VendorStatus } from '../vendor/vendor-status';

import { UserMenu } from './user-menu';

/**
 * The user-menu trigger (AECI-259). The dropdown panel renders into a CDK
 * overlay that only mounts on click, and opening it needs a real signed-in
 * session, which no unit/e2e harness can fake — the same constraint that keeps
 * `SiteHeader`'s coverage at the component-spec level. So the menu items
 * (Account / Admin portal / Vendor portal / Sign out) are verified manually and
 * on staging, not in an automated overlay-open test. Here we pin the
 * always-rendered trigger: its accessible name, popup semantics, and the
 * pending-review badge.
 *
 * The badge lives here again. It sat on the header's "More" overflow trigger
 * while that menu carried the `/admin` IA; when the menu was retired the badge
 * followed the Admin door back to this control, which is the only always-visible
 * signed-in affordance at `lg+`.
 *
 * The load-bearing guarantee across every case below: **nothing role-gated may
 * render until the client-side probe resolves.** This header is server-rendered
 * into URL-keyed cached HTML, so an `/admin` href or a badge baked in at SSR
 * would leak to the next visitor of that URL (§8). `AdminStatus`/`VendorStatus`
 * both report `false` during SSR, and the "neutral by default" case pins that.
 */
describe('UserMenu trigger', () => {
  let isAdmin: ReturnType<typeof signal<boolean>>;
  let isVendor: ReturnType<typeof signal<boolean>>;

  beforeEach(() => {
    isAdmin = signal(false);
    isVendor = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AuthService, useValue: {} },
        AdminSummaryStore,
        // Stubbing the two status services (as site-header stubs SessionStatus)
        // severs the real RoleStatus → SessionStatus → AuthService probe chain,
        // so the empty AuthService stub above never hits the afterNextRender
        // `isConfigured()` call — and no spec touches HttpClient.
        { provide: AdminStatus, useValue: { isAdmin, ensureProbed: () => Promise.resolve() } },
        { provide: VendorStatus, useValue: { isVendor } },
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

  function seed(count: number): void {
    TestBed.inject(AdminSummaryStore).seed(count);
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

  it('is badge-free and role-neutral before the probe resolves', () => {
    seed(7); // a count alone must not reveal anything — isAdmin() is still false
    const el = render().nativeElement as HTMLElement;
    const button = trigger(el);
    expect(button.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(button.querySelector('span.sr-only')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });

  it('shows the pending-review badge once the visitor is a known admin', () => {
    const fixture = render();
    seed(3);
    isAdmin.set(true);
    fixture.detectChanges();

    const button = trigger(fixture.nativeElement as HTMLElement);
    expect(button.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('3');
    // The count is announced, not conveyed by the coloured dot alone.
    expect(button.getAttribute('aria-describedby')).toBe('aec-user-menu-pending');
    expect(button.querySelector('#aec-user-menu-pending')?.textContent?.trim()).toBe(
      '3 reviews pending moderation',
    );
  });

  it('caps the badge at 9+ so it cannot grow unbounded', () => {
    const fixture = render();
    seed(42);
    isAdmin.set(true);
    fixture.detectChanges();

    const button = trigger(fixture.nativeElement as HTMLElement);
    expect(button.querySelector('span[aria-hidden="true"]')?.textContent?.trim()).toBe('9+');
    // The exact count still reaches a screen reader.
    expect(button.querySelector('#aec-user-menu-pending')?.textContent?.trim()).toBe(
      '42 reviews pending moderation',
    );
  });

  it('shows no badge for an admin with an empty queue', () => {
    const fixture = render();
    seed(0);
    isAdmin.set(true);
    fixture.detectChanges();

    const button = trigger(fixture.nativeElement as HTMLElement);
    expect(button.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });
});
