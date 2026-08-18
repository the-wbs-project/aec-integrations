import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  TaxonomyResponse,
  TaxonomyTermWithCount,
  UpdateVendorProductResponse,
  VendorProduct,
} from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_TAXONOMY_FIXTURE } from '../vendor-fixtures';
import { VendorProductForm } from './vendor-product-form';

/**
 * `VendorProductForm` (AECI-522) shares the dirty-diff / save scaffolding with
 * `VendorProfileForm` (pinned by its own spec + the profile-edit e2e), so these
 * specs focus on the three paths that are DISTINCTIVE to the product form and
 * would otherwise ship unverified: the `aria-pressed` taxonomy toggle, the
 * ORDER-INSENSITIVE set-replacement diff (`sameSet`), and the per-facet 10-term
 * cap. Plus one success round-trip to prove the echo re-seeds the baseline clean.
 */
const PRODUCT: VendorProduct = VENDOR_ME_FIXTURE.products[0];
const DESCRIPTION_ID = `vendor-product-${PRODUCT.id}-description`;

function term(slug: string, name: string, order: number): TaxonomyTermWithCount {
  return {
    id: `tax-${slug}`,
    slug,
    name,
    description: null,
    display_order: order,
    product_count: 0,
  };
}

function saveButton(fixture: ComponentFixture<VendorProductForm>): HTMLButtonElement {
  return fixture.nativeElement.querySelector('button[type="submit"]') as HTMLButtonElement;
}

/** All toggle chips in the first facet fieldset (Categories). */
function categoryChips(fixture: ComponentFixture<VendorProductForm>): HTMLButtonElement[] {
  const fieldset = fixture.nativeElement.querySelectorAll('fieldset')[0] as HTMLElement;
  return Array.from(fieldset.querySelectorAll('button[aria-pressed]'));
}

/** A single toggle chip found by its visible label (across all facets). */
function chipByName(fixture: ComponentFixture<VendorProductForm>, name: string): HTMLButtonElement {
  const all = Array.from(
    fixture.nativeElement.querySelectorAll('button[aria-pressed]'),
  ) as HTMLButtonElement[];
  const chip = all.find((b) => (b.textContent ?? '').trim() === name);
  if (!chip) throw new Error(`chip not found: ${name}`);
  return chip;
}

function click(fixture: ComponentFixture<VendorProductForm>, el: HTMLElement): void {
  el.click();
  fixture.detectChanges();
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
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        { provide: VendorApi, useValue: { updateProduct } as Partial<VendorApi> },
      ],
    });
  });

  afterEach(() => vi.restoreAllMocks());

  function create(
    taxonomy: TaxonomyResponse | null = VENDOR_TAXONOMY_FIXTURE,
    product: VendorProduct = PRODUCT,
  ): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', product);
    fixture.componentRef.setInput('taxonomy', taxonomy);
    fixture.detectChanges();
    return fixture;
  }

  it('disables Save until a real edit, and enables it when a chip is toggled', () => {
    const fixture = create();
    expect(saveButton(fixture).disabled).toBe(true);

    // PRODUCT is not tagged "Estimating"; toggling it on is a genuine change.
    click(fixture, chipByName(fixture, 'Estimating'));
    expect(saveButton(fixture).disabled).toBe(false);
  });

  it('sends the full replacement set for a facet when a chip is toggled', async () => {
    updateProduct.mockResolvedValue({ product: { ...PRODUCT } } as UpdateVendorProductResponse);
    const fixture = create();

    click(fixture, chipByName(fixture, 'Estimating'));
    saveButton(fixture).click();
    await flush();

    // Full-set replacement (existing two + the newly added one), not a delta —
    // and only the touched facet is in the PATCH body.
    expect(updateProduct).toHaveBeenCalledTimes(1);
    expect(updateProduct).toHaveBeenCalledWith(PRODUCT.id, {
      category_slugs: ['bim-authoring', 'document-control', 'estimating'],
    });
  });

  it('treats reordering the same terms as no change (order-insensitive sameSet)', () => {
    const fixture = create();

    // Remove then re-add the same term: the selection array's ORDER now differs
    // from the baseline, but the SET is identical, so Save must settle disabled.
    click(fixture, chipByName(fixture, 'BIM authoring'));
    expect(saveButton(fixture).disabled).toBe(false); // one removed → a real change
    click(fixture, chipByName(fixture, 'BIM authoring'));
    expect(saveButton(fixture).disabled).toBe(true); // same set as baseline → no change
  });

  it('blocks the save with an inline error when a facet exceeds 10 terms', () => {
    const bigTaxonomy: TaxonomyResponse = {
      categories: Array.from({ length: 11 }, (_, i) =>
        term(`cat-${i + 1}`, `Category ${i + 1}`, i + 1),
      ),
      audiences: [],
      phases: [],
      trades: [],
    };
    const emptyProduct: VendorProduct = {
      ...PRODUCT,
      category_slugs: [],
      audience_slugs: [],
      phase_slugs: [],
    };
    const fixture = create(bigTaxonomy, emptyProduct);

    // Ten selected is exactly at the cap: valid, Save enabled, no error.
    for (let i = 0; i < 10; i++) click(fixture, categoryChips(fixture)[i]);
    expect(saveButton(fixture).disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();

    // The eleventh tips it over the cap → inline error + Save disabled.
    click(fixture, categoryChips(fixture)[10]);
    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Choose at most 10');
    expect(saveButton(fixture).disabled).toBe(true);
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('confirms and re-disables Save on a successful save (echo re-seeds the baseline)', async () => {
    updateProduct.mockResolvedValue({
      product: { ...PRODUCT, category_slugs: ['bim-authoring', 'document-control', 'estimating'] },
    } as UpdateVendorProductResponse);
    const fixture = create();

    click(fixture, chipByName(fixture, 'Estimating'));
    saveButton(fixture).click();
    await flush();
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('[role="status"]');
    expect(status?.textContent).toContain('Product updated');
    expect(saveButton(fixture).disabled).toBe(true);
  });

  it('surfaces a retryable error when the save fails', async () => {
    updateProduct.mockRejectedValue(new Error('boom'));
    const fixture = create();

    setInput(fixture, DESCRIPTION_ID, 'A revised product description.');
    saveButton(fixture).click();
    await flush();
    fixture.detectChanges();

    const alert = fixture.nativeElement.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Something went wrong');
    // Still enabled so the user can retry.
    expect(saveButton(fixture).disabled).toBe(false);
  });
});
