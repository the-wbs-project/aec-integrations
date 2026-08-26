/**
 * The Products nav menu: a disclosure over a search box and a filtered listbox.
 *
 * ── WHY THIS SPEC CAN OPEN THE PANEL WHEN `aec-select`'s CANNOT ─────────────
 * `aec-select.component.spec.ts` and `search-sort-by.component.spec.ts` assert
 * only the CLOSED control, because opening one means going through Aria's own
 * combobox toggle and its activedescendant commit, which is jsdom-hostile. Here
 * the open state is ours: a plain `<button>` click writing a plain signal into
 * `cdkConnectedOverlayOpen`. And under jsdom there is no Popover API, so CDK
 * downgrades `usePopover` to the body-level `.cdk-overlay-container` — which is
 * why every open-state query below reads `document`, not the host.
 *
 * What stays out of reach, and lives in e2e instead: Aria's ArrowDown →
 * `aria-activedescendant` → Enter commit, real outside-click, and real focus
 * order out of the top layer. The commit HANDLER is called directly here, the
 * `search-autocomplete.component.spec.ts` idiom.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Location } from '@angular/common';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { VendorProduct } from '@aeci/shared';

import { VENDOR_ME_FIXTURE } from './vendor-fixtures';
import { VendorProductsMenu } from './vendor-products-menu';

const [PRIMARY, SECONDARY] = VENDOR_ME_FIXTURE.products;
/** Deliberately NOT alphabetical, so the sort has something to do. */
const PRODUCTS: readonly VendorProduct[] = [PRIMARY, SECONDARY];

/** Protected handler, exposed for the commit case. */
type Handlers = { onChoose(): void };

const hostProducts = signal<readonly VendorProduct[]>(PRODUCTS);

@Component({
  selector: 'aec-test-menu-host',
  imports: [VendorProductsMenu],
  template: `<aec-vendor-products-menu [products]="products()" label="Products" />`,
})
class TestMenuHost {
  protected readonly products = hostProducts;
}

async function mount(url = '/portal/products') {
  hostProducts.set(PRODUCTS);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        {
          path: 'portal',
          component: TestMenuHost,
          children: [
            { path: 'overview', children: [] },
            { path: 'products', children: [] },
            { path: 'products/:productSlug', children: [] },
          ],
        },
      ]),
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl(url);
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
  return harness;
}

const trigger = (harness: RouterTestingHarness) =>
  (harness.fixture.nativeElement as HTMLElement).querySelector('button')!;

/** The panel is portaled into the body-level overlay container under jsdom. */
const searchBox = () => document.querySelector<HTMLInputElement>('input[role="combobox"]');
const optionLabels = () =>
  [...document.querySelectorAll('[role="option"]')].map((el) => el.textContent?.trim());

async function open(harness: RouterTestingHarness): Promise<HTMLInputElement> {
  trigger(harness).click();
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
  return searchBox()!;
}

/** Type into the search box the way a person does. Focus FIRST: Aria's combobox
 *  ignores input from an unfocused control. */
async function type(harness: RouterTestingHarness, input: HTMLInputElement, value: string) {
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  harness.detectChanges();
  await harness.fixture.whenStable();
  harness.detectChanges();
}

beforeEach(() => TestBed.resetTestingModule());
afterEach(() => {
  document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
});

describe('VendorProductsMenu — closed', () => {
  it('is a collapsed disclosure with nothing of the panel in the DOM', async () => {
    const harness = await mount();
    const btn = trigger(harness);

    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // No aria-controls while the panel does not exist: a dangling reference is
    // worse than none.
    expect(btn.getAttribute('aria-controls')).toBeNull();
    // Deliberately no aria-haspopup: "true" is legacy-equivalent to "menu", and
    // this is a combobox panel, not a menu.
    expect(btn.getAttribute('aria-haspopup')).toBeNull();
    expect(searchBox()).toBeNull();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it('marks itself current on the products routes and nowhere else', async () => {
    expect(trigger(await mount('/portal/products')).getAttribute('aria-current')).toBe('true');
    expect(
      trigger(await mount('/portal/products/summit-field-issues')).getAttribute('aria-current'),
    ).toBe('true');
    expect(trigger(await mount('/portal/overview')).getAttribute('aria-current')).toBeNull();
  });
});

describe('VendorProductsMenu — open', () => {
  it('opens onto a labelled search box that takes focus', async () => {
    const harness = await mount();
    const input = await open(harness);

    expect(trigger(harness).getAttribute('aria-expanded')).toBe('true');
    expect(trigger(harness).getAttribute('aria-controls')).toBe('vendor-products-menu-panel');
    // A real <label for>, never placeholder-as-label.
    const label = document.querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent?.trim()).toBe('Filter products');
    // Focus moves in, or a keyboard user never learns a text field appeared.
    expect(document.activeElement).toBe(input);
  });

  it('lists every owned product, alphabetically', async () => {
    // The menu is a lookup, so it is ordered the way a reader looks something
    // up, not by `is_primary`.
    const harness = await mount();
    await open(harness);

    expect(optionLabels()).toEqual(['Summit Field Issues', 'Summit Model Coordination']);
  });

  it('narrows the list as you type', async () => {
    const harness = await mount();
    const input = await open(harness);

    await type(harness, input, 'field');
    expect(optionLabels()).toEqual(['Summit Field Issues']);
  });

  it('renders NO listbox when nothing matches', async () => {
    // The guard that matters. Aria expands the combobox on every keystroke, so
    // gating the expansion cannot keep an empty role="listbox" out of the DOM —
    // an aria-required-children violation. Gating the widget does.
    const harness = await mount();
    const input = await open(harness);

    await type(harness, input, 'zzzz');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(0);
    expect(document.querySelector('.cdk-overlay-container')?.textContent).toContain(
      'No products match that name',
    );
  });

  it('declares no live region of its own', async () => {
    // The portal has exactly one, in the shell (§6.3). A "3 products match"
    // status here would be the forbidden second one.
    const harness = await mount();
    const input = await open(harness);
    await type(harness, input, 'summit');

    expect(
      document.querySelectorAll('.cdk-overlay-container [role="status"], [aria-live]'),
    ).toHaveLength(0);
  });
});

describe('VendorProductsMenu — dismissal', () => {
  it('closes on Escape and gives focus back to the trigger', async () => {
    // Ours, not Aria's and not CDK's: Aria's Escape is inert under
    // `alwaysExpanded`, and CDK's would detach the overlay behind the back of
    // the open signal, leaving the trigger claiming to be expanded.
    const harness = await mount();
    const input = await open(harness);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(trigger(harness).getAttribute('aria-expanded')).toBe('false');
    expect(searchBox()).toBeNull();
    expect(document.activeElement).toBe(trigger(harness));
  });

  it('closes on Tab so focus resumes in the nav rather than at the top of the page', async () => {
    const harness = await mount();
    const input = await open(harness);

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(trigger(harness).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(trigger(harness));
  });

  it('toggles shut on a second click of the trigger', async () => {
    const harness = await mount();
    await open(harness);

    trigger(harness).click();
    harness.detectChanges();
    await harness.fixture.whenStable();

    expect(trigger(harness).getAttribute('aria-expanded')).toBe('false');
    expect(searchBox()).toBeNull();
  });
});

describe('VendorProductsMenu — choosing', () => {
  it('navigates to the product relative to the PORTAL route, not the section', async () => {
    // The easiest bug in this component: `vendor-products-page.ts` navigates
    // with `relativeTo: route.parent` because it is the child. This menu is
    // rendered by the shell, so `.parent` here would climb one route too far and
    // produce `/products/<slug>` with the vendor slug eaten.
    const harness = await mount();
    await open(harness);

    const api = harness.fixture.debugElement.query(
      (de) => de.componentInstance instanceof VendorProductsMenu,
    ).componentInstance as VendorProductsMenu & { selection: { set(v: VendorProduct[]): void } };
    api.selection.set([SECONDARY]);
    (api as unknown as Handlers).onChoose();
    await harness.fixture.whenStable();

    expect(TestBed.inject(Location).path()).toBe(`/portal/products/${SECONDARY.slug}`);
    // The panel closes with the navigation, and the selection resets so the same
    // product can be chosen again later.
    expect(trigger(harness).getAttribute('aria-expanded')).toBe('false');
  });
});

describe('VendorProductsMenu — a background refetch', () => {
  it('does not reshuffle the list or steal focus while the panel is open', async () => {
    // `VendorLiveSync` refetches `me` every 20s and products is one of its
    // scopes. A poll that adds a row under a pointer already travelling toward
    // one is exactly what §6.3 forbids, so the list is frozen while open.
    const harness = await mount();
    const input = await open(harness);
    const before = optionLabels();

    hostProducts.set([...PRODUCTS, { ...PRIMARY, slug: 'summit-late-arrival', name: 'Aardvark' }]);
    harness.detectChanges();
    await harness.fixture.whenStable();
    harness.detectChanges();

    expect(optionLabels()).toEqual(before);
    expect(document.activeElement).toBe(input);
  });

  it('picks the new product up on the next open', async () => {
    const harness = await mount();
    await open(harness);
    hostProducts.set([...PRODUCTS, { ...PRIMARY, slug: 'summit-late-arrival', name: 'Aardvark' }]);
    harness.detectChanges();

    trigger(harness).click(); // close
    harness.detectChanges();
    await open(harness);

    expect(optionLabels()?.[0]).toBe('Aardvark');
  });
});
