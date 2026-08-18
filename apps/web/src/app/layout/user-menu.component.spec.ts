import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AuthService } from '../auth/auth.service';
import { VendorStatus } from '../vendor/vendor-status';

import { UserMenu } from './user-menu';

/**
 * The user-menu trigger (AECI-259). The dropdown panel renders into a CDK
 * overlay that only mounts on click, and opening it needs a real signed-in
 * session, which no unit/e2e harness can fake — the same constraint that keeps
 * `SiteHeader`'s coverage at the component-spec level. So the menu items
 * (Account / Sign out) are verified manually / on staging, not in an automated
 * overlay-open test. Here we pin the always-rendered trigger: its accessible
 * name + popup semantics.
 *
 * The admin section and the pending-review badge moved to the header's "More"
 * overflow menu — their coverage lives in `nav-more-trigger.component.spec.ts`.
 * The last case below is the regression guard for that move: this trigger must
 * carry no badge and no described-by, whatever the admin state, because it no
 * longer injects `AdminStatus` / `AdminSummaryStore` at all.
 */
describe('UserMenu trigger', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
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

  it('carries no pending-review badge — that moved to the "More" trigger', () => {
    const el = render().nativeElement as HTMLElement;
    const button = trigger(el);
    expect(button.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(button.querySelector('span.sr-only')).toBeNull();
    expect(button.getAttribute('aria-describedby')).toBeNull();
  });
});
