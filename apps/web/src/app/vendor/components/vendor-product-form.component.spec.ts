import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaxonomyResponse, UpdateVendorProductResponse, VendorProduct } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_TAXONOMY_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';
import { VendorProductForm } from './vendor-product-form';
import { VendorUsefulnessDialog } from './vendor-usefulness-dialog';

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
    const termHints = Array.from(
      fixture.nativeElement.querySelectorAll('li aec-info-hint'),
    ) as HTMLElement[];
    const headingHints = Array.from(
      fixture.nativeElement.querySelectorAll('h3 + aec-info-hint'),
    ) as HTMLElement[];

    expect(hints(fixture)).toContain(
      'Tools that create and edit the model itself, discipline by discipline. Clash detection and federation belong under BIM coordination.',
    );
    // Term names can wrap, so align the hint to the first line rather than
    // centring it against the whole text block. Heading hints already sit in an
    // `items-center` row and must not inherit this caller-specific correction.
    expect(termHints.length).toBeGreaterThan(0);
    expect(termHints.every((hint) => hint.classList.contains('mt-0.5'))).toBe(true);
    expect(headingHints.length).toBeGreaterThan(0);
    expect(headingHints.every((hint) => !hint.classList.contains('mt-0.5'))).toBe(true);
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

  // ── AECI-963: "How teams use it" ──────────────────────────────────────────
  //
  // The seam only. `VendorUsefulnessDialog` has its own spec for the picker
  // itself; these drive its `apply` output directly, because what is distinctive
  // HERE is that a staged draft joins the dirty-diff, survives an echo, and
  // reaches the wire without the server-owned `name`.
  describe('usefulness', () => {
    const AUDIENCE_CARD = 'How teams use it: by audience';
    const PHASE_CARD = 'How teams use it: by phase';

    function dialogs(fixture: ComponentFixture<VendorProductForm>): VendorUsefulnessDialog[] {
      return fixture.debugElement
        .queryAll(By.directive(VendorUsefulnessDialog))
        .map((d) => d.componentInstance as VendorUsefulnessDialog);
    }

    /** Stage one facet's replacement, as the modal's Done button would. */
    function apply(
      fixture: ComponentFixture<VendorProductForm>,
      facet: 'audiences' | 'phases',
      groups: { slug: string; points: string[] }[],
    ): void {
      const dialog = dialogs(fixture).find((d) => d.facet() === facet)!;
      dialog.apply.emit(groups);
      fixture.detectChanges();
    }

    function usefulnessPencil(
      fixture: ComponentFixture<VendorProductForm>,
      legend: string,
    ): HTMLButtonElement {
      return cardByName(fixture, legend).querySelector(
        'aec-vendor-usefulness-dialog button',
      ) as HTMLButtonElement;
    }

    it('renders the published groups and their points from the server copy', () => {
      const fixture = create();
      const card = cardByName(fixture, AUDIENCE_CARD);
      expect(card.textContent).toContain('Architects');
      expect(card.textContent).toContain('Run clash detection');
    });

    it('says the section is hidden when a product has nothing written', () => {
      // SECONDARY carries `usefulness: null` — the state every product starts in.
      const fixture = create(VENDOR_TAXONOMY_FIXTURE, SECONDARY);
      expect(cardByName(fixture, AUDIENCE_CARD).textContent).toContain('Nothing written yet');
    });

    it('does NOT send usefulness when the vendor never touched it', async () => {
      // The endpoint requires >= 1 changed field, so a form that always sent this
      // would turn every description edit into a silent ownership claim.
      const fixture = create();
      updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
      setInput(fixture, DESCRIPTION_ID, 'Just the description');
      saveButton(fixture)?.click();
      await settle(fixture);

      expect(updateProduct).toHaveBeenCalledWith(PRODUCT.id, {
        description: 'Just the description',
      });
    });

    it('stages a draft, repaints the card, and sends it WITHOUT any group name', async () => {
      const fixture = create();
      apply(fixture, 'phases', [{ slug: 'design', points: ['Set up the sheet set.'] }]);

      // Staged, not persisted: applying must not have PATCHed anything.
      expect(updateProduct).not.toHaveBeenCalled();
      // The card repaints from the draft, before any save, and shows the term's
      // display name resolved from the vocabulary.
      const card = cardByName(fixture, PHASE_CARD);
      expect(card.textContent).toContain('Design');
      expect(card.textContent).toContain('Set up the sheet set.');
      expect(saveButton(fixture)?.disabled).toBe(false);

      updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
      saveButton(fixture)?.click();
      await settle(fixture);

      const body = updateProduct.mock.calls[0]![1] as {
        usefulness: { phases: { slug: string; points: string[] }[] };
      };
      expect(body.usefulness.phases).toEqual([
        { slug: 'design', points: ['Set up the sheet set.'] },
      ]);
      // `name` is server-resolved because the public page renders it verbatim.
      expect(JSON.stringify(body.usefulness)).not.toContain('name');
    });

    it('carries the OTHER facet through untouched', async () => {
      // The wire field is the complete value, so staging one facet alone must not
      // clear the other.
      const fixture = create();
      apply(fixture, 'phases', [{ slug: 'design', points: ['Phase copy'] }]);

      updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
      saveButton(fixture)?.click();
      await settle(fixture);

      const body = updateProduct.mock.calls[0]![1] as {
        usefulness: { audiences: { slug: string }[] };
      };
      expect(body.usefulness.audiences.map((g) => g.slug)).toEqual(['architects']);
    });

    it('sends null once both facets are emptied', async () => {
      const fixture = create();
      apply(fixture, 'audiences', []);
      apply(fixture, 'phases', []);

      updateProduct.mockResolvedValue({ product: PRODUCT } as UpdateVendorProductResponse);
      saveButton(fixture)?.click();
      await settle(fixture);

      // `null`, never `{audiences: [], phases: []}` — the server normalises the
      // latter anyway, and the echo would then disagree with what was staged.
      expect(updateProduct.mock.calls[0]![1]).toEqual({ usefulness: null });
    });

    it('re-seeds from the PATCH echo so the form settles clean', async () => {
      const fixture = create();
      apply(fixture, 'phases', [{ slug: 'design', points: ['Staged text'] }]);

      updateProduct.mockResolvedValue({
        product: {
          ...PRODUCT,
          usefulness: {
            audiences: [],
            phases: [{ slug: 'design', name: 'Design', points: ['Staged text'] }],
          },
        },
      } as UpdateVendorProductResponse);
      saveButton(fixture)?.click();
      await settle(fixture);

      expect(saveButton(fixture)?.disabled).toBe(true);
      expect(cardByName(fixture, PHASE_CARD).textContent).toContain('Staged text');
    });

    it('does not go dirty when only a taxonomy RENAME differs', () => {
      // `name` is derived from the slug, so a renamed term is AECi's edit, not the
      // vendor's, and must not make a clean form look dirty.
      const renamed = {
        ...PRODUCT,
        usefulness: {
          audiences: PRODUCT.usefulness!.audiences.map((g) => ({ ...g, name: 'Renamed' })),
          phases: PRODUCT.usefulness!.phases,
        },
      };
      const fixture = create(VENDOR_TAXONOMY_FIXTURE, renamed);
      expect(saveButton(fixture)?.disabled).toBe(true);
    });

    it('still saves other fields when the STORED block breaks a cap it never had', async () => {
      // Promote enforces none of `VendorUsefulnessSchema`'s caps, so a promoted
      // block can arrive over-long. Validating the untouched server copy would
      // disable Save for every field on the product, with nothing saying why.
      const overCap = {
        ...PRODUCT,
        usefulness: {
          audiences: [
            { slug: 'architects', name: 'Architects', points: ['x'.repeat(240)] },
            ...Array.from({ length: 10 }, () => ({
              slug: 'architects',
              name: 'Architects',
              points: ['still fine'],
            })),
          ],
          phases: [],
        },
      };
      const fixture = create(VENDOR_TAXONOMY_FIXTURE, overCap);
      updateProduct.mockResolvedValue({ product: overCap } as UpdateVendorProductResponse);
      setInput(fixture, DESCRIPTION_ID, 'An unrelated edit');
      expect(saveButton(fixture)?.disabled).toBe(false);

      saveButton(fixture)?.click();
      await settle(fixture);
      expect(updateProduct).toHaveBeenCalledWith(overCap.id, {
        description: 'An unrelated edit',
      });
    });

    it('still blocks a save that would SEND an over-cap block', () => {
      const fixture = create();
      apply(fixture, 'phases', [{ slug: 'design', points: ['x'.repeat(240)] }]);
      expect(saveButton(fixture)?.disabled).toBe(true);
    });

    it('disables the pencil for a vendor whose account access has lapsed', () => {
      const fixture = create();
      fixture.componentRef.setInput('canEdit', false);
      fixture.detectChanges();
      expect(usefulnessPencil(fixture, AUDIENCE_CARD).disabled).toBe(true);
    });

    it('disables the pencil until the vocabulary loads', () => {
      // Opening a term picker with no terms would show an empty modal.
      const fixture = create(null);
      expect(usefulnessPencil(fixture, AUDIENCE_CARD).disabled).toBe(true);
      expect(cardByName(fixture, AUDIENCE_CARD).textContent).toContain('Loading options');
    });
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
