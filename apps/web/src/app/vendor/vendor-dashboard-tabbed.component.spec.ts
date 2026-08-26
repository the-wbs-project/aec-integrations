/**
 * The vendor dashboard shell and its routed sections.
 *
 * AECI-606 pinned the Integrations section's three edit points (the section
 * table, the nav, and the switch that rendered one at a time) plus the property
 * that makes the whole surface work: the shell stays presentational and passes
 * the verified flag down rather than gating anything itself.
 *
 * AECI-631 added the two properties that make it LIVE
 * (`docs/STAGE_2_REALTIME_SPEC.md` §6): a refetched `me` re-derives the whole
 * surface without a reload (§6.1), and the portal has exactly one polite live
 * region, here in the shell (§6.3).
 *
 * ── WHAT CHANGED WHEN THE PORTAL GAINED URLS ────────────────────────────────
 * The sections were an in-page `@switch` over a `Tab` signal; they are child
 * routes now, so this spec drives them with `RouterTestingHarness` instead of
 * clicking nav buttons. The properties under test are unchanged — which is the
 * point of re-pinning them here rather than rewriting them: a section still only
 * mounts when it is asked for, the shell still survives every section change, and
 * the capability gate still re-derives from a refetched payload.
 *
 * `me` reaches the sections through `VendorPortalStore` rather than through a
 * chain of inputs, so "the operator granted the entitlement while the vendor sat
 * on this section" is modelled by a `seed()`, which is exactly what the AECI-629
 * poll does on the real surface.
 */
import { provideHttpClient } from '@angular/common/http';
import { Component, computed, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorMeResponse } from '@aeci/shared';

import { AecSelect } from '../shared/aec-select/aec-select';
import { VendorPortalAnnouncer } from './vendor-announcer';
import { VendorApi } from './vendor-api';
import {
  VENDOR_ME_DOWNGRADED_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from './vendor-fixtures';
import { VendorDashboardTabbed } from './vendor-dashboard-tabbed';
import { VendorPortalStore } from './vendor-portal-store';
import { VENDOR_SECTION_ROUTES } from './vendor.routes';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const SLUG = VENDOR_ME_FIXTURE.vendor.slug;
const NAV_LABELS = ['Vendor Overview', 'Profile', 'Products', 'Integrations', 'Seats'];

/**
 * Stands in for `VendorPage`: the surface owner that binds the shell's `me` to
 * the store. The real page also owns the gate, the head and the live sync, none
 * of which this spec is about.
 */
@Component({
  selector: 'aec-test-vendor-host',
  imports: [VendorDashboardTabbed],
  template: `<aec-vendor-dashboard-tabbed [me]="me()" />`,
})
class TestVendorHost {
  private readonly store = inject(VendorPortalStore);
  // Non-null by construction: every case seeds the store before navigating.
  protected readonly me = computed(() => this.store.me() as VendorMeResponse);
}

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([
        { path: 'vendor/:vendorSlug', component: TestVendorHost, children: VENDOR_SECTION_ROUTES },
      ]),
      {
        provide: VendorApi,
        useValue: {
          getSeats: vi
            .fn()
            .mockResolvedValue({ seats: [], pending_invites: [], can_manage_seats: false }),
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
      // Root-provided here where the real surface scopes it to `VendorPage`; the
      // shell and every section must see ONE instance either way.
      VendorPortalStore,
    ],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

/** Seed the store, then land on `section` (or Overview). */
async function open(
  section = 'overview',
  me: VendorMeResponse = VENDOR_ME_FIXTURE,
): Promise<RouterTestingHarness> {
  const harness = await RouterTestingHarness.create();
  TestBed.inject(VendorPortalStore).seed(me);
  await harness.navigateByUrl(`/vendor/${me.vendor.slug}/${section}`);
  harness.detectChanges();
  await flush();
  harness.detectChanges();
  return harness;
}

const root = (harness: RouterTestingHarness) => harness.fixture.nativeElement as HTMLElement;

/** The product the form is currently editing, read off its read-only identity
 *  block — the only place the product name is rendered now that the card header
 *  is gone. */
const editing = (harness: RouterTestingHarness): string | undefined =>
  root(harness).querySelector('aec-vendor-product-form p')?.textContent?.trim();

function navLink(harness: RouterTestingHarness, label: string): HTMLAnchorElement {
  const link = [...root(harness).querySelectorAll('nav a')].find(
    (a) => a.textContent?.trim() === label,
  );
  if (!link) throw new Error(`no nav link "${label}"`);
  return link as HTMLAnchorElement;
}

describe('VendorDashboardTabbed — the routed side nav', () => {
  it('lists the five sections, with Integrations between Products and Seats', async () => {
    const labels = [...root(await open()).querySelectorAll('nav a')].map((a) =>
      a.textContent?.trim(),
    );
    expect(labels).toEqual(NAV_LABELS);
  });

  it('links every section under the vendor slug, so the URL names the page', async () => {
    const harness = await open();
    expect([...root(harness).querySelectorAll('nav a')].map((a) => a.getAttribute('href'))).toEqual(
      NAV_LABELS.map(
        (_, i) =>
          `/vendor/${SLUG}/${['overview', 'profile', 'products', 'integrations', 'seats'][i]}`,
      ),
    );
  });

  it('does not render the Integrations section until its route is active', async () => {
    // A section is a lazy route, so the heavier read only happens when a vendor
    // asks for it — the property the `@switch` used to provide.
    expect(root(await open()).querySelector('aec-vendor-integrations-section')).toBeNull();
  });

  it('renders the section and moves aria-current on navigation', async () => {
    const harness = await open('integrations');
    const el = root(harness);

    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(navLink(harness, 'Integrations').getAttribute('aria-current')).toBe('page');
    expect(navLink(harness, 'Vendor Overview').getAttribute('aria-current')).toBeNull();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Integrations');
  });

  it('passes the verified flag down rather than gating in the shell', async () => {
    const el = root(await open('integrations', VENDOR_ME_UNVERIFIED_FIXTURE));

    // The shell stays presentational: the section renders either way and
    // decides for itself what to withhold.
    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(el.textContent).toContain('once your account is verified');
  });
});

/**
 * AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8 + §4.3 — the surface's half of the
 * invariant. The API half (`GET /api/vendor/me` answers 200 with the downgraded
 * block for a `revoked`/`expired` vendor) is pinned by
 * `apps/api/src/routes/vendor.entitlement.spec.ts`. This is the other end of the
 * same wire: given that payload, the DASHBOARD renders — the whole surface, every
 * section, with a renewal path — rather than degrading into a not-found. A vendor
 * who cannot reach the dashboard can never see the notice this epic exists to
 * show.
 */
describe('VendorDashboardTabbed — the downgraded entitlement (§4.3 / §8)', () => {
  it('renders the FULL dashboard for a revoked vendor, never a dead end', async () => {
    const harness = await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = root(harness);

    // Same shell, same nav, same company name. Nothing is withheld structurally.
    expect([...el.querySelectorAll('nav a')].map((a) => a.textContent?.trim())).toEqual(NAV_LABELS);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe(
      VENDOR_ME_DOWNGRADED_FIXTURE.vendor.company_name,
    );
    // §5.2: clearing an entitlement does not revoke seats, and the readout says so.
    expect(el.textContent).toContain(String(VENDOR_ME_DOWNGRADED_FIXTURE.seat_count));
  });

  it('shows the plan panel with a renewal path on the overview section', async () => {
    const el = root(await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE));

    expect(el.querySelector('aec-vendor-plan-panel')).not.toBeNull();
    expect(el.querySelector('a[href="/contact"]')?.textContent?.trim()).toBe('Renew verification');
    expect(el.textContent).toContain('no longer active');
  });

  it('drives the profile form read-only off CAPABILITIES, not vendor.verified', async () => {
    const el = root(await open('profile', VENDOR_ME_DOWNGRADED_FIXTURE));

    expect(el.textContent).toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).toBeNull();
    expect(
      [...el.querySelectorAll<HTMLInputElement>('input, textarea')].every((f) => f.readOnly),
    ).toBe(true);
  });

  it('leaves the paid vendor forms editable — the launch behaviour is unchanged', async () => {
    const el = root(await open('profile'));

    expect(el.textContent).not.toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).not.toBeNull();
  });
});

/**
 * AECI-631 / §6.1 — the concierge flip lands without a reload.
 *
 * On the real surface the AECI-629 poll refetches `GET /api/vendor/me` and seeds
 * the store; every `computed` derived from it re-derives and nothing is
 * re-created. `seed()` is exactly that event — anything that latched the
 * entitlement at construction would pass a fresh-render test and fail these.
 */
describe('VendorDashboardTabbed — a refetched `me` (§6.1)', () => {
  it('re-derives the capability gate, so the profile form unlocks in place', async () => {
    const harness = await open('profile', VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = root(harness);
    expect(el.textContent).toContain('Editing is paused');

    // The operator granted the entitlement while the vendor sat on this section.
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).not.toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).not.toBeNull();
  });

  it('re-derives it in the other direction too, so a revoke closes the forms', async () => {
    const harness = await open('profile');
    const el = root(harness);
    expect(el.querySelector('form button[type="submit"]')).not.toBeNull();

    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_DOWNGRADED_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).toContain('Editing is paused');
    expect(el.querySelector('form button[type="submit"]')).toBeNull();
  });

  it('moves the plan panel from lapsed to verified on the overview section', async () => {
    const harness = await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = root(harness);

    expect(el.textContent).toContain('no longer active');
    expect(el.querySelector('aec-verified-badge')).toBeNull();

    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).not.toContain('no longer active');
    expect(el.querySelector('aec-verified-badge')).not.toBeNull();
  });

  it('opens the Integrations controls, because `verified` is a mirror of the same row', async () => {
    const harness = await open('integrations', VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = root(harness);
    expect(el.textContent).toContain('once your account is verified');

    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).not.toContain('once your account is verified');
  });

  it('takes the capability list from the payload rather than re-deriving the tier ladder', async () => {
    // A tier this build does not recognise resolves to zero capabilities
    // server-side. A browser that re-implemented the ladder would fail OPEN on
    // exactly that tier; reading the resolved list fails closed with the API.
    const el = root(
      await open('profile', {
        ...VENDOR_ME_FIXTURE,
        entitlement: {
          ...VENDOR_ME_FIXTURE.entitlement,
          tier: 'some-future-tier' as VendorMeResponse['entitlement']['tier'],
          capabilities: [],
        },
      }),
    );

    expect(el.textContent).toContain('Editing is paused');
  });
});

/**
 * The products picker. A vendor with a hundred products cannot find the one they
 * came to edit in a stack of disclosures, so the section renders ONE product and
 * the choice is a URL segment — which is also what makes it a bookmark and a Back
 * step.
 */
describe('VendorProductsPage — the product picker', () => {
  it('renders the primary product on the bare products path', async () => {
    const harness = await open('products');

    expect(editing(harness)).toBe('Summit Model Coordination');
    // One product at a time — the stacked-disclosure rendering is gone.
    expect(root(harness).querySelectorAll('aec-vendor-product-form')).toHaveLength(1);
    expect(root(harness).querySelector('details')).toBeNull();
  });

  it('renders the product the URL names', async () => {
    expect(editing(await open('products/summit-field-issues'))).toBe('Summit Field Issues');
  });

  it('offers every owned product in the picker, alphabetically', async () => {
    // Read through the control's input rather than by opening it: the Aria
    // combobox's open→select interaction is jsdom-hostile and is covered live
    // instead (see `aec-select.component.spec.ts`). The ordering is the property
    // that matters here — the picker is a lookup, so it is ordered the way a
    // reader looks something up, not by `is_primary`.
    const harness = await open('products');
    const picker = harness.fixture.debugElement.query(By.directive(AecSelect));
    expect(picker).not.toBeNull();

    expect((picker.componentInstance as AecSelect).options()).toEqual([
      { value: 'summit-field-issues', label: 'Summit Field Issues' },
      { value: 'summit-model-coordination', label: 'Summit Model Coordination' },
    ]);
  });

  it('says so rather than silently substituting when the URL names a product the vendor does not own', async () => {
    const el = root(await open('products/someone-elses-product'));

    expect(el.textContent).toContain("isn't linked to your vendor");
    expect(el.querySelector('aec-vendor-product-form')).toBeNull();
  });

  it('hides the picker for a single-product vendor', async () => {
    const solo: VendorMeResponse = {
      ...VENDOR_ME_FIXTURE,
      products: [VENDOR_ME_FIXTURE.products[0]],
    };
    const harness = await open('products', solo);

    // A picker over one option is noise.
    expect(root(harness).querySelector('aec-select')).toBeNull();
    // The name still shows — the form's identity block carries it.
    expect(editing(harness)).toBe(solo.products[0].name);
  });

  it('renders the empty state, not a picker, for a vendor with no products', async () => {
    const none: VendorMeResponse = { ...VENDOR_ME_FIXTURE, products: [] };
    const el = root(await open('products', none));

    expect(el.querySelector('aec-select')).toBeNull();
    expect(el.textContent).toContain('No products are linked to your vendor yet');
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
  const liveRegions = (harness: RouterTestingHarness) =>
    root(harness).querySelectorAll('[role="status"], [role="alert"], [aria-live]');

  it('renders exactly one, and it is polite, sr-only and initially silent', async () => {
    const regions = liveRegions(await open());

    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute('role')).toBe('status');
    // `role="status"` is implicitly polite. An explicit `assertive` anywhere on
    // this surface would make a background revalidation an interruption.
    expect(regions[0].getAttribute('aria-live')).not.toBe('assertive');
    expect(regions[0].classList.contains('sr-only')).toBe(true);
    expect(regions[0].textContent?.trim()).toBe('');
  });

  it('stays at exactly one with the Integrations section open', async () => {
    // The section's loading/failure paragraphs and the card's pivot notice are
    // deliberately not live regions.
    expect(liveRegions(await open('integrations'))).toHaveLength(1);
  });

  it('survives a section change — the region is in the shell, not in a section', async () => {
    const harness = await open('overview');
    const before = liveRegions(harness)[0];

    await harness.navigateByUrl(`/vendor/${SLUG}/seats`);
    harness.detectChanges();
    await flush();
    harness.detectChanges();

    const after = liveRegions(harness);
    expect(after).toHaveLength(1);
    // The SAME node: a region that was destroyed and re-created mid-announcement
    // would have nothing to say.
    expect(after[0]).toBe(before);
  });

  it('carries whatever the portal announces', async () => {
    const harness = await open();
    TestBed.inject(VendorPortalAnnouncer).announce('RFIs · position saved.');
    harness.detectChanges();

    expect(liveRegions(harness)[0].textContent).toContain('position saved');
  });

  it('re-announces an identical message, so a repeated action is never silent', async () => {
    const harness = await open();
    const announcer = TestBed.inject(VendorPortalAnnouncer);

    announcer.announce('Position withdrawn.');
    harness.detectChanges();
    const first = liveRegions(harness)[0].textContent ?? '';

    announcer.announce('Position withdrawn.');
    harness.detectChanges();
    const second = liveRegions(harness)[0].textContent ?? '';

    // Same sentence, different text node: a live region announces on change.
    expect(second.trim()).toContain('Position withdrawn.');
    expect(second).not.toBe(first);
  });

  it('never steals focus when something is announced', async () => {
    const harness = await open();
    const link = navLink(harness, 'Products');
    link.focus();

    TestBed.inject(VendorPortalAnnouncer).announce('Notifications updated.');
    harness.detectChanges();

    // A poll landing mid-interaction must not move the caret off the control the
    // vendor is operating.
    expect(document.activeElement).toBe(link);
  });
});
