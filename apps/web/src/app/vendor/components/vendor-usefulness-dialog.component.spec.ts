import { provideZonelessChangeDetection } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProductUsefulness, TaxonomyTermWithCount } from '@aeci/shared';

import { toPoints, VendorUsefulnessDialog } from './vendor-usefulness-dialog';

/**
 * `VendorUsefulnessDialog` (AECI-963) is where "How teams use it" is written. Its
 * parent's spec pins the seam (staging, the dirty-diff, the echo); these pin the
 * picker, and specifically the four things that would otherwise reach the server
 * as a 400 or reach a reader as broken copy:
 *
 *   1. A ticked term with nothing written is BLOCKED, because
 *      `UsefulnessGroupSchema` requires at least one point and the form re-seeds
 *      from the echo — a dropped group would settle the form clean on nothing.
 *   2. Both caps are enforced client-side, so the counter and the validator agree.
 *   3. Done emits `{slug, points}` and never `name`.
 *   4. Cancel discards, and re-opening re-reads the committed value rather than
 *      resuming an abandoned draft.
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
  term('architects', 'Architects', 1, 'Design authorship and documentation.'),
  term('estimators', 'Estimators', 2, 'Takeoff, pricing, and bid assembly.'),
  term('superintendents', 'Superintendents', 3, null),
];

const VALUE: ProductUsefulness = {
  audiences: [{ slug: 'architects', name: 'Architects', points: ['Existing point'] }],
  phases: [],
};

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve));
}

function overlay(): HTMLElement | null {
  return document.querySelector('.cdk-overlay-container');
}

function boxes(): HTMLInputElement[] {
  return Array.from(overlay()?.querySelectorAll('input[type="checkbox"]') ?? []);
}

function rowFor(name: string): HTMLLabelElement {
  const labels = Array.from(overlay()?.querySelectorAll('label') ?? []) as HTMLLabelElement[];
  const found = labels.find((l) => (l.textContent ?? '').includes(name));
  if (!found) throw new Error(`no row for ${name}`);
  return found;
}

function areas(): HTMLTextAreaElement[] {
  return Array.from(overlay()?.querySelectorAll('textarea') ?? []);
}

function footerButton(label: string): HTMLButtonElement {
  const buttons = Array.from(overlay()?.querySelectorAll('button') ?? []) as HTMLButtonElement[];
  const found = buttons.find((b) => (b.textContent ?? '').trim() === label);
  if (!found) throw new Error(`no button labelled ${label}`);
  return found;
}

describe('VendorUsefulnessDialog', () => {
  let applied: ReturnType<
    typeof vi.fn<(groups: readonly { slug: string; points: string[] }[]) => void>
  >;

  beforeEach(() => {
    applied = vi.fn();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.querySelectorAll('.cdk-overlay-container').forEach((el) => el.remove());
  });

  function create(
    value: ProductUsefulness | null = VALUE,
    opts: { disabled?: boolean; maxGroups?: number; maxPoints?: number } = {},
  ): ComponentFixture<VendorUsefulnessDialog> {
    const fixture = TestBed.createComponent(VendorUsefulnessDialog);
    fixture.componentRef.setInput('facet', 'audiences');
    fixture.componentRef.setInput('legend', 'How teams use it: by audience');
    fixture.componentRef.setInput('terms', TERMS);
    fixture.componentRef.setInput('value', value);
    fixture.componentRef.setInput('maxGroups', opts.maxGroups ?? 10);
    fixture.componentRef.setInput('maxPoints', opts.maxPoints ?? 8);
    fixture.componentRef.setInput('maxPointLength', 200);
    fixture.componentRef.setInput('disabled', opts.disabled ?? false);
    fixture.componentInstance.apply.subscribe((groups) => applied(groups));
    fixture.detectChanges();
    return fixture;
  }

  function trigger(fixture: ComponentFixture<VendorUsefulnessDialog>): HTMLButtonElement {
    return fixture.nativeElement.querySelector('button') as HTMLButtonElement;
  }

  async function open(
    fixture: ComponentFixture<VendorUsefulnessDialog>,
  ): Promise<ComponentFixture<VendorUsefulnessDialog>> {
    trigger(fixture).click();
    await flush();
    fixture.detectChanges();
    return fixture;
  }

  async function settle(fixture: ComponentFixture<VendorUsefulnessDialog>): Promise<void> {
    await flush();
    fixture.detectChanges();
  }

  async function tick(
    fixture: ComponentFixture<VendorUsefulnessDialog>,
    name: string,
  ): Promise<void> {
    (rowFor(name).querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    await settle(fixture);
  }

  async function type(
    fixture: ComponentFixture<VendorUsefulnessDialog>,
    index: number,
    text: string,
  ): Promise<void> {
    const area = areas()[index]!;
    area.value = text;
    area.dispatchEvent(new Event('input', { bubbles: true }));
    await settle(fixture);
  }

  it('keeps the picker behind a trigger that names the facet it edits', () => {
    const fixture = create();
    expect(trigger(fixture).getAttribute('aria-label')).toBe('Edit How teams use it: by audience');
    expect(overlay()?.textContent ?? '').not.toContain('Estimators');
  });

  it('offers the full vocabulary with each description beside it', async () => {
    await open(create());
    expect(boxes()).toHaveLength(TERMS.length);
    expect(overlay()?.textContent).toContain('Design authorship and documentation.');
    // A term with no description still renders; the cell is simply absent.
    expect(overlay()?.textContent).toContain('Superintendents');
  });

  it('seeds ticks and text from the committed value, and only for its own facet', async () => {
    await open(create());
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
    expect(areas()).toHaveLength(1);
    expect(areas()[0]!.value).toBe('Existing point');
  });

  it('states that this publishes immediately, with no review', async () => {
    // There is no moderation queue and no "vendor supplied" label on the public
    // page, so the editor is the only place that fact can be told.
    await open(create());
    expect(overlay()?.textContent).toContain('publishes to your product page');
  });

  it('reveals a textarea only once a term is ticked', async () => {
    const fixture = await open(create(null));
    expect(areas()).toHaveLength(0);
    await tick(fixture, 'Estimators');
    expect(areas()).toHaveLength(1);
  });

  it('blocks Done on a ticked term with nothing written', async () => {
    const fixture = await open(create(null));
    await tick(fixture, 'Estimators');

    expect(footerButton('Done').disabled).toBe(true);
    expect(overlay()?.textContent).toContain('Write at least one line');
  });

  it('blocks Done past the points cap and names the limit', async () => {
    const fixture = await open(create(null, { maxPoints: 2 }));
    await tick(fixture, 'Estimators');
    await type(fixture, 0, 'one\ntwo\nthree');

    expect(footerButton('Done').disabled).toBe(true);
    expect(overlay()?.textContent).toContain('2 lines or fewer');
  });

  it('blocks Done past the group cap', async () => {
    const fixture = await open(create(null, { maxGroups: 1 }));
    await tick(fixture, 'Architects');
    await type(fixture, 0, 'a');
    await tick(fixture, 'Estimators');
    await type(fixture, 1, 'b');

    expect(footerButton('Done').disabled).toBe(true);
    expect(overlay()?.textContent).toContain('Untick some');
  });

  it('emits slug + cleaned points, and never a name', async () => {
    const fixture = await open(create(null));
    await tick(fixture, 'Estimators');
    // Blank lines and stray whitespace are the vendor's to make and ours to clean.
    await type(fixture, 0, '  First point  \n\n\nSecond point\n');
    footerButton('Done').click();
    await settle(fixture);

    expect(applied).toHaveBeenCalledWith([
      { slug: 'estimators', points: ['First point', 'Second point'] },
    ]);
  });

  it('emits an empty array when the last term is unticked', async () => {
    // The parent turns an all-empty value into `null`; this half just reports
    // that its facet is now empty.
    const fixture = await open(create());
    await tick(fixture, 'Architects');
    footerButton('Done').click();
    await settle(fixture);

    expect(applied).toHaveBeenCalledWith([]);
  });

  it('discards a draft on Cancel and re-reads the committed value on re-open', async () => {
    const fixture = await open(create());
    await tick(fixture, 'Estimators');
    await type(fixture, 1, 'Abandoned');
    footerButton('Cancel').click();
    await settle(fixture);
    expect(applied).not.toHaveBeenCalled();

    await open(fixture);
    expect(boxes().map((b) => b.checked)).toEqual([true, false, false]);
    expect(areas()[0]!.value).toBe('Existing point');
  });

  it('cannot be opened when disabled', () => {
    const fixture = create(VALUE, { disabled: true });
    expect(trigger(fixture).disabled).toBe(true);
  });

  it('labels each textarea for a screen reader without repeating it on screen', async () => {
    // The visible row label is the term name; the textarea needs its own name, or
    // a screen-reader user tabbing into it hears only "edit text".
    await open(create());
    const label = overlay()?.querySelector(`label[for="${areas()[0]!.id}"]`);
    expect(label?.textContent).toContain('Architects');
    expect(label?.className).toContain('sr-only');
  });
});

describe('toPoints', () => {
  it('drops blank lines and trims, so no point can be empty', () => {
    expect(toPoints('  a  \n\n b \n   \n')).toEqual(['a', 'b']);
  });

  it('returns [] for whitespace, which is what makes "ticked but empty" detectable', () => {
    expect(toPoints('   \n\n  ')).toEqual([]);
  });
});
