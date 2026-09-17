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
 * ── WHAT CHANGED WHEN THE HEADER FOLLOWED THE CONTEXT (§6.11) ───────────────
 * All five vendor items are `routerLink` anchors again: Products links to the
 * product list rather than opening a dropdown. Opening a product swaps the
 * breadcrumb, the `h1`, the public link and the tab row to that product, so the
 * nav helpers below scope to `aec-vendor-portal-nav` (the breadcrumb is a
 * `<nav>` too) and never assume the vendor row is present.
 *
 * `me` reaches the sections through `VendorPortalStore` rather than through a
 * chain of inputs, so "the operator granted the entitlement while the vendor sat
 * on this section" is modelled by a `seed()`, which is exactly what the AECI-629
 * poll does on the real surface.
 */
import { provideHttpClient } from '@angular/common/http';
import { Component, computed, inject, provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
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
import { VENDOR_SECTION_ROUTES } from './vendor.routes';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

const SLUG = VENDOR_ME_FIXTURE.vendor.slug;
const NAV_LABELS = ['Vendor Overview', 'Profile', 'Products', 'Messages', 'Seats'];

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

/** Navigate an already-open harness. `RouterTestingHarness` allows exactly one
 *  harness per test, so a case that visits two URLs moves this one. */
async function go(harness: RouterTestingHarness, section: string): Promise<void> {
  await harness.navigateByUrl(`/vendor/${SLUG}/${section}`);
  harness.detectChanges();
  await flush();
  harness.detectChanges();
}

const root = (harness: RouterTestingHarness) => harness.fixture.nativeElement as HTMLElement;

/** The product the form is currently editing, read off its read-only identity
 *  block — the only place the product name is rendered now that the card header
 *  is gone. */
const editing = (harness: RouterTestingHarness): string | undefined =>
  root(harness).querySelector('aec-vendor-product-form p')?.textContent?.trim();

/** A tab by its visible label, in whichever row the shell is showing. */
function navLink(harness: RouterTestingHarness, label: string): HTMLElement {
  const item = [...navItems(harness)].find((el) => el.textContent?.trim() === label);
  if (!item) throw new Error(`no nav item "${label}"`);
  return item as HTMLElement;
}

const navItems = (harness: RouterTestingHarness) =>
  root(harness).querySelectorAll('aec-vendor-portal-nav a');

const crumbs = (harness: RouterTestingHarness) =>
  [...root(harness).querySelectorAll('nav[aria-label="Breadcrumb"] li:not([aria-hidden])')].map(
    (li) => li.textContent?.trim(),
  );

const navLabels = (harness: RouterTestingHarness) =>
  [...navItems(harness)].map((el) => el.textContent?.trim());

describe('VendorDashboardTabbed — the routed section nav', () => {
  it('lists the five sections, with Messages between Products and Seats', async () => {
    // AECI-666: Integrations left this row for the product row; Messages took
    // its slot.
    expect(navLabels(await open())).toEqual(NAV_LABELS);
  });

  it('links every link section under the vendor slug, so the URL names the page', async () => {
    const harness = await open();

    expect([...navItems(harness)].map((a) => a.getAttribute('href'))).toEqual(
      ['overview', 'profile', 'products', 'messages', 'seats'].map((p) => `/vendor/${SLUG}/${p}`),
    );
  });

  it('does not render the Integrations section until its route is active', async () => {
    // A section is a lazy route, so the heavier read only happens when a vendor
    // asks for it — the property the `@switch` used to provide. It now lives two
    // levels down, under a product (AECI-666).
    expect(root(await open()).querySelector('aec-vendor-integrations-section')).toBeNull();
  });

  it('renders the section and moves aria-current on navigation', async () => {
    const harness = await open('messages');
    const el = root(harness);

    expect(el.querySelector('aec-vendor-messages-page')).not.toBeNull();
    expect(navLink(harness, 'Messages').getAttribute('aria-current')).toBe('page');
    expect(navLink(harness, 'Vendor Overview').getAttribute('aria-current')).toBeNull();
    expect(el.querySelector('h2')?.textContent?.trim()).toBe('Messages');
  });

  it('reaches the Integrations section under a product, not off the portal row', async () => {
    const harness = await open('products/summit-field-issues/integrations');
    const el = root(harness);

    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    // The product row replaced the vendor row (§6.11).
    expect(navLabels(harness)).toEqual(['Profile', 'Taxonomy', 'Integrations']);
    expect(navLink(harness, 'Integrations').getAttribute('aria-current')).toBe('page');
  });

  it('marks Products current on the product list', async () => {
    const harness = await open('products');
    expect(navLink(harness, 'Products').getAttribute('aria-current')).toBe('page');

    await go(harness, 'profile');
    expect(navLink(harness, 'Products').getAttribute('aria-current')).toBeNull();
  });

  it('passes the verified flag down rather than gating in the shell', async () => {
    // The stock unverified fixture carries an EMPTY catalog, and Integrations
    // now lives under a product (AECI-666) — so it is given one here. The claim
    // under test is about the read-only copy a vendor without active access sees, not about
    // having no products.
    const unverifiedWithProduct = {
      ...VENDOR_ME_UNVERIFIED_FIXTURE,
      products: VENDOR_ME_FIXTURE.products,
    };
    const el = root(await open('products/summit-field-issues/integrations', unverifiedWithProduct));

    // The shell stays presentational: the section renders either way and
    // decides for itself what to withhold.
    expect(el.querySelector('aec-vendor-integrations-section')).not.toBeNull();
    expect(el.textContent).toContain('with active vendor access');
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
    expect(navLabels(harness)).toEqual(NAV_LABELS);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe(
      VENDOR_ME_DOWNGRADED_FIXTURE.vendor.company_name,
    );
    // §5.2: clearing an entitlement does not revoke seats, and the panel says so.
    // (The overview dropped its bare seat-count tile in AECI-983.)
    expect(el.textContent).toContain('you and your colleagues keep the portal');
  });

  it('shows the plan panel with a renewal path on the overview section', async () => {
    const el = root(await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE));

    expect(el.querySelector('aec-vendor-plan-panel')).not.toBeNull();
    expect(el.querySelector('a[href="/contact"]')?.textContent?.trim()).toBe('Renew access');
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
 * AECI-983 — the overview as a landing page (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.10). The rules themselves are pinned in `vendor-overview-model.spec.ts`;
 * these cases pin what only the routed surface can show: the compact strip, the
 * rows' relative links under `/vendor/:slug`, the live flip, and that the
 * overview adds no live region of its own.
 */
describe('VendorDashboardTabbed — the overview landing page (AECI-983)', () => {
  const rowHrefs = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLAnchorElement>('a[data-item]')].map((a) => [
      a.dataset['item'],
      a.getAttribute('href'),
    ]);

  it('collapses the plan panel for an active vendor, keeping the heading for assistive tech', async () => {
    const el = root(await open('overview'));

    const heading = [...el.querySelectorAll('h2')].find((h) =>
      h.textContent?.includes('Account access'),
    );
    expect(heading?.classList.contains('sr-only')).toBe(true);
    expect(el.querySelector('aec-vendor-plan-panel details')).not.toBeNull();
  });

  it('keeps the full panel, and a visible heading, for a lapsed vendor', async () => {
    const el = root(await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE));

    const heading = [...el.querySelectorAll('h2')].find((h) =>
      h.textContent?.includes('Account access'),
    );
    expect(heading?.classList.contains('sr-only')).toBe(false);
    expect(el.querySelector('aec-vendor-plan-panel details')).toBeNull();
  });

  it('links each row to the portal route where the work is done', async () => {
    const el = root(await open('overview'));
    const hrefs = Object.fromEntries(rowHrefs(el));
    const [primary, secondary] = VENDOR_ME_FIXTURE.products;

    // Two open corrections, both to Messages.
    expect(
      Object.entries(hrefs)
        .filter(([k]) => k?.startsWith('correction:'))
        .map(([, h]) => h),
    ).toEqual([`/vendor/${SLUG}/messages`, `/vendor/${SLUG}/messages`]);
    // The second product is missing a website and logo, so it goes to its profile.
    expect(hrefs[`product:${secondary!.id}`]).toBe(
      `/vendor/${SLUG}/products/${secondary!.slug}/profile`,
    );
    expect(hrefs[`product:${primary!.id}`]).toBe(
      `/vendor/${SLUG}/products/${primary!.slug}/profile`,
    );
    // The company profile has no logo.
    expect(hrefs['profile']).toBe(`/vendor/${SLUG}/profile`);
  });

  it('pauses Worth doing for a lapsed vendor but still lists open corrections', async () => {
    const el = root(await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE));

    expect(el.textContent).toContain('Editing is paused');
    const keys = rowHrefs(el).map(([k]) => k);
    expect(keys.some((k) => k?.startsWith('correction:'))).toBe(true);
    expect(keys.some((k) => k?.startsWith('product:') || k === 'profile')).toBe(false);
  });

  it('re-derives the list when the entitlement flips, without a reload (AECI-631)', async () => {
    const harness = await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = root(harness);
    expect(el.textContent).toContain('Editing is paused');

    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).not.toContain('Editing is paused');
    expect(rowHrefs(el).some(([k]) => k === 'profile')).toBe(true);
  });

  it('renders the all-clear state when nothing is outstanding', async () => {
    const complete = {
      ...VENDOR_ME_FIXTURE,
      vendor: { ...VENDOR_ME_FIXTURE.vendor, logo_url: 'https://example.com/logo.png' },
      products: VENDOR_ME_FIXTURE.products.map((p) => ({
        ...p,
        website: 'https://example.com',
        logo_url: 'https://example.com/logo.png',
      })),
      requests: [],
    };
    const el = root(await open('overview', complete));

    expect(el.textContent).toContain('Nothing needs you right now.');
    expect(el.textContent).toContain('Nothing is outstanding.');
    expect(el.querySelectorAll('a[data-item]')).toHaveLength(0);
  });

  it('never claims the all-clear while the data flows read is loading or has failed', async () => {
    const complete = {
      ...VENDOR_ME_FIXTURE,
      vendor: { ...VENDOR_ME_FIXTURE.vendor, logo_url: 'https://example.com/logo.png' },
      products: VENDOR_ME_FIXTURE.products.map((p) => ({
        ...p,
        website: 'https://example.com',
        logo_url: 'https://example.com/logo.png',
      })),
      requests: [],
    };
    const api = TestBed.inject(VendorApi) as unknown as {
      getIntegrations: ReturnType<typeof vi.fn>;
    };
    let reject!: (e: Error) => void;
    api.getIntegrations.mockReturnValueOnce(
      new Promise((_, r) => {
        reject = r;
      }),
    );
    const harness = await open('overview', complete);
    const el = root(harness);

    expect(el.textContent).not.toContain('Nothing needs you right now.');
    expect(el.textContent).toContain('Checking your data flows.');

    reject(new Error('offline'));
    await flush();
    harness.detectChanges();

    expect(el.textContent).not.toContain('Nothing needs you right now.');
    expect(el.textContent).not.toContain('Nothing is outstanding.');
    expect(el.textContent).toContain('this list may be incomplete');
  });

  it('adds no live region of its own, and announces a retry through the shell', async () => {
    const api = TestBed.inject(VendorApi) as unknown as {
      getIntegrations: ReturnType<typeof vi.fn>;
    };
    api.getIntegrations.mockRejectedValueOnce(new Error('offline'));
    const harness = await open('overview');
    const el = root(harness);
    expect(el.querySelectorAll('[role="status"], [role="alert"], [aria-live]')).toHaveLength(1);

    expect(el.textContent).toContain('Could not load your data flows.');
    const retry = [...el.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Try again',
    );
    retry!.click();
    await flush();
    harness.detectChanges();

    // trim(): the announcer alternates a no-break-space suffix so repeats re-announce.
    expect(TestBed.inject(VendorPortalAnnouncer).message().trim()).toBe(
      'Your data flows are up to date.',
    );
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

  it('moves the plan panel from lapsed to active on the overview section', async () => {
    const harness = await open('overview', VENDOR_ME_DOWNGRADED_FIXTURE);
    const el = root(harness);

    expect(el.textContent).toContain('no longer active');
    expect(el.querySelector('aec-vendor-account-badge')).toBeNull();

    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).not.toContain('no longer active');
    expect(el.querySelector('aec-vendor-account-badge')).not.toBeNull();
  });

  it('opens the Integrations controls, because `verified` is a mirror of the same row', async () => {
    const harness = await open(
      'products/summit-field-issues/integrations',
      VENDOR_ME_DOWNGRADED_FIXTURE,
    );
    const el = root(harness);
    expect(el.textContent).toContain('with active vendor access');

    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
    harness.detectChanges();

    expect(el.textContent).not.toContain('with active vendor access');
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
 * Which product the section shows.
 *
 * A vendor with a hundred products cannot find the one they came to edit in a
 * stack of disclosures, so the section renders ONE product and the choice is a
 * URL segment — which is also what makes it a bookmark and a Back step. The
 * CONTROL that changes the choice moved into the portal nav; what stays here is
 * everything that decides which product a given URL resolves to.
 */
describe('VendorProductsPage — which product the URL resolves to', () => {
  it('renders the product list on the bare products path, primary first', async () => {
    const el = root(await open('products'));
    const rows = [...el.querySelectorAll('aec-vendor-product-list-page li a')];

    expect(rows.map((a) => a.getAttribute('href'))).toEqual([
      `/vendor/${SLUG}/products/summit-model-coordination`,
      `/vendor/${SLUG}/products/summit-field-issues`,
    ]);
    expect(el.querySelector('aec-vendor-product-form')).toBeNull();
  });

  it('renders the product the URL names', async () => {
    expect(editing(await open('products/summit-field-issues'))).toBe('Summit Field Issues');
  });

  it('says so rather than silently substituting when the URL names a product the vendor does not own', async () => {
    const el = root(await open('products/someone-elses-product'));

    expect(el.textContent).toContain("isn't linked to your vendor");
    expect(el.querySelector('aec-vendor-product-form')).toBeNull();
    expect(el.querySelector('aec-vendor-products-page a')?.getAttribute('href')).toBe(
      `/vendor/${SLUG}/products`,
    );
  });

  it('renders the empty state for a vendor with no products', async () => {
    const none: VendorMeResponse = { ...VENDOR_ME_FIXTURE, products: [] };
    const harness = await open('products', none);

    expect(root(harness).textContent).toContain('No products are linked to your vendor yet');
  });
});

/**
 * §6.11 — one header that follows the context. A product page used to stack its
 * own heading and a second nav row under the vendor's; now the shell switches.
 */
describe('VendorDashboardTabbed — the context-aware header (§6.11)', () => {
  const company = VENDOR_ME_FIXTURE.vendor.company_name;

  it('shows Vendor › company in vendor context, with the company as the h1', async () => {
    const harness = await open('seats');
    const el = root(harness);

    expect(crumbs(harness)).toEqual(['Vendor', company]);
    expect(
      el.querySelector('nav[aria-label="Breadcrumb"] [aria-current="page"]')?.textContent?.trim(),
    ).toBe(company);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe(company);
    expect(navLabels(harness)).toEqual(NAV_LABELS);
    expect(el.textContent).not.toContain('Back to');
  });

  it('switches the breadcrumb, h1 and tab row to an open product', async () => {
    const harness = await open('products/summit-field-issues/taxonomy');
    const el = root(harness);

    expect(crumbs(harness)).toEqual(['Vendor', company, 'Products', 'Summit Field Issues']);
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Summit Field Issues');
    expect(el.querySelectorAll('aec-vendor-portal-nav')).toHaveLength(1);
    expect(el.querySelector('aec-vendor-portal-nav nav')?.getAttribute('aria-label')).toBe(
      'Summit Field Issues sections',
    );
    expect(navLabels(harness)).toEqual(['Profile', 'Taxonomy', 'Integrations']);
    // No second heading inside the product page.
    expect(el.querySelector('aec-vendor-products-page > h2')).toBeNull();
  });

  it('links the crumbs and the back link back into the vendor', async () => {
    const harness = await open('products/summit-field-issues/profile');
    const links = [...root(harness).querySelectorAll('header a')].filter(
      (a) => a.closest('aec-view-public-link') === null,
    );

    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['Vendor', `/vendor/${SLUG}/overview`],
      [company, `/vendor/${SLUG}/overview`],
      ['Products', `/vendor/${SLUG}/products`],
      [`← Back to ${company}`, `/vendor/${SLUG}/overview`],
    ]);
  });

  it('returns to vendor context when the vendor is navigated back to', async () => {
    const harness = await open('products/summit-field-issues/profile');
    await go(harness, 'overview');

    expect(root(harness).querySelector('h1')?.textContent?.trim()).toBe(company);
    expect(navLabels(harness)).toEqual(NAV_LABELS);
  });

  it('follows a product-to-product navigation that reuses the shell', async () => {
    const harness = await open('products/summit-field-issues/profile');
    await go(harness, 'products/summit-model-coordination/profile');

    expect(root(harness).querySelector('h1')?.textContent?.trim()).toBe(
      'Summit Model Coordination',
    );
  });

  it('stays in vendor context for a product the vendor does not own', async () => {
    const harness = await open('products/someone-elses-product');

    expect(root(harness).querySelector('h1')?.textContent?.trim()).toBe(company);
    expect(navLabels(harness)).toEqual(NAV_LABELS);
  });
});

/**
 * AECI-960 / §6.7 — the portal points at what it edits.
 *
 * The portal reads and writes the catalog; before this it linked to none of it,
 * so a vendor saved a profile and had no way to see the result. Two of the three
 * link sites live here (the third is the integration card, covered in
 * `vendor-integrations-section.component.spec.ts`).
 *
 * Every assertion below is about a property that fails SILENTLY. A dropped
 * `target="_blank"` still renders a working link, and it costs the vendor the
 * unsaved form state in the tab they navigated out of. A link nested into the
 * `h1` still renders, and it corrupts the one string that names the page.
 */
describe('VendorDashboardTabbed — links out to the public listing (§6.7)', () => {
  /** The header's one link, beside the h1. Since §6.11 it names the vendor in
   *  vendor context and the product in product context. Scoped to the header,
   *  because integration cards render their own further down. */
  const headerLink = (harness: RouterTestingHarness) =>
    root(harness).querySelector('header aec-view-public-link a') as HTMLAnchorElement | null;
  const vendorLink = headerLink;
  const productLink = headerLink;

  it('links the company name to its public vendor page, in a new tab', async () => {
    const harness = await open('overview');
    const link = vendorLink(harness);

    expect(link?.getAttribute('href')).toBe(`/vendors/${SLUG}`);
    // New tab because the portal holds unsaved form state and has no
    // CanDeactivate guard; noopener because the new context otherwise gets a
    // handle on this one.
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
  });

  it('keeps the link OUT of the h1, so the page heading stays the title', async () => {
    const el = root(await open('overview'));

    expect(el.querySelector('h1')?.textContent?.trim()).toBe(VENDOR_ME_FIXTURE.vendor.company_name);
    expect(el.querySelector('h1 a')).toBeNull();
  });

  it('announces the new tab', async () => {
    const el = root(await open('overview'));

    expect(el.querySelector('aec-view-public-link')?.textContent).toContain('(opens in a new tab)');
  });

  it('leaves the once-per-page link unnamed by aria-label, so the visible text is the name', async () => {
    // The uniform name is only safe where the link appears once. The
    // integrations tab is the repeated case and carries a destination-specific
    // name instead; this asserts the two rules did not get swapped.
    expect(vendorLink(await open('overview'))?.hasAttribute('aria-label')).toBe(false);
  });

  it('links the selected product to its public product page', async () => {
    const harness = await open('products/summit-field-issues');
    const link = productLink(harness);

    expect(link?.getAttribute('href')).toBe('/products/summit-field-issues');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('follows the picker, so the link always names the product on screen', async () => {
    const harness = await open('products/summit-field-issues');
    await go(harness, 'products/summit-model-coordination');

    // A stale href here would send the vendor to the page they were NOT editing,
    // which reads as the save having failed.
    expect(productLink(harness)?.getAttribute('href')).toBe('/products/summit-model-coordination');
  });

  it('points the header link at the vendor when the URL names a product the vendor does not own', async () => {
    // The page renders its "not linked to your vendor" notice. A product link
    // here would assert a listing the vendor does not have.
    const harness = await open('products/someone-elses-product');

    expect(headerLink(harness)?.getAttribute('href')).toBe(`/vendors/${SLUG}`);
    expect(root(harness).querySelectorAll('header aec-view-public-link')).toHaveLength(1);
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
    expect(liveRegions(await open('products/summit-field-issues/integrations'))).toHaveLength(1);
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
