import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaxonomyResponse, UpdateVendorProductResponse, VendorProduct } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import {
  VENDOR_ME_CONNECTOR_SEAT_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_TAXONOMY_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorProductFacetEditor, type ProductFacetKind } from './vendor-product-facet-editor';

/**
 * `VendorProductFacetEditor` (AECI-994): one taxonomy facet, inline, with the
 * "How teams use it" points under each ticked Audience or Phase.
 *
 * What is pinned: the full vocabulary renders with descriptions; nothing writes
 * until Save; one PATCH carries the slug array AND `usefulness` together; the wire
 * never carries a group `name`; unticking a term with points asks first and shows
 * them; points for an UNtagged term are shown, not silently dropped; and the
 * capability axes stay field-granular.
 */
const PRODUCT: VendorProduct = VENDOR_ME_FIXTURE.products[0];
/** `usefulness: null`, trades present. */
const SECONDARY: VendorProduct = VENDOR_ME_FIXTURE.products[1];

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function overlay(): HTMLElement | null {
  return document.querySelector('.cdk-overlay-container');
}

describe('VendorProductFacetEditor', () => {
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
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function create(
    facet: ProductFacetKind,
    opts: {
      product?: VendorProduct;
      taxonomy?: TaxonomyResponse | null;
      canEdit?: boolean;
      canEditTaxonomy?: boolean;
      canEditUsefulness?: boolean;
    } = {},
  ): ComponentFixture<VendorProductFacetEditor> {
    const fixture = TestBed.createComponent(VendorProductFacetEditor);
    fixture.componentRef.setInput('product', opts.product ?? PRODUCT);
    fixture.componentRef.setInput('facet', facet);
    fixture.componentRef.setInput(
      'taxonomy',
      opts.taxonomy === undefined ? VENDOR_TAXONOMY_FIXTURE : opts.taxonomy,
    );
    fixture.componentRef.setInput('canEdit', opts.canEdit ?? true);
    fixture.componentRef.setInput('canEditTaxonomy', opts.canEditTaxonomy ?? true);
    fixture.componentRef.setInput('canEditUsefulness', opts.canEditUsefulness ?? true);
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorProductFacetEditor>): Promise<void> {
    await flush();
    fixture.detectChanges();
  }

  const el = (f: ComponentFixture<VendorProductFacetEditor>) => f.nativeElement as HTMLElement;

  function row(f: ComponentFixture<VendorProductFacetEditor>, name: string): HTMLLIElement {
    const found = Array.from(el(f).querySelectorAll('fieldset > ul > li')).find((li) =>
      (li.querySelector('label')?.textContent ?? '').includes(name),
    );
    if (!found) throw new Error(`no row: ${name}`);
    return found as HTMLLIElement;
  }

  function checkbox(f: ComponentFixture<VendorProductFacetEditor>, name: string) {
    return row(f, name).querySelector('input[type="checkbox"]') as HTMLInputElement;
  }

  function toggle(f: ComponentFixture<VendorProductFacetEditor>, name: string): void {
    checkbox(f, name).click();
    f.detectChanges();
  }

  function pointInputs(f: ComponentFixture<VendorProductFacetEditor>, name: string) {
    return Array.from(
      row(f, name).querySelectorAll('aec-vendor-bullet-list-editor input[type="text"]'),
    ) as HTMLInputElement[];
  }

  function type(f: ComponentFixture<VendorProductFacetEditor>, input: HTMLInputElement, v: string) {
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    f.detectChanges();
  }

  function addPoint(f: ComponentFixture<VendorProductFacetEditor>, name: string): void {
    (row(f, name).querySelector('[data-action="add"]') as HTMLButtonElement).click();
    f.detectChanges();
  }

  const save = (f: ComponentFixture<VendorProductFacetEditor>) =>
    el(f).querySelector('button[type="submit"]') as HTMLButtonElement | null;

  // ── Simple facets ────────────────────────────────────────────────────────

  it('renders the whole vocabulary inline, ticked where assigned, with descriptions', () => {
    const f = create('categories');
    const rows = el(f).querySelectorAll('fieldset > ul > li');
    expect(rows.length).toBe(VENDOR_TAXONOMY_FIXTURE.categories.length);
    expect(checkbox(f, 'Project management').checked).toBe(false);
    expect(row(f, 'Project management').textContent).toContain('Schedules, tasks, budgets');
    // No modal on a simple facet, and no point lists.
    expect(el(f).querySelector('aec-vendor-bullet-list-editor')).toBeNull();
  });

  it('writes nothing until Save, then PATCHes only the slug array', async () => {
    updateProduct.mockResolvedValue({
      product: { ...PRODUCT, category_slugs: [...PRODUCT.category_slugs, 'project-management'] },
    } as UpdateVendorProductResponse);
    const f = create('categories');
    expect(save(f)?.disabled).toBe(true);

    toggle(f, 'Project management');
    expect(updateProduct).not.toHaveBeenCalled();
    expect(save(f)?.disabled).toBe(false);

    save(f)!.click();
    await settle(f);

    const [, body] = updateProduct.mock.calls[0]!;
    expect(Object.keys(body)).toEqual(['category_slugs']);
    expect([...body.category_slugs].sort()).toEqual(
      [...PRODUCT.category_slugs, 'project-management'].sort(),
    );
    expect(el(f).querySelector('[role="status"]')?.textContent).toContain('Product updated');
    expect(save(f)?.disabled).toBe(true);
  });

  it('splices the save echo into the store so sibling tabs see it', async () => {
    const store = TestBed.inject(VendorPortalStore);
    store.seed(VENDOR_ME_FIXTURE);
    const echo = { ...PRODUCT, category_slugs: ['project-management'] };
    updateProduct.mockResolvedValue({ product: echo } as UpdateVendorProductResponse);
    const f = create('categories');

    for (const slug of PRODUCT.category_slugs) {
      const term = VENDOR_TAXONOMY_FIXTURE.categories.find((t) => t.slug === slug)!;
      toggle(f, term.name);
    }
    toggle(f, 'Project management');
    save(f)!.click();
    await settle(f);

    expect(store.me()?.products.find((p) => p.id === PRODUCT.id)?.category_slugs).toEqual([
      'project-management',
    ]);
  });

  it('stops offering new ticks at the 10-term cap', () => {
    const terms = Array.from({ length: 11 }, (_, n) => ({
      id: `c${n}`,
      slug: `cat-${n}`,
      name: `Category ${n}`,
      description: null,
      display_order: n,
      product_count: 0,
    }));
    const taxonomy = { ...VENDOR_TAXONOMY_FIXTURE, categories: terms };
    const product = { ...PRODUCT, category_slugs: terms.slice(0, 10).map((t) => t.slug) };
    const f = create('categories', { product, taxonomy });

    expect(checkbox(f, 'Category 10').disabled).toBe(true);
    // A ticked term can always be unticked.
    expect(checkbox(f, 'Category 0').disabled).toBe(false);
    expect(el(f).textContent).toContain('10 of 10 selected');
  });

  it('keeps a tagged slug the vocabulary does not know', () => {
    const f = create('phases', {
      product: { ...PRODUCT, phase_slugs: ['a-phase-we-never-loaded'], usefulness: null },
    });
    expect(checkbox(f, 'a-phase-we-never-loaded').checked).toBe(true);
  });

  it('waits for the vocabulary before rendering the list', () => {
    const f = create('categories', { taxonomy: null });
    expect(el(f).textContent).toContain('Loading options');
    expect(el(f).querySelector('fieldset')).toBeNull();
  });

  // ── Audiences and Phases: points under the tag ───────────────────────────

  it('shows the stored points under each ticked term', () => {
    const f = create('audiences');
    expect(pointInputs(f, 'Architects').map((i) => i.value)).toEqual(
      PRODUCT.usefulness!.audiences[0]!.points,
    );
    // Ticked but nothing written: the list is offered, empty.
    expect(pointInputs(f, 'Structural engineers')).toEqual([]);
    expect(row(f, 'Structural engineers').querySelector('[data-action="add"]')).not.toBeNull();
  });

  it('does not go dirty on seed', () => {
    expect(save(create('audiences'))?.disabled).toBe(true);
  });

  it('sends the tag and its points in ONE PATCH, without group names', async () => {
    updateProduct.mockResolvedValue({ product: SECONDARY } as UpdateVendorProductResponse);
    const f = create('audiences', { product: SECONDARY });

    toggle(f, 'Architects');
    addPoint(f, 'Architects');
    type(f, pointInputs(f, 'Architects')[0]!, '  Lay out the design set  ');
    addPoint(f, 'Architects');
    // A blank point is dropped, never sent.
    save(f)!.click();
    await settle(f);

    const [, body] = updateProduct.mock.calls[0]!;
    expect(body.audience_slugs).toContain('architects');
    expect(body.usefulness).toEqual({
      audiences: [{ slug: 'architects', points: ['Lay out the design set'] }],
      phases: [],
    });
  });

  it('carries the OTHER facet through untouched', async () => {
    updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
    const f = create('audiences');

    type(f, pointInputs(f, 'Architects')[0]!, 'Rewritten point');
    save(f)!.click();
    await settle(f);

    const [, body] = updateProduct.mock.calls[0]!;
    expect(body.audience_slugs).toBeUndefined();
    expect(body.usefulness.phases).toEqual([
      { slug: 'design', points: PRODUCT.usefulness!.phases[0]!.points },
    ]);
  });

  it('treats reordering points as an edit', async () => {
    updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
    const f = create('audiences');
    const [first, second] = PRODUCT.usefulness!.audiences[0]!.points;

    (row(f, 'Architects').querySelector('[data-action^="down-"]') as HTMLButtonElement).click();
    f.detectChanges();
    expect(save(f)?.disabled).toBe(false);

    save(f)!.click();
    await settle(f);
    expect(updateProduct.mock.calls[0]![1].usefulness.audiences[0].points).toEqual([second, first]);
  });

  it('asks before unticking a term with points, and shows the points', async () => {
    const f = create('audiences');

    toggle(f, 'Architects');
    await settle(f);

    // Held ticked until the vendor decides.
    expect(checkbox(f, 'Architects').checked).toBe(true);
    const dialog = overlay();
    expect(dialog?.textContent).toContain('Remove the points for Architects?');
    for (const point of PRODUCT.usefulness!.audiences[0]!.points) {
      expect(dialog?.textContent).toContain(point);
    }
  });

  it('removes the tag and its points once confirmed, and sends null when nothing remains', async () => {
    updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
    const product = {
      ...PRODUCT,
      usefulness: { audiences: PRODUCT.usefulness!.audiences, phases: [] },
    };
    const f = create('audiences', { product });

    toggle(f, 'Architects');
    await settle(f);
    const remove = Array.from(overlay()!.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Remove',
    )!;
    remove.click();
    await settle(f);

    expect(checkbox(f, 'Architects').checked).toBe(false);
    save(f)!.click();
    await settle(f);
    const [, body] = updateProduct.mock.calls[0]!;
    expect(body.audience_slugs).not.toContain('architects');
    expect(body.usefulness).toBeNull();
  });

  it('keeps everything when the vendor backs out of the removal', async () => {
    const f = create('audiences');
    toggle(f, 'Architects');
    await settle(f);
    Array.from(overlay()!.querySelectorAll('button'))
      .find((b) => b.textContent?.trim() === 'Keep them')!
      .click();
    await settle(f);

    expect(checkbox(f, 'Architects').checked).toBe(true);
    expect(pointInputs(f, 'Architects').length).toBe(2);
    expect(save(f)?.disabled).toBe(true);
  });

  it('unticks a term with no written points without asking', async () => {
    const f = create('audiences');
    toggle(f, 'Structural engineers');
    await settle(f);
    expect(overlay()?.textContent ?? '').not.toContain('Remove the points');
    expect(checkbox(f, 'Structural engineers').checked).toBe(false);
  });

  it('shows points stored for an UNtagged term instead of dropping them', () => {
    const product = { ...PRODUCT, audience_slugs: ['structural-engineers'] };
    const f = create('audiences', { product });

    expect(checkbox(f, 'Architects').checked).toBe(false);
    expect(row(f, 'Architects').textContent).toContain('not tagged with this term');
    expect(pointInputs(f, 'Architects').length).toBe(2);
    // Showing them is not an edit.
    expect(save(f)?.disabled).toBe(true);
  });

  it('blocks Save while a point is over the length cap', () => {
    const f = create('audiences');
    type(f, pointInputs(f, 'Architects')[0]!, 'x'.repeat(201));
    expect(save(f)?.disabled).toBe(true);
    expect(el(f).querySelector('[role="alert"]')?.textContent).toContain('too long');
  });

  // ── Gates ────────────────────────────────────────────────────────────────

  it('tells the connector catalogue seat product details stay with AECi (AECI-1082)', () => {
    TestBed.inject(VendorPortalStore).seed(VENDOR_ME_CONNECTOR_SEAT_FIXTURE);
    const f = create('audiences', { canEdit: false });

    expect(el(f).textContent).toContain('Product details stay with the AECi team');
    expect(el(f).textContent).not.toContain('Editing is paused');
    expect(save(f)).toBeNull();
  });

  it('is read-only with Save withheld when account access lapsed', async () => {
    const f = create('audiences', { canEdit: false });
    expect(save(f)).toBeNull();
    expect(el(f).textContent).toContain('Editing is paused');
    expect(checkbox(f, 'Architects').disabled).toBe(true);
    expect(pointInputs(f, 'Architects').every((i) => i.readOnly)).toBe(true);
    expect(el(f).querySelector('[data-action="add"]')).toBeNull();

    (el(f).querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await flush();
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('gates tags and points on their OWN capabilities', () => {
    const tagsLocked = create('audiences', { canEditTaxonomy: false });
    expect(checkbox(tagsLocked, 'Architects').disabled).toBe(true);
    expect(pointInputs(tagsLocked, 'Architects').some((i) => i.readOnly)).toBe(false);

    const pointsLocked = create('audiences', { canEditUsefulness: false });
    expect(checkbox(pointsLocked, 'Architects').disabled).toBe(false);
    expect(pointInputs(pointsLocked, 'Architects').every((i) => i.readOnly)).toBe(true);
  });
});
