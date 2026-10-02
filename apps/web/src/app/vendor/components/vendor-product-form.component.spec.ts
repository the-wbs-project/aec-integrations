import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateVendorProductResponse, VendorProduct } from '@aeci/shared';
import { capabilitiesFor, type Capability } from '@aeci/shared/entitlements';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_CONNECTOR_SEAT_FIXTURE, VENDOR_ME_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorProductForm } from './vendor-product-form';

/**
 * `VendorProductForm` (AECI-522) is the product Profile tab: the text fields,
 * the logo, and the read-only identity block. It shares the dirty-diff / save
 * scaffolding with `VendorProfileForm`, so these specs pin what is distinctive.
 *
 * Taxonomy and "How teams use it" left this form in AECI-994; their editor is
 * `vendor-product-facet-editor.ts` with its own spec.
 */
const PRODUCT: VendorProduct = VENDOR_ME_FIXTURE.products[0];
const DESCRIPTION_ID = `vendor-product-${PRODUCT.id}-description`;

function saveButton(fixture: ComponentFixture<VendorProductForm>): HTMLButtonElement | null {
  return fixture.nativeElement.querySelector('button[type="submit"]');
}

function setInput(fixture: ComponentFixture<VendorProductForm>, id: string, value: string): void {
  const el = fixture.nativeElement.querySelector(`#${id}`) as
    | HTMLInputElement
    | HTMLTextAreaElement;
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  fixture.detectChanges();
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

describe('VendorProductForm', () => {
  let updateProduct: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProduct = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProduct } as Partial<VendorApi> },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function create(product: VendorProduct = PRODUCT): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', product);
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorProductForm>): Promise<void> {
    await flush();
    fixture.detectChanges();
  }

  // ── AECI-967: the rename hint is a LINK ───────────────────────────────────
  // Every property below fails silently if it regresses. A dropped `target`
  // still renders a working link, a dropped `aecRequestTrigger` still navigates,
  // and axe sees none of it.
  describe('the rename hint (AECI-967)', () => {
    function renameLink(fixture: ComponentFixture<VendorProductForm>): HTMLAnchorElement | null {
      return fixture.nativeElement.querySelector('a[href$="/correction"]');
    }

    it("points at the product's own correction form", () => {
      const link = renameLink(create());
      expect(link?.getAttribute('href')).toBe(`/products/${PRODUCT.slug}/correction`);
      expect(link?.textContent).toContain('file a correction request');
    });

    // The href is the no-JS fallback and it really does navigate, over a form
    // with unsaved state and no CanDeactivate guard behind it.
    it('opens the fallback in a new tab, with noopener and the disclosure', () => {
      const link = renameLink(create());
      expect(link?.getAttribute('target')).toBe('_blank');
      expect(link?.getAttribute('rel')).toBe('noopener');
      expect(link?.querySelector('.sr-only')?.textContent).toContain('opens in a new tab');
    });
  });

  it('disables Save until a real text edit', () => {
    const fixture = create();
    expect(saveButton(fixture)?.disabled).toBe(true);

    setInput(fixture, DESCRIPTION_ID, 'A revised product description.');
    expect(saveButton(fixture)?.disabled).toBe(false);
  });

  it('confirms and re-disables Save on a successful text save', async () => {
    updateProduct.mockResolvedValue({
      product: { ...PRODUCT, description: 'A revised product description.' },
    } as UpdateVendorProductResponse);
    const fixture = create();

    setInput(fixture, DESCRIPTION_ID, 'A revised product description.');
    saveButton(fixture)!.click();
    await settle(fixture);

    expect(updateProduct).toHaveBeenCalledWith(PRODUCT.id, {
      description: 'A revised product description.',
    });
    expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent).toContain(
      'Product updated',
    );
    expect(saveButton(fixture)?.disabled).toBe(true);
  });

  it('surfaces a retryable error when the text save fails', async () => {
    updateProduct.mockRejectedValue(new Error('boom'));
    const fixture = create();

    setInput(fixture, DESCRIPTION_ID, 'A revised product description.');
    saveButton(fixture)!.click();
    await settle(fixture);

    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
    // Still enabled so the user can retry.
    expect(saveButton(fixture)?.disabled).toBe(false);
  });
});

/** `PRODUCT` on a plan holding exactly `capabilities`. */
function onPlan(capabilities: readonly Capability[]): VendorProduct {
  return { ...PRODUCT, plan: { ...PRODUCT.plan, capabilities: [...capabilities] } };
}

/**
 * The per-field gates (AECI-1214 / `STAGE_2_PAID_TIERS_SPEC.md` §13.3). The form
 * reads THIS product's plan through `productCan`, never `me().entitlement`.
 */
describe('VendorProductForm — the Free plan', () => {
  let updateProduct: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProduct = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProduct } as Partial<VendorApi> },
        VendorPortalStore,
      ],
    });
  });

  function build(): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', onPlan(capabilitiesFor('unclaimed')));
    fixture.detectChanges();
    return fixture;
  }

  const field = (fixture: ComponentFixture<VendorProductForm>, key: string) =>
    fixture.nativeElement.querySelector(`#vendor-product-${PRODUCT.id}-${key}`) as
      | HTMLInputElement
      | HTMLTextAreaElement;

  it('opens description and website, and keeps the two doc URLs readonly', () => {
    const fixture = build();
    expect(field(fixture, 'description').readOnly).toBe(false);
    expect(field(fixture, 'website').readOnly).toBe(false);
    // readonly, not disabled: the Managed value stays readable (§6.18).
    expect(field(fixture, 'tool-integrations-url').readOnly).toBe(true);
    expect(field(fixture, 'api-docs-url').readOnly).toBe(true);
    expect(field(fixture, 'api-docs-url').disabled).toBe(false);
    expect(field(fixture, 'api-docs-url').value).toBe(PRODUCT.api_docs_url ?? '');
  });

  it('offers Save and no paused notice', () => {
    const fixture = build();
    expect(saveButton(fixture)).not.toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('Editing is paused');
  });

  it('sends only the Free field it changed', async () => {
    updateProduct.mockResolvedValue({
      product: onPlan(capabilitiesFor('unclaimed')),
    } as UpdateVendorProductResponse);
    const fixture = build();

    setInput(fixture, DESCRIPTION_ID, 'A Free-plan description.');
    saveButton(fixture)!.click();
    await flush();

    expect(updateProduct).toHaveBeenCalledWith(PRODUCT.id, {
      description: 'A Free-plan description.',
    });
  });
});

/** The read-only state (AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8): a plan with
 *  no product capability at all. No real tier serves this since AECI-1214, but
 *  the form must still close cleanly on it, because an unknown tier fails closed. */
describe('VendorProductForm — read-only when the plan holds no product edit', () => {
  let updateProduct: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    updateProduct = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProduct } as Partial<VendorApi> },
        VendorPortalStore,
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function build(): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', onPlan([]));
    fixture.detectChanges();
    return fixture;
  }

  const fields = (fixture: ComponentFixture<VendorProductForm>): HTMLInputElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('input, textarea'));

  it('keeps every value readable, marked readonly rather than disabled', () => {
    const fixture = build();

    expect(fields(fixture).every((f) => f.readOnly)).toBe(true);
    expect(
      (fixture.nativeElement.querySelector(`#${DESCRIPTION_ID}`) as HTMLTextAreaElement).value,
    ).toBe(PRODUCT.description);
  });

  it('withholds Save and explains why', () => {
    const fixture = build();

    expect(saveButton(fixture)).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Editing is paused');
  });

  it('tells the connector catalogue seat product details stay with AECi (AECI-1082)', () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_CONNECTOR_SEAT_FIXTURE);
    const fixture = build();
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Product details stay with the AECi team');
    expect(text).not.toContain('Editing is paused');
    expect(text).not.toContain('renewal');
  });

  it('does not PATCH even if the form is submitted anyway', async () => {
    const fixture = build();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(updateProduct).not.toHaveBeenCalled();
  });
});
