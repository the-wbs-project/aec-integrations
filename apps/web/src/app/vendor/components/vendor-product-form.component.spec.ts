import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaxonomyResponse, UpdateVendorProductResponse, VendorProduct } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_TAXONOMY_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorProductForm } from './vendor-product-form';

/**
 * `VendorProductForm` (AECI-522) shares the dirty-diff / save scaffolding with
 * `VendorProfileForm` (pinned by its own spec + the profile-edit e2e), so these
 * specs focus on what is DISTINCTIVE to the product form.
 *
 * Since AECI-915 that is the split between reading taxonomy and writing it. The
 * page renders a SUMMARY card per facet — the assigned terms only, each with its
 * `description` behind an info control — and every write goes through
 * `VendorTaxonomyFacetDialog`, whose own spec pins the picker's behaviour. What
 * is pinned here is the seam between them: that the card shows what the server
 * says, that a modal save PATCHes exactly one facet, that the echo lands without
 * trampling unsaved text, and that the Taxonomy tab has no Save button of its own
 * (the modal already persisted, so there would be nothing to submit).
 */
const PRODUCT: VendorProduct = VENDOR_ME_FIXTURE.products[0];
/** The fixture product that DOES carry trades (most carry none, by design). */
const SECONDARY: VendorProduct = VENDOR_ME_FIXTURE.products[1];
const DESCRIPTION_ID = `vendor-product-${PRODUCT.id}-description`;

function saveButton(fixture: ComponentFixture<VendorProductForm>): HTMLButtonElement | null {
  return fixture.nativeElement.querySelector('button[type="submit"]');
}

/** The four facet summary cards, in render order: categories, audiences, phases,
 *  trades. */
function facetCards(fixture: ComponentFixture<VendorProductForm>): HTMLElement[] {
  return Array.from(fixture.nativeElement.querySelectorAll('section'));
}

function cardByName(fixture: ComponentFixture<VendorProductForm>, legend: string): HTMLElement {
  // Matched on the heading's WHOLE text, which pins the a11y rule as well as
  // finding the card: the facet hint's info control is a sibling of the <h3>,
  // so a hint nested back inside it would fail this lookup outright.
  const card = facetCards(fixture).find(
    (c) => (c.querySelector('h3')?.textContent ?? '').trim() === legend,
  );
  if (!card) throw new Error(`no facet card: ${legend}`);
  return card;
}

/** The assigned terms a facet card is showing, by visible label. */
function assigned(fixture: ComponentFixture<VendorProductForm>, legend: string): string[] {
  return Array.from(cardByName(fixture, legend).querySelectorAll('li > span')).map((s) =>
    (s.textContent ?? '').trim(),
  );
}

/** A facet card's pencil. The dialog component renders exactly one button in
 *  the document flow; its modal body is a portaled `ng-template`. */
function pencil(fixture: ComponentFixture<VendorProductForm>, legend: string): HTMLButtonElement {
  return cardByName(fixture, legend).querySelector(
    'aec-vendor-taxonomy-facet-dialog button',
  ) as HTMLButtonElement;
}

/** Every info control's accessible name — which IS its hint text (AECI-915). */
function hints(fixture: ComponentFixture<VendorProductForm>): string[] {
  return Array.from(fixture.nativeElement.querySelectorAll('aec-info-hint button')).map(
    (b) => (b as HTMLElement).getAttribute('aria-label') ?? '',
  );
}

function overlay(): HTMLElement | null {
  return document.querySelector('.cdk-overlay-container');
}

function modalRow(name: string): HTMLLabelElement {
  const labels = Array.from(overlay()?.querySelectorAll('label') ?? []) as HTMLLabelElement[];
  const found = labels.find((l) => (l.textContent ?? '').includes(name));
  if (!found) throw new Error(`no modal row for ${name}`);
  return found;
}

function modalButton(label: string): HTMLButtonElement {
  const buttons = Array.from(overlay()?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
  const found = buttons.find((b) => (b.textContent ?? '').trim() === label);
  if (!found) throw new Error(`no modal button: ${label}`);
  return found;
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
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function create(
    taxonomy: TaxonomyResponse | null = VENDOR_TAXONOMY_FIXTURE,
    product: VendorProduct = PRODUCT,
    section: 'all' | 'profile' | 'taxonomy' = 'all',
  ): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', product);
    fixture.componentRef.setInput('taxonomy', taxonomy);
    fixture.componentRef.setInput('section', section);
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorProductForm>): Promise<void> {
    await flush();
    fixture.detectChanges();
  }

  it('summarises each facet with the assigned terms only, in vocabulary order', () => {
    const fixture = create();

    // PRODUCT carries two categories and no trades. The other 4 category terms
    // are in the picker, not on the card — that is the whole point of the split.
    expect(assigned(fixture, 'Categories')).toEqual(['BIM authoring', 'Document control']);
    expect(assigned(fixture, 'Trades')).toEqual([]);
    expect(cardByName(fixture, 'Trades').textContent).toContain('None selected yet');
  });

  it('carries each assigned term description as an info control', () => {
    // The AECI-911 copy that separates adjacent terms reaches the vendor here.
    // The accessible name IS the description, so it is not hover-only.
    const fixture = create();
    expect(hints(fixture)).toContain(
      'Tools that create and edit the model itself, discipline by discipline. Clash detection and federation belong under BIM coordination.',
    );
  });

  it('puts every facet hint behind its heading, including the trades rule', () => {
    // "Most products have none" reads as broken next to three facets where more
    // tags is simply more accurate, so the rule is on the surface, not in a doc.
    const fixture = create();
    const all = hints(fixture).join(' | ');

    expect(all).toContain('the narrower one is usually right');
    expect(all).toContain('mixes disciplines like Architecture');
    expect(all).toContain('more is usually accurate here');
    expect(all).toContain('Most products have none');
  });

  it('renders a term the vocabulary does not know, rather than dropping it', () => {
    // The taxonomy fetch and the product payload are two round-trips and can
    // disagree. Hiding the row would understate what is actually published.
    const stray: VendorProduct = { ...PRODUCT, phase_slugs: ['a-phase-we-never-loaded'] };
    const fixture = create(VENDOR_TAXONOMY_FIXTURE, stray);

    expect(assigned(fixture, 'Phases')).toEqual(['a-phase-we-never-loaded']);
  });

  it('has no Save button on the Taxonomy tab, because the modal already saved', () => {
    const taxonomyOnly = create(VENDOR_TAXONOMY_FIXTURE, PRODUCT, 'taxonomy');
    expect(saveButton(taxonomyOnly)).toBeNull();

    // The Profile projection still submits text edits the ordinary way.
    const profileOnly = create(VENDOR_TAXONOMY_FIXTURE, PRODUCT, 'profile');
    expect(saveButton(profileOnly)).not.toBeNull();
  });

  it('PATCHes the one edited facet from the modal and repaints the card', async () => {
    updateProduct.mockResolvedValue({
      product: { ...PRODUCT, category_slugs: ['bim-authoring', 'document-control', 'estimating'] },
    } as UpdateVendorProductResponse);
    const fixture = create();

    pencil(fixture, 'Categories').click();
    await settle(fixture);
    modalRow('Estimating').click();
    await settle(fixture);
    modalButton('Save').click();
    await settle(fixture);

    // Full-set replacement for the touched facet, and only that facet: the three
    // sibling arrays stay absent so an untouched facet is never rewritten.
    expect(updateProduct).toHaveBeenCalledTimes(1);
    expect(updateProduct).toHaveBeenCalledWith(PRODUCT.id, {
      category_slugs: ['bim-authoring', 'document-control', 'estimating'],
    });
    // The echo is the source for the repaint, not the draft.
    // Vocabulary order, not assignment order, so the card does not reshuffle.
    expect(assigned(fixture, 'Categories')).toEqual([
      'BIM authoring',
      'Estimating',
      'Document control',
    ]);
    expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent).toContain(
      'Product updated',
    );
  });

  it('sends trade_slugs as its own set, and can clear the last one', async () => {
    updateProduct.mockResolvedValue({
      product: { ...SECONDARY, trade_slugs: [] },
    } as UpdateVendorProductResponse);
    const fixture = create(VENDOR_TAXONOMY_FIXTURE, SECONDARY);

    expect(assigned(fixture, 'Trades')).toEqual(['Electrical', 'HVAC & Mechanical']);

    pencil(fixture, 'Trades').click();
    await settle(fixture);
    modalRow('Electrical').click();
    modalRow('HVAC & Mechanical').click();
    await settle(fixture);
    modalButton('Save').click();
    await settle(fixture);

    // An empty set is the honest answer for a product that stopped having
    // trade-specific value, so it has to reach the endpoint.
    expect(updateProduct).toHaveBeenCalledWith(SECONDARY.id, { trade_slugs: [] });
    expect(assigned(fixture, 'Trades')).toEqual([]);
  });

  it('does not trample unsaved text when a facet echo lands', async () => {
    // Only reachable in the `section: 'all'` projection, where the modal and the
    // text fields share this component. A full re-seed here would silently throw
    // away typing the vendor never submitted.
    updateProduct.mockResolvedValue({
      product: { ...PRODUCT, category_slugs: ['bim-authoring', 'document-control', 'estimating'] },
    } as UpdateVendorProductResponse);
    const fixture = create();

    setInput(fixture, DESCRIPTION_ID, 'A revised product description.');
    pencil(fixture, 'Categories').click();
    await settle(fixture);
    modalRow('Estimating').click();
    await settle(fixture);
    modalButton('Save').click();
    await settle(fixture);

    const textarea = fixture.nativeElement.querySelector(
      `#${DESCRIPTION_ID}`,
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('A revised product description.');
    // Still dirty, so the submit button is still live for the text edit.
    expect(saveButton(fixture)?.disabled).toBe(false);
  });

  it('leaves the modal open, with no page-level error, when the facet save fails', async () => {
    updateProduct.mockRejectedValue(new Error('boom'));
    const fixture = create();

    pencil(fixture, 'Categories').click();
    await settle(fixture);
    modalRow('Estimating').click();
    await settle(fixture);
    modalButton('Save').click();
    await settle(fixture);

    // The message belongs next to the work that failed, not at the foot of the
    // page behind the modal.
    expect(overlay()?.textContent).toContain('Something went wrong saving these');
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
    // Nothing was committed, so the card still shows the server's set.
    expect(assigned(fixture, 'Categories')).toEqual(['BIM authoring', 'Document control']);
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

  it('waits for the vocabulary before claiming a facet is empty', () => {
    // With no taxonomy loaded, the slugs are known but the names are not. Saying
    // "None selected yet" there would be a lie about a tagged product.
    const fixture = create(null);
    expect(cardByName(fixture, 'Categories').textContent).toContain('Loading options');
    expect(cardByName(fixture, 'Categories').textContent).not.toContain('None selected yet');
    expect(pencil(fixture, 'Categories').disabled).toBe(true);
  });
});

/**
 * The read-only state (AECI-614 / `STAGE_2_PAID_TIERS_SPEC.md` §8). The product
 * form carries the FIELD-granular half of §3.3b: the PATCH asserts `product.edit`
 * for the handler and `product.taxonomy.edit` again when facet arrays ride along,
 * so the form mirrors both axes instead of collapsing them into one flag.
 */
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
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function build(canEdit: boolean, canEditTaxonomy = canEdit): ComponentFixture<VendorProductForm> {
    const fixture = TestBed.createComponent(VendorProductForm);
    fixture.componentRef.setInput('product', PRODUCT);
    fixture.componentRef.setInput('taxonomy', VENDOR_TAXONOMY_FIXTURE);
    fixture.componentRef.setInput('canEdit', canEdit);
    fixture.componentRef.setInput('canEditTaxonomy', canEditTaxonomy);
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

  it('withholds Save, explains why, and disables the facet pencils', () => {
    const fixture = build(false);

    expect(saveButton(fixture)).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Editing is paused');
    const pencils = ['Categories', 'Audiences', 'Phases', 'Trades'].map(
      (f) => pencil(fixture, f).disabled,
    );
    expect(pencils).toEqual([true, true, true, true]);
  });

  it('leaves the taxonomy readable: the summary still reports what is assigned', () => {
    const fixture = build(false);
    // Disabled must not mean invisible: the vendor can still see their taxonomy,
    // and the descriptions that explain it.
    expect(assigned(fixture, 'Categories')).toContain('BIM authoring');
    expect(hints(fixture).length).toBeGreaterThan(0);
  });

  it('refuses a facet write without the taxonomy capability', async () => {
    const fixture = build(false);
    // The pencil is disabled, so drive the seam directly: the component must
    // refuse rather than trust the disabled attribute it rendered.
    const ok = await (
      fixture.componentInstance as unknown as {
        saverFor(k: string): (s: string[]) => Promise<boolean>;
      }
    ).saverFor('category_slugs')(['estimating']);

    expect(ok).toBe(false);
    expect(updateProduct).not.toHaveBeenCalled();
  });

  it('gates taxonomy on its OWN capability, even while text editing is open', () => {
    // Not reachable on the binary launch ladder, but §3.3b is field-granular by
    // construction so that adding a rung is a data edit, not a code change.
    const fixture = build(true, false);

    expect(fields(fixture).some((f) => f.readOnly)).toBe(false);
    expect(saveButton(fixture)).not.toBeNull();
    expect(pencil(fixture, 'Categories').disabled).toBe(true);
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
