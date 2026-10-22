/**
 * AECI-1424: "Add a product" on the Products tab (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.7).
 *
 * What these pin:
 *   1. The list page mounts the trigger for an owner seat only. A member seat sees
 *      the one line that says who can add a product.
 *   2. The trigger opens the form; nothing is sent until the vendor submits, and
 *      `?create=open` on the tab opens it on first render.
 *   3. A submit with no name sends nothing and marks the field.
 *   4. A good submit sends exactly the filled fields, revalidates the products
 *      scope, shows the result with its link and lists the possible duplicates as a
 *      warning, never a block.
 *   5. Each refusal renders its own sentence in a `role="alert"`.
 */
import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CreateVendorProductResponse } from '@aeci/shared';

import { VendorProductListPage } from '../sections/vendor-product-list-page';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import { VENDOR_ME_FIXTURE, VENDOR_TAXONOMY_FIXTURE } from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorProductCreate } from './vendor-product-create';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));

let api: {
  createProduct: ReturnType<typeof vi.fn>;
  getTaxonomy: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
  getChecklist: ReturnType<typeof vi.fn>;
};

function apiError(status: number, code: string): HttpErrorResponse {
  return new HttpErrorResponse({ status, error: { error: { code, message: code } } });
}

function configure(opts: { owner?: boolean; query?: Record<string, string> } = {}): void {
  TestBed.resetTestingModule();
  api = {
    createProduct: vi.fn(),
    getTaxonomy: vi.fn().mockResolvedValue(VENDOR_TAXONOMY_FIXTURE),
    getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
    getChecklist: vi.fn().mockReturnValue(new Promise(() => undefined)),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
      ...(opts.query
        ? [
            {
              provide: ActivatedRoute,
              useValue: {
                snapshot: { queryParamMap: convertToParamMap(opts.query) },
              },
            },
          ]
        : []),
    ],
  });
  TestBed.inject(VendorPortalStore).seed({
    ...VENDOR_ME_FIXTURE,
    seat_owner: opts.owner ?? true,
  });
}

beforeEach(() => configure());
afterEach(() => vi.restoreAllMocks());

async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
  await flush();
  fixture.detectChanges();
}

async function mount(): Promise<ComponentFixture<VendorProductCreate>> {
  const fixture = TestBed.createComponent(VendorProductCreate);
  await settle(fixture);
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const q = <T extends Element>(fixture: ComponentFixture<unknown>, selector: string) =>
  el(fixture).querySelector<T>(selector);
const text = (node: Element | null) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function type(fixture: ComponentFixture<unknown>, selector: string, value: string) {
  const node = q<HTMLInputElement>(fixture, selector)!;
  node.value = value;
  node.dispatchEvent(new Event('input'));
  await settle(fixture);
}

async function open(fixture: ComponentFixture<unknown>): Promise<void> {
  q<HTMLButtonElement>(fixture, '[data-testid="add-product"]')!.click();
  await settle(fixture);
}

const submit = async (fixture: ComponentFixture<unknown>) => {
  q<HTMLFormElement>(fixture, 'form')!.dispatchEvent(new Event('submit'));
  await settle(fixture);
};

const panel = (fixture: ComponentFixture<unknown>) =>
  q(fixture, '[data-testid="product-create-panel"]');

const CREATED: CreateVendorProductResponse = {
  product: {
    id: '00000000-0000-4000-8000-000000007001',
    slug: 'summit-field',
    name: 'Summit Field',
  },
  possible_duplicates: [],
};

describe('on the Products tab', () => {
  it('shows the trigger to an owner seat', async () => {
    const fixture = TestBed.createComponent(VendorProductListPage);
    await settle(fixture);
    expect(q(fixture, '[data-testid="add-product"]')).not.toBeNull();
    expect(q(fixture, '[data-testid="product-create-member"]')).toBeNull();
  });

  it('shows a member seat who can add a product, and no trigger', async () => {
    configure({ owner: false });
    const fixture = TestBed.createComponent(VendorProductListPage);
    await settle(fixture);
    expect(q(fixture, '[data-testid="add-product"]')).toBeNull();
    expect(text(q(fixture, '[data-testid="product-create-member"]'))).toBe(
      'Only account owners can add a product. Ask an owner on the Seats tab.',
    );
  });

  it('opens the form on first render for ?create=open', async () => {
    configure({ query: { create: 'open' } });
    const fixture = TestBed.createComponent(VendorProductListPage);
    await settle(fixture);
    expect(panel(fixture)).not.toBeNull();
  });
});

describe('the form', () => {
  it('is closed until the trigger is pressed, and sends nothing on open', async () => {
    const fixture = await mount();
    expect(panel(fixture)).toBeNull();
    const trigger = q<HTMLButtonElement>(fixture, '[data-testid="add-product"]')!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await open(fixture);
    expect(panel(fixture)!.id).toBe(trigger.getAttribute('aria-controls'));
    expect(panel(fixture)!.getAttribute('role')).toBe('group');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(api.createProduct).not.toHaveBeenCalled();
  });

  it('lists the categories and says what is added later', async () => {
    const fixture = await mount();
    await open(fixture);
    const boxes = el(fixture).querySelectorAll(
      '[data-testid="product-create-categories"] input[type="checkbox"]',
    );
    expect(boxes).toHaveLength(VENDOR_TAXONOMY_FIXTURE.categories.length);
    expect(text(q(fixture, '[data-testid="product-create-later"]'))).toBe(
      'Trades, audiences, phases and "How teams use it" are added on the product\'s own tabs once it is listed.',
    );
  });

  it('returns focus to the trigger on cancel', async () => {
    const fixture = await mount();
    await open(fixture);
    q<HTMLButtonElement>(fixture, '[data-testid="product-create-cancel"]')!.click();
    await settle(fixture);
    expect(panel(fixture)).toBeNull();
    expect(document.activeElement).toBe(q(fixture, '[data-testid="add-product"]'));
  });

  it('sends nothing without a name, and marks the field', async () => {
    const fixture = await mount();
    await open(fixture);
    await submit(fixture);
    expect(api.createProduct).not.toHaveBeenCalled();
    const input = q<HTMLInputElement>(fixture, '#vendor-product-create-name')!;
    expect(input.getAttribute('aria-invalid')).toBe('true');
    const error = q(fixture, '#vendor-product-create-name-error')!;
    expect(input.getAttribute('aria-describedby')).toBe(error.id);
    expect(error.getAttribute('role')).toBe('alert');
    expect(text(error)).toBe('Enter the product name.');
  });

  it('refuses a website that is not a full link', async () => {
    const fixture = await mount();
    await open(fixture);
    await type(fixture, '#vendor-product-create-name', 'Summit Field');
    await type(fixture, '#vendor-product-create-website', 'summit.example.com');
    await submit(fixture);
    expect(api.createProduct).not.toHaveBeenCalled();
    expect(text(q(fixture, '#vendor-product-create-website-error'))).toContain('https://');
  });
});

describe('a good submit', () => {
  it('posts exactly the filled fields, revalidates products and shows the result', async () => {
    api.createProduct.mockResolvedValue(CREATED);
    const revalidate = vi.spyOn(TestBed.inject(VendorPortalStore), 'revalidate');
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    const fixture = await mount();
    await open(fixture);
    await type(fixture, '#vendor-product-create-name', '  Summit Field ');
    await type(fixture, '#vendor-product-create-website', 'https://summit.example.com/field');
    const second = VENDOR_TAXONOMY_FIXTURE.categories[1]!;
    const box = [
      ...el(fixture).querySelectorAll<HTMLLabelElement>(
        '[data-testid="product-create-categories"] label',
      ),
    ]
      .find((label) => text(label) === second.name)!
      .querySelector('input')!;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    await settle(fixture);
    await submit(fixture);

    expect(api.createProduct).toHaveBeenCalledWith({
      name: 'Summit Field',
      website: 'https://summit.example.com/field',
      category_slugs: [second.slug],
    });
    expect(revalidate).toHaveBeenCalledWith(['products']);
    expect(announce).toHaveBeenCalledWith('Summit Field was added to your listing.');
    expect(panel(fixture)).toBeNull();
    const result = q(fixture, '[data-testid="product-create-result"]')!;
    expect(result.textContent).toContain('Summit Field was added to your listing.');
    const link = q<HTMLAnchorElement>(fixture, '[data-testid="product-create-open"]')!;
    expect(text(link)).toBe('Open Summit Field');
    expect(link.getAttribute('href')).toBe('/summit-field');
    expect(q(fixture, '[data-testid="product-create-duplicates"]')).toBeNull();
    expect(document.activeElement).toBe(result.querySelector('[tabindex="-1"]'));
  });

  it('lists the possible duplicates and says both stay', async () => {
    api.createProduct.mockResolvedValue({
      ...CREATED,
      possible_duplicates: [
        { kind: 'product', id: 'p1', name: 'Summit Field', slug: 'summit-field-2' },
        { kind: 'proposal', id: 'pp1', name: 'Summit Field' },
      ],
    } satisfies CreateVendorProductResponse);
    const fixture = await mount();
    await open(fixture);
    await type(fixture, '#vendor-product-create-name', 'Summit Field');
    await submit(fixture);
    const dupes = q(fixture, '[data-testid="product-create-duplicates"]')!;
    expect(text(dupes)).toContain('Both stay as they are.');
    expect([...dupes.querySelectorAll('li')].map(text)).toEqual([
      'A product named Summit Field is already listed.',
      'A proposed product named Summit Field is waiting on the Proposed products tab.',
    ]);
  });
});

describe('a refusal', () => {
  const cases: ReadonlyArray<[number, string, string]> = [
    [403, 'FORBIDDEN', 'Only account owners can add a product.'],
    [409, 'SLUG_CONFLICT', 'Another product took this name at the same moment. Try again.'],
    [400, 'VALIDATION_FAILED', 'Check the fields, then try again.'],
    [429, 'RATE_LIMITED', 'Too many changes in a short time. Wait a minute and try again.'],
    [500, 'INTERNAL', 'Could not add the product. Try again.'],
  ];

  for (const [status, code, sentence] of cases) {
    it(`${code} says what to do`, async () => {
      api.createProduct.mockRejectedValue(apiError(status, code));
      const fixture = await mount();
      await open(fixture);
      await type(fixture, '#vendor-product-create-name', 'Summit Field');
      await submit(fixture);
      const notice = q(fixture, '[data-testid="product-create-notice"]')!;
      expect(notice.getAttribute('role')).toBe('alert');
      expect(text(notice)).toBe(sentence);
      expect(panel(fixture)).not.toBeNull();
    });
  }

  it('VENDOR_NOT_OWNED links to the contact page', async () => {
    api.createProduct.mockRejectedValue(apiError(409, 'VENDOR_NOT_OWNED'));
    const fixture = await mount();
    await open(fixture);
    await type(fixture, '#vendor-product-create-name', 'Summit Field');
    await submit(fixture);
    const notice = q(fixture, '[data-testid="product-create-notice"]')!;
    expect(text(notice)).toBe(
      'Your company does not own its records yet, so it cannot add a product from here. Contact us to change that.',
    );
    expect(
      notice.querySelector('[data-testid="product-create-contact"]')!.getAttribute('href'),
    ).toBe('/contact');
  });
});
