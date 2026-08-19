/**
 * AECI-606 — the tabbed dashboard shell's new Integrations tab.
 *
 * The shell had no spec before this (it was covered only by the e2e). These
 * cases pin the three edit points §6 names — the `Tab` union, the `tabs` array,
 * and the `@switch` — plus the property that makes the whole surface work:
 * the shell stays presentational and passes the verified flag down rather than
 * gating anything itself.
 *
 * AECI-631 adds the two properties that make it LIVE
 * (`docs/STAGE_2_REALTIME_SPEC.md` §6): a refetched `me` re-derives the whole
 * surface without a reload (§6.1), and the portal has exactly one polite live
 * region, here in the shell (§6.3).
 */
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from './vendor-announcer';
import { VendorApi } from './vendor-api';
import {
  VENDOR_ME_DOWNGRADED_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from './vendor-fixtures';
import { VendorDashboardTabbed } from './vendor-dashboard-tabbed';
import { VendorPortalStore } from './vendor-portal-store';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      {
        provide: VendorApi,
        useValue: {
          getSeats: vi.fn().mockResolvedValue({ seats: [] }),
          getTaxonomy: vi.fn().mockResolvedValue({
            categories: [],
            audiences: [],
            phases: [],
            trades: [],
          }),
          getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
          getDataObjects: vi.fn().mockResolvedValue({ data_objects: [] }),
          listProductVersions: vi.fn().mockResolvedValue({ versions: [] }),
          getNotifications: vi.fn().mockResolvedValue({ notifications: [] }),
        } as Partial<VendorApi>,
      },
      VendorPortalStore,
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

function create(me: VendorMeResponse = VENDOR_ME_FIXTURE): ComponentFixture<VendorDashboardTabbed> {
  const fixture = TestBed.createComponent(VendorDashboardTabbed);
  fixture.componentRef.setInput('me', me);
  fixture.detectChanges();
  return fixture;
}

function navButton(fixture: ComponentFixture<VendorDashboardTabbed>, label: string) {
  const el = fixture.nativeElement as HTMLElement;
  const button = [...el.querySelectorAll('nav button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no nav button "${label}"`);
  return button as HTMLButtonElement;
}

describe('VendorDashboardTabbed — the Integrations tab', () => {
  it('offers Integrations in the side nav, between Products and Seats', () => {
    const labels = [...(create().nativeElement as HTMLElement).querySelectorAll('nav button')].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toEqual(['Overview', 'Profile', 'Products', 'Integrations', 'Seats']);
  });

  it('does not render the section until the tab is activated', () => {
    // `@switch` means the heavier read only happens when a vendor asks for it.
    const el = create().nativeElement as HTMLElement;
    expect(el.querySelector('aec-vendor-integrations-section')).toBeNull();
  });

  it('renders the section and moves aria-current on activation', async () => {
    const fixture = create();
    navButton(fixture, 'Integrations').click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(navButton(fixture, 'Integrations').getAttribute('aria-current')).toBe('page');
    expect(navButton(fixture, 'Overview').getAttribute('aria-current')).toBeNull();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Integrations');
  });

  it('passes the verified flag down rather than gating in the shell', async () => {
    const fixture = create(VENDOR_ME_UNVERIFIED_FIXTURE);
    navButton(fixture, 'Integrations').click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // The shell stays presentational: the section renders either way and
    // decides for itself what to withhold.
    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(el.textContent).toContain('once your account is verified');
  });
});

/**
 * AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8 + §4.3 — the shell's half of the
 * invariant. The API half (`GET /api/vendor/me` answers 200 with the downgraded
 * block for a `revoked`/`expired` vendor) is pinned by
 * `apps/api/src/routes/vendor.entitlement.spec.ts`. This is the other end of the
 * same wire: given that payload, the DASHBOARD renders — the whole surface, every
 * tab, with a renewal path — rather than degrading into a not-found. A vendor who
 * cannot reach the dashboard can never see the notice this epic exists to show.
 */
describe('VendorDashboardTabbed — the downgraded entitlement (§4.3 / §8)', () => {
  it('renders the FULL dashboard for a revoked vendor, never a dead end', () => {
    const el = create(VENDOR_ME_DOWNGRADED_FIXTURE).nativeElement as HTMLElement;

    // Same shell, same tabs, same company name. Nothing is withheld structurally.
    expect([...el.querySelectorAll('nav button')].map((b) => b.textContent?.trim())).toEqual([
      'Overview',
      'Profile',
      'Products',
      'Integrations',
      'Seats',
    ]);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe(
      VENDOR_ME_DOWNGRADED_FIXTURE.vendor.company_name,
    );
    // §5.2: clearing an entitlement does not revoke seats, and the readout says so.
    expect(el.textContent).toContain(String(VENDOR_ME_DOWNGRADED_FIXTURE.seat_count));
  });

  it('shows the plan panel with a renewal path on Overview', () => {
    const el = create(VENDOR_ME_DOWNGRADED_FIXTURE).nativeElement as HTMLElement;

    expect(el.querySelector('aec-vendor-plan-panel')).not.toBeNull();
    expect(el.querySelector('a[href="/contact"]')?.textContent?.trim()).toBe('Renew verification');
    expect(el.textContent).toContain('no longer active');
  });

  it('drives the profile form read-only off CAPABILITIES, not vendor.verified', () => {
    const fixture = create(VENDOR_ME_DOWNGRADED_FIXTURE);
    navButton(fixture, 'Profile').click();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).toBeNull();
    expect(
      [...el.querySelectorAll<HTMLInputElement>('input, textarea')].every((f) => f.readOnly),
    ).toBe(true);
  });

  it('leaves the paid vendor forms editable — the launch behaviour is unchanged', () => {
    const fixture = create(VENDOR_ME_FIXTURE);
    navButton(fixture, 'Profile').click();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).not.toBeNull();
  });
});

/**
 * AECI-631 / §6.1 — the concierge flip lands without a reload.
 *
 * `me` is bound to `VendorPortalStore.me` on the real route, so a refetch of
 * `GET /api/vendor/me` arrives here as a new input value and nothing more.
 * `setInput` is exactly that event: the component instance is never recreated,
 * which is the point — anything that latched the entitlement at construction
 * would pass a fresh-render test and fail this one.
 */
describe('VendorDashboardTabbed — a refetched `me` (§6.1)', () => {
  it('re-derives the capability gate, so the profile form unlocks in place', () => {
    const fixture = create(VENDOR_ME_DOWNGRADED_FIXTURE);
    navButton(fixture, 'Profile').click();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Editing is paused');

    // The operator granted the entitlement while the vendor sat on this tab.
    fixture.componentRef.setInput('me', VENDOR_ME_FIXTURE);
    fixture.detectChanges();

    expect(el.textContent).not.toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).not.toBeNull();
  });

  it('re-derives it in the other direction too, so a revoke closes the forms', () => {
    const fixture = create(VENDOR_ME_FIXTURE);
    navButton(fixture, 'Profile').click();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('form button[type="submit"]')).not.toBeNull();

    fixture.componentRef.setInput('me', VENDOR_ME_DOWNGRADED_FIXTURE);
    fixture.detectChanges();

    expect(el.textContent).toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).toBeNull();
  });

  it('moves the plan panel from lapsed to verified on the Overview tab', () => {
    const fixture = create(VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = fixture.nativeElement as HTMLElement;

    expect(el.textContent).toContain('no longer active');
    expect(el.querySelector('aec-verified-badge')).toBeNull();

    fixture.componentRef.setInput('me', VENDOR_ME_FIXTURE);
    fixture.detectChanges();

    expect(el.textContent).not.toContain('no longer active');
    expect(el.querySelector('aec-verified-badge')).not.toBeNull();
  });

  it('opens the Integrations tab controls, because `verified` is a mirror of the same row', async () => {
    const fixture = create(VENDOR_ME_DOWNGRADED_FIXTURE);
    navButton(fixture, 'Integrations').click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('once your account is verified');

    fixture.componentRef.setInput('me', VENDOR_ME_FIXTURE);
    fixture.detectChanges();

    expect(el.textContent).not.toContain('once your account is verified');
  });

  it('takes the capability list from the payload rather than re-deriving the tier ladder', () => {
    // A tier this build does not recognise resolves to zero capabilities
    // server-side. A browser that re-implemented the ladder would fail OPEN on
    // exactly that tier; reading the resolved list fails closed with the API.
    const fixture = create({
      ...VENDOR_ME_FIXTURE,
      entitlement: {
        ...VENDOR_ME_FIXTURE.entitlement,
        tier: 'some-future-tier' as VendorMeResponse['entitlement']['tier'],
        capabilities: [],
      },
    });
    navButton(fixture, 'Profile').click();
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Editing is paused');
  });
});

/**
 * AECI-631 / §6.3 — the a11y contract. ONE polite live region, in the shell.
 *
 * Two regions on one page make announcements race and duplicate: the screen
 * reader gets two competing queued utterances for one event and the vendor hears
 * the wrong one, or both. The count assertions are the guard against a future
 * section quietly adding its own.
 */
describe('VendorDashboardTabbed — the one live region (§6.3)', () => {
  const liveRegions = (fixture: ComponentFixture<VendorDashboardTabbed>) =>
    (fixture.nativeElement as HTMLElement).querySelectorAll(
      '[role="status"], [role="alert"], [aria-live]',
    );

  it('renders exactly one, and it is polite, sr-only and initially silent', () => {
    const fixture = create();
    const regions = liveRegions(fixture);

    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute('role')).toBe('status');
    // `role="status"` is implicitly polite. An explicit `assertive` anywhere on
    // this surface would make a background revalidation an interruption.
    expect(regions[0].getAttribute('aria-live')).not.toBe('assertive');
    expect(regions[0].classList.contains('sr-only')).toBe(true);
    expect(regions[0].textContent?.trim()).toBe('');
  });

  it('stays at exactly one with the Integrations tab open', async () => {
    const fixture = create();
    navButton(fixture, 'Integrations').click();
    fixture.detectChanges();
    await flush();
    fixture.detectChanges();

    // The section's loading/failure paragraphs and the card's pivot notice are
    // deliberately not live regions.
    expect(liveRegions(fixture)).toHaveLength(1);
  });

  it('carries whatever the portal announces', () => {
    const fixture = create();
    TestBed.inject(VendorPortalAnnouncer).announce('RFIs · position saved.');
    fixture.detectChanges();

    expect(liveRegions(fixture)[0].textContent).toContain('position saved');
  });

  it('re-announces an identical message, so a repeated action is never silent', () => {
    const fixture = create();
    const announcer = TestBed.inject(VendorPortalAnnouncer);

    announcer.announce('Position withdrawn.');
    fixture.detectChanges();
    const first = liveRegions(fixture)[0].textContent ?? '';

    announcer.announce('Position withdrawn.');
    fixture.detectChanges();
    const second = liveRegions(fixture)[0].textContent ?? '';

    // Same sentence, different text node: a live region announces on change.
    expect(second.trim()).toContain('Position withdrawn.');
    expect(second).not.toBe(first);
  });

  it('never steals focus when something is announced', () => {
    const fixture = create();
    const button = navButton(fixture, 'Products');
    button.focus();

    TestBed.inject(VendorPortalAnnouncer).announce('Notifications updated.');
    fixture.detectChanges();

    // A poll landing mid-interaction must not move the caret off the control the
    // vendor is operating.
    expect(document.activeElement).toBe(button);
  });
});
