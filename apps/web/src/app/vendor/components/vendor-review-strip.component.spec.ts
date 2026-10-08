/**
 * AECI-1241 — the "Looks right" strip shows only for a step that was not done
 * when the page loaded (`STAGE_2_PAID_TIERS_SPEC.md` §13.8 as-built note).
 *
 * Covers the latch itself (`reviewStripShown`), two of the three pages that
 * use it (the company profile and a product's profile), and the product
 * checklist card, which applies the same rule per row. The integrations page
 * wires the helper the same way as the product profile page.
 *
 * `.component.spec.ts` so it runs under `ng test` (TestBed DI).
 */
import { Component, input, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorProductChecklistResponse } from '@aeci/shared';

import { productChecklistRows } from '../checklist-rows';
import { VendorProductOverviewPage } from '../sections/vendor-product-overview-page';
import { VendorProductProfilePage } from '../sections/vendor-product-profile-page';
import { VendorProfileSection } from '../sections/vendor-profile-section';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  NOTHING_CHECKED,
  VENDOR_ME_FIXTURE,
  productChecklistFixture,
  vendorChecklistFixture,
  type ChecklistFixtureState,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorChecklist } from './vendor-checklist';
import { VendorProductsSection } from './vendor-products-section';
import { VendorProfileForm } from './vendor-profile-form';
import { reviewStripShown, type ReviewStepState } from './vendor-review-strip';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const PRIMARY = VENDOR_ME_FIXTURE.products[0]!;
const SECONDARY = VENDOR_ME_FIXTURE.products[1]!;
const VENDOR_SLUG = VENDOR_ME_FIXTURE.vendor.slug;

const COMPANY_CHECKED: ChecklistFixtureState = { ...NOTHING_CHECKED, company: true };
const DETAILS_CHECKED: ChecklistFixtureState = {
  ...NOTHING_CHECKED,
  products: { [PRIMARY.id]: { details: true, list: false, claims: false, flows: false } },
};

// ── The latch ───────────────────────────────────────────────────────────────

@Component({ selector: 'aec-test-latch-host', template: '' })
class LatchHost {
  readonly record = signal<string | null>('company');
  readonly state = signal<ReviewStepState>('unknown');
  readonly shown = reviewStripShown(() => ({ record: this.record(), state: this.state() }));
}

describe('reviewStripShown', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });
  const host = () => TestBed.createComponent(LatchHost).componentInstance;

  it('shows nothing while the step is unknown', () => {
    const h = host();
    expect(h.shown()).toBe(false);
  });

  it('shows nothing while the record is null, whatever the step says', () => {
    const h = host();
    h.record.set(null);
    h.state.set('todo');
    expect(h.shown()).toBe(false);
  });

  it('a step not done at load shows, and stays shown once it flips to done', () => {
    const h = host();
    h.state.set('todo');
    expect(h.shown()).toBe(true);
    h.state.set('done');
    expect(h.shown()).toBe(true);
  });

  it('a step done at load never shows, even if it later reads todo', () => {
    const h = host();
    h.state.set('done');
    expect(h.shown()).toBe(false);
    h.state.set('todo');
    expect(h.shown()).toBe(false);
  });

  it('re-decides for a new record, as on a page reused for another product', () => {
    const h = host();
    h.record.set('a');
    h.state.set('todo');
    expect(h.shown()).toBe(true);
    h.record.set('b');
    h.state.set('unknown');
    expect(h.shown()).toBe(false);
    h.state.set('done');
    expect(h.shown()).toBe(false);
  });
});

// ── The pages ───────────────────────────────────────────────────────────────

@Component({ selector: 'aec-vendor-profile-form', template: '' })
class StubProfileForm {
  readonly vendor = input<unknown>();
  readonly canEdit = input(false);
}

@Component({ selector: 'aec-vendor-products-section', template: '' })
class StubProductsSection {
  readonly products = input<unknown>();
  readonly selectedSlug = input<string | null>(null);
  readonly section = input<string>('');
}

let state: ChecklistFixtureState;
let api: {
  getMe: ReturnType<typeof vi.fn>;
  getChecklist: ReturnType<typeof vi.fn>;
  getProductChecklist: ReturnType<typeof vi.fn>;
  reviewProfile: ReturnType<typeof vi.fn>;
  reviewProduct: ReturnType<typeof vi.fn>;
};

function configure(): void {
  state = NOTHING_CHECKED;
  api = {
    getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
    getChecklist: vi.fn(async () => vendorChecklistFixture(VENDOR_ME_FIXTURE, state)),
    getProductChecklist: vi.fn(
      async (id: string): Promise<VendorProductChecklistResponse> =>
        productChecklistFixture(VENDOR_ME_FIXTURE.products.find((p) => p.id === id)!, state),
    ),
    // Each write ticks its step, so the checklist refetch reads `done`.
    reviewProfile: vi.fn(async () => {
      state = { ...state, company: true };
      return { last_reviewed_at: '2026-10-08T00:00:00.000Z' };
    }),
    reviewProduct: vi.fn(async (id: string) => {
      state = {
        ...state,
        products: {
          ...state.products,
          [id]: { details: true, list: false, claims: false, flows: false },
        },
      };
      return { product_id: id, last_reviewed_at: '2026-10-08T00:00:00.000Z' };
    }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'vendor/:vendorSlug/products/:productSlug/profile',
          component: VendorProductProfilePage,
        },
        {
          path: 'vendor/:vendorSlug/products/:productSlug/overview',
          component: VendorProductOverviewPage,
        },
      ]),
      { provide: VendorApi, useValue: api as Partial<VendorApi> },
      VendorPortalStore,
      VendorPortalAnnouncer,
    ],
  });
  TestBed.overrideComponent(VendorProfileSection, {
    remove: { imports: [VendorProfileForm] },
    add: { imports: [StubProfileForm] },
  });
  TestBed.overrideComponent(VendorProductProfilePage, {
    remove: { imports: [VendorProductsSection] },
    add: { imports: [StubProductsSection] },
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
}

const strip = (el: HTMLElement) => el.querySelector('aec-vendor-review-strip');
const target = (el: HTMLElement) =>
  strip(el)?.querySelector('[data-review-target]')?.getAttribute('data-review-target');
const checkedMark = (el: HTMLElement) => el.querySelector('[data-testid="looks-right-done"]');
const button = (el: HTMLElement) =>
  el.querySelector('[data-testid="looks-right"]') as HTMLButtonElement;

describe('VendorProfileSection strip (AECI-1241)', () => {
  beforeEach(configure);

  async function render(): Promise<ComponentFixture<VendorProfileSection>> {
    const f = TestBed.createComponent(VendorProfileSection);
    f.detectChanges();
    await flush();
    f.detectChanges();
    return f;
  }

  it('renders nothing while the vendor checklist has not loaded', async () => {
    api.getChecklist.mockReturnValue(new Promise(() => undefined));
    const f = await render();
    expect(strip(f.nativeElement)).toBeNull();
  });

  it('renders nothing when company details were checked before the page loaded', async () => {
    state = COMPANY_CHECKED;
    const f = await render();
    expect(api.getChecklist).toHaveBeenCalled();
    expect(strip(f.nativeElement)).toBeNull();
  });

  it('shows the strip when unchecked at load, and keeps it with Checked after the press', async () => {
    const f = await render();
    const el = f.nativeElement as HTMLElement;
    expect(target(el)).toBe('profile');
    expect(checkedMark(el)).toBeNull();

    button(el).click();
    await flush();
    f.detectChanges();

    // The refetch has landed and reads done. The strip stays for this view.
    expect(api.getChecklist).toHaveBeenCalledTimes(2);
    expect(
      TestBed.inject(VendorPortalStore)
        .checklist()
        ?.steps.find((s) => s.key === 'company_details')?.status,
    ).toBe('done');
    expect(strip(el)).not.toBeNull();
    expect(checkedMark(el)?.textContent).toContain('Checked');

    // The next visit re-creates the page. The cached checklist reads done at load.
    f.destroy();
    const again = await render();
    expect(strip(again.nativeElement)).toBeNull();
  });
});

describe('VendorProductProfilePage strip (AECI-1241)', () => {
  beforeEach(configure);

  async function open(slug: string): Promise<{ el: HTMLElement; harness: RouterTestingHarness }> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/vendor/${VENDOR_SLUG}/products/${slug}/profile`);
    harness.detectChanges();
    await flush();
    harness.detectChanges();
    return { el: harness.fixture.nativeElement as HTMLElement, harness };
  }

  it('renders nothing while the product checklist has not loaded', async () => {
    api.getProductChecklist.mockReturnValue(new Promise(() => undefined));
    const { el } = await open(PRIMARY.slug);
    expect(strip(el)).toBeNull();
  });

  it('renders nothing when the product details were checked before the page loaded', async () => {
    state = DETAILS_CHECKED;
    const { el } = await open(PRIMARY.slug);
    expect(api.getProductChecklist).toHaveBeenCalledWith(PRIMARY.id);
    expect(strip(el)).toBeNull();
  });

  it('shows the strip when unchecked at load, keeps it after the press, and drops it next visit', async () => {
    const { el, harness } = await open(PRIMARY.slug);
    expect(target(el)).toBe('product');

    button(el).click();
    await flush();
    harness.detectChanges();

    expect(api.reviewProduct).toHaveBeenCalledWith(PRIMARY.id);
    expect(api.getProductChecklist).toHaveBeenCalledTimes(2);
    expect(strip(el)).not.toBeNull();
    expect(checkedMark(el)?.textContent).toContain('Checked');

    // Another product on the same route re-decides from its own checklist.
    await harness.navigateByUrl(`/vendor/${VENDOR_SLUG}/products/${SECONDARY.slug}/profile`);
    harness.detectChanges();
    await flush();
    harness.detectChanges();
    expect(target(el)).toBe('product');
    expect(checkedMark(el)).toBeNull();

    // Back to the checked product: done at load, so no strip.
    await harness.navigateByUrl(`/vendor/${VENDOR_SLUG}/products/${PRIMARY.slug}/profile`);
    harness.detectChanges();
    await flush();
    harness.detectChanges();
    expect(strip(el)).toBeNull();
  });
});

// ── The product checklist card ──────────────────────────────────────────────

describe('VendorChecklist Looks right rows (AECI-1241)', () => {
  beforeEach(configure);

  function render(st: ChecklistFixtureState, product = PRIMARY) {
    const f = TestBed.createComponent(VendorChecklist);
    f.componentRef.setInput('heading', 'Product checklist');
    f.componentRef.setInput('headingId', 'h');
    setRows(f, st, product);
    return f;
  }
  function setRows(
    f: ComponentFixture<VendorChecklist>,
    st: ChecklistFixtureState,
    product = PRIMARY,
  ) {
    const c = productChecklistFixture(product, st);
    f.componentRef.setInput('rows', productChecklistRows(c, product));
    f.componentRef.setInput('done', c.done);
    f.componentRef.setInput('total', c.total);
    f.detectChanges();
  }
  const row = (f: ComponentFixture<VendorChecklist>, key: string) =>
    (f.nativeElement as HTMLElement).querySelector(`[data-step="${key}"]`) as HTMLElement;

  it('a row done when the card first sees it keeps its label and link but offers no button', () => {
    const f = render(DETAILS_CHECKED);
    const details = row(f, 'product_details');
    expect(details.textContent).toContain('Check product details');
    expect(details.querySelector('.sr-only')?.textContent).toBe('Done');
    expect(details.querySelector('a')?.textContent?.trim()).toBe('Open Profile');
    expect(details.querySelector('aec-vendor-looks-right')).toBeNull();
    // With no button, the body no longer tells the vendor to press one.
    expect(details.textContent).not.toContain('Press Looks right');
    expect(details.textContent).toContain('save an edit on Profile');
    // The other row was not done, so it still offers the button.
    expect(row(f, 'integration_list').querySelector('aec-vendor-looks-right')).not.toBeNull();
  });

  it('a row not done at first keeps its button, now Checked, after the refetch reads done', () => {
    const f = render(NOTHING_CHECKED);
    expect(row(f, 'product_details').querySelector('aec-vendor-looks-right')).not.toBeNull();
    setRows(f, DETAILS_CHECKED);
    const details = row(f, 'product_details');
    expect(details.querySelector('aec-vendor-looks-right')).not.toBeNull();
    expect(checkedMark(details)?.textContent).toContain('Checked');
  });

  it('decides again for another product shown in the same card', () => {
    const f = render(NOTHING_CHECKED);
    const secondDone: ChecklistFixtureState = {
      ...NOTHING_CHECKED,
      products: { [SECONDARY.id]: { details: true, list: true, claims: false, flows: false } },
    };
    setRows(f, secondDone, SECONDARY);
    expect(row(f, 'product_details').querySelector('aec-vendor-looks-right')).toBeNull();
    expect(row(f, 'integration_list').querySelector('aec-vendor-looks-right')).toBeNull();
  });
});

describe('VendorProductOverviewPage checklist (AECI-1241)', () => {
  beforeEach(configure);

  async function open(): Promise<{ el: HTMLElement; harness: RouterTestingHarness }> {
    const harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(`/vendor/${VENDOR_SLUG}/products/${PRIMARY.slug}/overview`);
    harness.detectChanges();
    await flush();
    harness.detectChanges();
    return { el: harness.fixture.nativeElement as HTMLElement, harness };
  }
  const detailsButton = (el: HTMLElement) =>
    el.querySelector(
      '[data-step="product_details"] [data-testid="looks-right"]',
    ) as HTMLButtonElement | null;

  it('offers no button while the checklist is loading', async () => {
    api.getProductChecklist.mockReturnValue(new Promise(() => undefined));
    const { el } = await open();
    expect(el.textContent).toContain('Loading the checklist');
    expect(el.querySelector('[data-testid="looks-right"]')).toBeNull();
  });

  it('keeps a pressed row with Checked for this view, and drops its button next visit', async () => {
    const { el, harness } = await open();
    detailsButton(el)!.click();
    await flush();
    harness.detectChanges();

    expect(api.reviewProduct).toHaveBeenCalledWith(PRIMARY.id);
    expect(api.getProductChecklist).toHaveBeenCalledTimes(2);
    expect(detailsButton(el)).not.toBeNull();
    expect(checkedMark(el.querySelector('[data-step="product_details"]')!)?.textContent).toContain(
      'Checked',
    );

    // Leave for the profile route, then come back: the overview is re-created.
    for (const tab of ['profile', 'overview']) {
      await harness.navigateByUrl(`/vendor/${VENDOR_SLUG}/products/${PRIMARY.slug}/${tab}`);
      harness.detectChanges();
      await flush();
      harness.detectChanges();
    }
    expect(el.querySelector('aec-vendor-product-overview-page')).not.toBeNull();
    expect(detailsButton(el)).toBeNull();
    expect(el.querySelector('[data-step="product_details"]')).not.toBeNull();
  });
});
