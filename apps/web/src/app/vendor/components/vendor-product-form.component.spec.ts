import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { UpdateVendorProductResponse, VendorProduct } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE } from '../vendor-fixtures';
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

/** The read-only state (AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8). */
describe('VendorProductForm — read-only when the entitlement lapsed', () => {
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

  function build(canEdit: boolean): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', PRODUCT);
    fixture.componentRef.setInput('canEdit', canEdit);
    fixture.detectChanges();
    return fixture;
  }

  const fields = (fixture: ComponentFixture<VendorProductForm>): HTMLInputElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('input, textarea'));

  it('keeps every value readable, marked readonly rather than disabled', () => {
    const fixture = build(false);

    expect(fields(fixture).every((f) => f.readOnly)).toBe(true);
    expect(
      (fixture.nativeElement.querySelector(`#${DESCRIPTION_ID}`) as HTMLTextAreaElement).value,
    ).toBe(PRODUCT.description);
  });

  it('withholds Save and explains why', () => {
    const fixture = build(false);

    expect(saveButton(fixture)).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Editing is paused');
  });

  it('does not PATCH even if the form is submitted anyway', async () => {
    const fixture = build(false);
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();

    expect(updateProduct).not.toHaveBeenCalled();
  });
});
