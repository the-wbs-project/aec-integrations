import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { VendorTaxonomyFacetDialog } from './vendor-taxonomy-facet-dialog';

/**
 * `VendorTaxonomyFacetDialog` (AECI-915) is where product taxonomy is now
 * actually edited, so these specs pin the four behaviours the surface depends on
 * and that nothing else covers:
 *
 *   1. The full vocabulary AND each term's description are in the picker — the
 *      descriptions (AECI-911) exist to separate adjacent terms, and this is the
 *      only place in the portal they render.
 *   2. Save sends the whole replacement set for one facet, and a no-op Save
 *      sends nothing at all (the endpoint 400s an empty PATCH body).
 *   3. A failed save keeps the modal open with the draft intact. Closing it
 *      would discard exactly the work that failed to persist.
 *   4. Cancel discards, and re-opening re-reads the committed set rather than
 *      resuming the abandoned draft.
 */
function term(
  slug: string,
  name: string,
  display_order: number,
  description: string | null = null,
): TaxonomyTermWithCount {
  return { id: `tax-${slug}`, slug, name, description, display_order, product_count: 0 };
}

const TERMS: readonly TaxonomyTermWithCount[] = [
  term('bim-authoring', 'BIM Authoring', 1, 'Tools that create and edit the model itself.'),
  term('bim-coordination', 'BIM Coordination', 2, 'Federating models and clash detection.'),
  term('estimating', 'Estimating', 3, 'Quantity takeoff, unit pricing, and cost databases.'),
  term('scheduling', 'Scheduling', 4, null),
];

const HINT = 'Pick what your product does, not every feature it touches.';

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

/** `BrnDialog`'s default `closeDelay` is 100ms, so a close assertion made on the
 *  next microtask still sees the panel. */
function closeDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 150));
}

function overlay(): HTMLElement | null {
  return document.querySelector('.cdk-overlay-container');
}

/** Every row's checkbox, in render order. */
function boxes(): HTMLInputElement[] {
  return Array.from(overlay()?.querySelectorAll('input[type="checkbox"]') ?? []);
}

/** A row's `<label>` — the whole-row click target. */
function row(name: string): HTMLLabelElement {
  const labels = Array.from(overlay()?.querySelectorAll('label') ?? []) as HTMLLabelElement[];
  const found = labels.find((l) => (l.textContent ?? '').includes(name));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

function footerButton(label: string): HTMLButtonElement {
  const buttons = Array.from(overlay()?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
  const found = buttons.find((b) => (b.textContent ?? '').trim() === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe('VendorTaxonomyFacetDialog', () => {
  let save: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    save = vi.fn().mockResolvedValue(true);
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function create(
    selected: readonly string[] = ['bim-authoring'],
    opts: { disabled?: boolean; maxTerms?: number; terms?: readonly TaxonomyTermWithCount[] } = {},
  ): ComponentFixture<VendorTaxonomyFacetDialog> {
    const fixture = TestBed.createComponent(VendorTaxonomyFacetDialog);
    fixture.componentRef.setInput('legend', 'Categories');
    fixture.componentRef.setInput('hint', HINT);
    fixture.componentRef.setInput('terms', opts.terms ?? TERMS);
    fixture.componentRef.setInput('selected', selected);
    fixture.componentRef.setInput('maxTerms', opts.maxTerms ?? 10);
    fixture.componentRef.setInput('disabled', opts.disabled ?? false);
    fixture.componentRef.setInput('save', save);
    fixture.detectChanges();
    return fixture;
  }

  function trigger(fixture: ComponentFixture<VendorTaxonomyFacetDialog>): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  }

  async function open(
    fixture: ComponentFixture<VendorTaxonomyFacetDialog>,
  ): Promise<ComponentFixture<VendorTaxonomyFacetDialog>> {
    trigger(fixture).click();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorTaxonomyFacetDialog>): Promise<void> {
    await flush();
    fixture.detectChanges();
  }

  /** Wait out the dialog's close animation, then re-read the DOM. */
  async function settleClosed(fixture: ComponentFixture<VendorTaxonomyFacetDialog>): Promise<void> {
    await closeDelay();
    fixture.detectChanges();
  }

  it('keeps the picker behind the trigger, which names the facet it edits', () => {
    const fixture = create();

    expect(trigger(fixture).getAttribute('aria-label')).toBe('Edit Categories');
    expect(overlay()?.textContent ?? '').not.toContain('BIM Authoring');
  });

  it('offers the full vocabulary with each term description beside it', async () => {
    await open(create());

    expect(boxes()).toHaveLength(TERMS.length);
    // The reason this modal exists: the AECI-911 copy that separates the two
    // adjacent BIM terms is on screen at the moment of choosing.
    expect(overlay()?.textContent).toContain('Tools that create and edit the model itself.');
    expect(overlay()?.textContent).toContain('Federating models and clash detection.');
    // A term with no description still renders; the cell is simply absent.
    expect(overlay()?.textContent).toContain('Scheduling');
  });

  it('writes the facet hint out in full, rather than tooltipping it', async () => {
    // On the summary card behind this the hint is an info-control overlay. Here
    // there is room, and this is the moment the guidance is actually needed.
    await open(create());
    expect(overlay()?.textContent).toContain(HINT);
  });

  it('seeds the draft from the committed set', async () => {
    await open(create(['bim-authoring', 'estimating']));

    const checked = boxes()
      .map((b, i) => (b.checked ? TERMS[i].name : null))
      .filter((n): n is string => n !== null);
    expect(checked).toEqual(['BIM Authoring', 'Estimating']);
  });

  it('toggles from a click anywhere in the row, not just on the box', async () => {
    const fixture = await open(create([]));

    // The description text is inside the <label>, so the whole row is the target.
    row('BIM Coordination').click();
    await settle(fixture);

    expect(boxes()[1].checked).toBe(true);
  });

  it('sends the full replacement set for the one facet on Save', async () => {
    const fixture = await open(create(['bim-authoring']));

    row('Estimating').click();
    await settle(fixture);
    footerButton('Save').click();
    await settle(fixture);

    // Full-set replacement, not a delta.
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(['bim-authoring', 'estimating']);
  });

  it('sends an empty set when the last term is cleared', async () => {
    // A product that stopped having anything in this facet is a real edit, not
    // a no-op, so an empty array has to reach the endpoint.
    const fixture = await open(create(['bim-authoring']));

    row('BIM Authoring').click();
    await settle(fixture);
    footerButton('Save').click();
    await settle(fixture);

    expect(save).toHaveBeenCalledWith([]);
  });

  it('saves nothing when the set is unchanged, including after a reorder', async () => {
    const fixture = await open(create(['bim-authoring']));

    // Off then on again: the draft array's ORDER now differs from the committed
    // set, but the SET is identical. `PATCH` requires >= 1 changed field, so an
    // unchanged Save must not reach the endpoint at all.
    row('BIM Authoring').click();
    await settle(fixture);
    row('BIM Authoring').click();
    await settle(fixture);
    footerButton('Save').click();
    await settleClosed(fixture);

    expect(save).not.toHaveBeenCalled();
    // ...and it closed anyway, so an unchanged Save is not a dead button.
    expect(overlay()?.textContent ?? '').not.toContain('BIM Coordination');
  });

  it('blocks Save past the per-facet cap and says so', async () => {
    const fixture = await open(create([], { maxTerms: 2 }));

    row('BIM Authoring').click();
    row('BIM Coordination').click();
    await settle(fixture);
    expect(footerButton('Save').disabled).toBe(false);
    expect(overlay()?.textContent).toContain('2 of 2 selected');

    row('Estimating').click();
    await settle(fixture);
    expect(footerButton('Save').disabled).toBe(true);
    expect(overlay()?.querySelector('[role="alert"]')?.textContent).toContain('Too many');
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps the modal open with the draft intact when the save is refused', async () => {
    save.mockResolvedValue(false);
    const fixture = await open(create(['bim-authoring']));

    row('Estimating').click();
    await settle(fixture);
    footerButton('Save').click();
    await settle(fixture);

    expect(overlay()?.querySelector('[role="alert"]')?.textContent).toContain(
      'Something went wrong',
    );
    // Still open, still holding the work the save failed to persist.
    expect(boxes()[2].checked).toBe(true);
    expect(footerButton('Save').disabled).toBe(false);
  });

  it('discards the draft on Cancel, and re-reads the committed set on reopen', async () => {
    const fixture = await open(create(['bim-authoring']));

    row('Estimating').click();
    await settle(fixture);
    footerButton('Cancel').click();
    await settleClosed(fixture);
    expect(save).not.toHaveBeenCalled();

    await open(fixture);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false, false]);
  });

  it('disables the trigger when taxonomy editing is not available', () => {
    const fixture = create(['bim-authoring'], { disabled: true });
    expect(trigger(fixture).disabled).toBe(true);
  });
});
