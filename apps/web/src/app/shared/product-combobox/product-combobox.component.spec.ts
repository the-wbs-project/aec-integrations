/**
 * AECI-1244: `ProductCombobox`, the shared type-ahead product picker.
 *
 * What these pin:
 *   1. Combobox semantics on a labelled text box, and no live region of its own.
 *   2. Debounce: nothing goes out under two letters or before the pause, and a
 *      burst of keystrokes sends one search for the last query.
 *   3. Stale responses are dropped: the latest query wins even when an earlier
 *      search answers last.
 *   4. Rows keep the server's order, leave out excluded ids, and show the vendor.
 *   5. The empty and error states render in the popup, and the count or the
 *      failure goes out through `announce`.
 *   6. Choosing a row, by keyboard or pointer, emits `picked` and clears the box.
 *   7. Enter in the box never submits the surrounding form. The clear button
 *      empties the box.
 *
 * The listbox renders into the body-level CDK overlay container under jsdom (no
 * Popover API), so popup queries go to `document`, not the host.
 */
import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PRODUCT_COMBOBOX_DEBOUNCE_MS,
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from './product-combobox';

const ACONEX: ProductComboboxItem = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Aconex',
  slug: 'aconex',
  logo_url: null,
  vendor: {
    id: '00000000-0000-4000-8000-000000000101',
    slug: 'oracle',
    name: 'Oracle',
    logo_url: null,
    verified: false,
  },
};
const PROCORE: ProductComboboxItem = {
  id: '00000000-0000-4000-8000-000000000002',
  name: 'Procore',
  slug: 'procore',
};
const PROJECTSIGHT: ProductComboboxItem = {
  id: '00000000-0000-4000-8000-000000000003',
  name: 'ProjectSight',
  slug: 'projectsight',
};

@Component({
  selector: 'aec-test-host',
  imports: [ProductCombobox],
  template: `
    <form (submit)="submits = submits + 1; $event.preventDefault()">
      <label for="pc">Product</label>
      <aec-product-combobox
        inputId="pc"
        [search]="search"
        [exclude]="exclude()"
        (picked)="picked.push($event)"
        (announce)="announced.push($event)"
      />
    </form>
  `,
})
class TestHost {
  search: ProductComboboxSearch = async () => ({ data: [] });
  readonly exclude = signal<readonly string[]>([]);
  readonly picked: ProductComboboxItem[] = [];
  readonly announced: string[] = [];
  submits = 0;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

function mount(search: ProductComboboxSearch) {
  TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
  const fixture = TestBed.createComponent(TestHost);
  fixture.componentInstance.search = search;
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const input = el.querySelector<HTMLInputElement>('#pc')!;
  return { fixture, host: fixture.componentInstance, el, input };
}

async function type(fixture: ComponentFixture<unknown>, input: HTMLInputElement, value: string) {
  input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await settle(fixture);
}

/** Type, then wait out the debounce and let the search settle. */
async function typeAndSettle(
  fixture: ComponentFixture<unknown>,
  input: HTMLInputElement,
  value: string,
) {
  await type(fixture, input, value);
  await wait(PRODUCT_COMBOBOX_DEBOUNCE_MS + 30);
  await settle(fixture);
}

const options = () => [...document.querySelectorAll<HTMLElement>('[data-product-option]')];
const stateText = () =>
  document.querySelector('[data-product-combobox-state]')?.textContent?.trim() ?? '';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ProductCombobox', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => {
    document.querySelectorAll('.cdk-overlay-container').forEach((n) => n.remove());
    vi.restoreAllMocks();
  });

  it('is a labelled combobox text box with no live region of its own', () => {
    const { el, input } = mount(vi.fn());
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(el.querySelector('label')?.getAttribute('for')).toBe('pc');
    expect(el.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it('waits for two letters and for the pause, then sends one search for the last query', async () => {
    const search = vi.fn(async () => ({ data: [PROCORE] }));
    const { fixture, input } = mount(search);

    await type(fixture, input, 'p');
    await wait(PRODUCT_COMBOBOX_DEBOUNCE_MS + 30);
    await settle(fixture);
    expect(search).not.toHaveBeenCalled();
    expect(stateText()).toContain('at least two letters');

    await type(fixture, input, 'pr');
    await type(fixture, input, 'pro');
    expect(search).not.toHaveBeenCalled();
    await type(fixture, input, 'proc');
    await wait(PRODUCT_COMBOBOX_DEBOUNCE_MS + 30);
    await settle(fixture);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith('proc');
  });

  it('drops an earlier answer that lands after a later one', async () => {
    const first = deferred<{ data: ProductComboboxItem[] }>();
    const second = deferred<{ data: ProductComboboxItem[] }>();
    const search = vi
      .fn<ProductComboboxSearch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { fixture, input } = mount(search);

    await typeAndSettle(fixture, input, 'pro');
    await typeAndSettle(fixture, input, 'proj');
    expect(search).toHaveBeenCalledTimes(2);

    second.resolve({ data: [PROJECTSIGHT] });
    await wait(0);
    await settle(fixture);
    first.resolve({ data: [PROCORE] });
    await wait(0);
    await settle(fixture);

    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain('ProjectSight');
  });

  it('drops an earlier answer that lands during the pause before the next search', async () => {
    const first = deferred<{ data: ProductComboboxItem[] }>();
    const second = deferred<{ data: ProductComboboxItem[] }>();
    const search = vi
      .fn<ProductComboboxSearch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { fixture, host, input } = mount(search);

    await typeAndSettle(fixture, input, 'pro');
    expect(search).toHaveBeenCalledTimes(1);
    const announcedBefore = host.announced.length;

    // "proj" is typed; its search has not left yet when "pro" answers.
    await type(fixture, input, 'proj');
    first.resolve({ data: [] });
    await wait(0);
    await settle(fixture);
    expect(search).toHaveBeenCalledTimes(1);
    expect(stateText()).toContain('Searching');
    expect(stateText()).not.toContain('pro');
    expect(host.announced).toHaveLength(announcedBefore);

    await wait(PRODUCT_COMBOBOX_DEBOUNCE_MS + 30);
    await settle(fixture);
    expect(search).toHaveBeenLastCalledWith('proj');
    second.resolve({ data: [PROJECTSIGHT] });
    await wait(0);
    await settle(fixture);
    expect(options()).toHaveLength(1);
    expect(options()[0]!.textContent).toContain('ProjectSight');
  });

  it('keeps the server order, leaves out excluded ids, and shows the vendor', async () => {
    const search = vi.fn(async () => ({ data: [ACONEX, PROCORE, PROJECTSIGHT] }));
    const { fixture, host, input } = mount(search);
    host.exclude.set([PROCORE.id]);
    await typeAndSettle(fixture, input, 'co');

    const rows = options();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('Aconex');
    expect(rows[0]!.textContent).toContain('Oracle');
    expect(rows[1]!.textContent).toContain('ProjectSight');
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    expect(host.announced.at(-1)).toBe('2 products found.');
  });

  it('says so when nothing matches, with no empty listbox', async () => {
    const { fixture, host, input } = mount(async () => ({ data: [] }));
    await typeAndSettle(fixture, input, 'zzz');
    expect(stateText()).toContain('No published product matches');
    expect(stateText()).toContain('zzz');
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    // Collapsed: an expanded combobox with no listbox fails axe aria-required-attr.
    expect(input.getAttribute('aria-expanded')).toBe('false');
    expect(host.announced.at(-1)).toBe('No products match.');
  });

  it('says so when the search fails', async () => {
    const { fixture, host, input } = mount(async () => {
      throw new Error('network');
    });
    await typeAndSettle(fixture, input, 'pro');
    expect(stateText()).toContain('did not work');
    expect(host.announced.at(-1)).toContain('did not work');
  });

  it('picks the highlighted row with ArrowDown and Enter, and clears the box', async () => {
    const { fixture, host, input } = mount(async () => ({ data: [ACONEX, PROCORE] }));
    await typeAndSettle(fixture, input, 'co');
    expect(input.getAttribute('aria-expanded')).toBe('true');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await settle(fixture);
    const activeId = input.getAttribute('aria-activedescendant');
    expect(activeId).toBeTruthy();
    const activeText = document.getElementById(activeId!)?.textContent ?? '';

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await settle(fixture);

    expect(host.picked).toHaveLength(1);
    expect(activeText).toContain(host.picked[0]!.name);
    expect(enter.defaultPrevented).toBe(true);
    expect(host.submits).toBe(0);
    expect(input.value).toBe('');
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('picks a row on click', async () => {
    const { fixture, host, input } = mount(async () => ({ data: [ACONEX, PROCORE] }));
    await typeAndSettle(fixture, input, 'co');
    const row = options()[1]!;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle(fixture);
    expect(host.picked.map((p) => p.name)).toEqual(['Procore']);
  });

  it('never submits the surrounding form on Enter while closed', async () => {
    const { fixture, host, input } = mount(vi.fn());
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await settle(fixture);
    expect(enter.defaultPrevented).toBe(true);
    expect(host.submits).toBe(0);
  });

  it('clears the box from the clear button', async () => {
    const { fixture, el, input } = mount(async () => ({ data: [PROCORE] }));
    await typeAndSettle(fixture, input, 'pro');
    const clear = el.querySelector<HTMLButtonElement>('[data-product-combobox-clear]')!;
    expect(clear.getAttribute('aria-label')).toBe('Clear the search');
    clear.click();
    await settle(fixture);
    expect(input.value).toBe('');
    expect(el.querySelector('[data-product-combobox-clear]')).toBeNull();
    expect(options()).toHaveLength(0);
  });
});
