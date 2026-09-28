/**
 * AECI-1149 (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.1) — the product's Integrations
 * list: one row per integration, each a link to its own page; status chips over the
 * §6.17.2 set; the load ladder; per-product scoping; URL state.
 *
 * The drill-down, card and lane tests this file used to hold went with those
 * components (AECI-1156). The page's own behaviour is pinned under
 * `vendor/integration-detail/`.
 */
import { Location } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListVendorContestsResponse } from '@aeci/shared';

import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  CONTEST_RECEIVED_ON_OWNED,
  INTEGRATION_OWNED_CLAIMED,
  VENDOR_INTEGRATIONS_EMPTY_FIXTURE,
  VENDOR_INTEGRATIONS_FIXTURE,
  VENDOR_ME_FIXTURE,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { filterFromParams } from './vendor-integration-list-model';
import { VendorIntegrationsSection } from './vendor-integrations-section';

let api: {
  getIntegrations: ReturnType<typeof vi.fn>;
  getContests: ReturnType<typeof vi.fn>;
};

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const NO_CONTESTS: ListVendorContestsResponse = { submitted: [], received: [] };

beforeEach(() => {
  TestBed.resetTestingModule();
  api = {
    getIntegrations: vi.fn().mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE),
    getContests: vi.fn().mockResolvedValue(NO_CONTESTS),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as unknown as VendorApi },
      VendorPortalStore,
    ],
  });
  TestBed.inject(VendorPortalStore).seed(VENDOR_ME_FIXTURE);
});
afterEach(() => vi.restoreAllMocks());

async function create(
  options: { canAuthor?: boolean; contextProductId?: string | null; urlState?: boolean } = {},
): Promise<ComponentFixture<VendorIntegrationsSection>> {
  const fixture = TestBed.createComponent(VendorIntegrationsSection);
  fixture.componentRef.setInput('canAuthor', options.canAuthor ?? true);
  fixture.componentRef.setInput('vendorName', 'Summit BIM');
  fixture.componentRef.setInput('contextProductId', options.contextProductId ?? null);
  fixture.componentRef.setInput('urlState', options.urlState ?? false);
  for (let n = 0; n < 3; n++) {
    fixture.detectChanges();
    await flush();
  }
  fixture.detectChanges();
  return fixture;
}

const el = (fixture: ComponentFixture<unknown>) => fixture.nativeElement as HTMLElement;
const text = (fixture: ComponentFixture<unknown>) => el(fixture).textContent ?? '';
const rows = (fixture: ComponentFixture<unknown>) => [
  ...el(fixture).querySelectorAll<HTMLAnchorElement>('a[data-testid^="integration-row-"]'),
];
const rowFor = (fixture: ComponentFixture<unknown>, id: string) =>
  el(fixture).querySelector<HTMLAnchorElement>(`a[data-testid="integration-row-${id}"]`);
const chip = (fixture: ComponentFixture<unknown>, key: string) =>
  el(fixture).querySelector<HTMLButtonElement>(`[data-testid="status-chip-${key}"]`)!;

const PROCORE = VENDOR_INTEGRATIONS_FIXTURE.integrations[0]!;
const PRIMARY = PROCORE.context_product.id;

describe('VendorIntegrationsSection — rows link to the page (§6.17.1)', () => {
  it('renders one link per integration', async () => {
    const fixture = await create();
    expect(rows(fixture)).toHaveLength(VENDOR_INTEGRATIONS_FIXTURE.integrations.length);
  });

  it('links each row to its own page', async () => {
    const fixture = await create({ urlState: true });
    const href = rowFor(fixture, PROCORE.id)!.getAttribute('href') ?? '';
    expect(href).toContain(`/integrations/${PROCORE.id}`);
  });

  it('shows the other product, what is shared, and the §6.17.2 status pill', async () => {
    const fixture = await create({ contextProductId: PRIMARY });
    const row = rowFor(fixture, PROCORE.id)!.textContent ?? '';
    expect(row).toContain('by Procore Technologies');
    expect(row).toContain('Models and RFIs are sent to Procore');
    expect(row).toContain('Drawings are shared both ways');
    expect(row).toContain('Disagreement open');
  });

  it('keeps every list a real list, with no element between ul and li', async () => {
    const fixture = await create();
    for (const list of el(fixture).querySelectorAll('ul')) {
      for (const child of list.children) expect(child.tagName).toBe('LI');
    }
  });

  it('shows a counterpart with one integration as a row, and several as a named group', async () => {
    const fixture = await create({ contextProductId: PRIMARY });
    // Procore has two integrations under the primary product: a group with a heading.
    const headings = [...el(fixture).querySelectorAll('h2')].map((h) => h.textContent?.trim());
    expect(headings).toContain('Procore');
    // Acumatica has one: no heading, the row itself names it.
    expect(headings).not.toContain('Acumatica');
    expect(text(fixture)).toContain('Acumatica');
  });

  it('says "Your product" on an integration between two of the caller’s products', async () => {
    const fixture = await create({ contextProductId: PRIMARY });
    const both = VENDOR_INTEGRATIONS_FIXTURE.integrations[1]!;
    expect(rowFor(fixture, both.id)!.textContent).toContain('Your product');
  });

  it('reads change requests into the status: a received request needs a decision', async () => {
    api.getIntegrations.mockResolvedValue({
      ...VENDOR_INTEGRATIONS_FIXTURE,
      integrations: [
        {
          ...INTEGRATION_OWNED_CLAIMED,
          claims: INTEGRATION_OWNED_CLAIMED.claims.filter((c) => c.mine.length > 0),
        },
      ],
    });
    api.getContests.mockResolvedValue({ submitted: [], received: [CONTEST_RECEIVED_ON_OWNED] });
    const fixture = await create();
    expect(rowFor(fixture, INTEGRATION_OWNED_CLAIMED.id)!.textContent).toContain(
      'Needs your decision',
    );
  });
});

describe('VendorIntegrationsSection — status chips', () => {
  it('offers All plus every status that has a result, with counts', async () => {
    const fixture = await create();
    expect(chip(fixture, 'all').textContent).toContain(
      String(VENDOR_INTEGRATIONS_FIXTURE.integrations.length),
    );
    expect(chip(fixture, 'disagreement')).not.toBeNull();
    expect(chip(fixture, 'needs_answer')).not.toBeNull();
    expect(el(fixture).querySelector('[data-testid="status-chip-retired"]')).toBeNull();
  });

  it('filters to one status, and clears', async () => {
    const fixture = await create();
    chip(fixture, 'disagreement').click();
    fixture.detectChanges();
    expect(rows(fixture).map((r) => r.dataset['testid'])).toEqual([
      `integration-row-${PROCORE.id}`,
    ]);
    expect(chip(fixture, 'disagreement').getAttribute('aria-pressed')).toBe('true');
    const clear = [...el(fixture).querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Clear filters'),
    )!;
    clear.click();
    fixture.detectChanges();
    expect(rows(fixture)).toHaveLength(VENDOR_INTEGRATIONS_FIXTURE.integrations.length);
  });

  it('maps the old §6.3 status values to their nearest key', () => {
    const params = (status: string) => ({ get: (n: string) => (n === 'status' ? status : null) });
    expect(filterFromParams(params('conflict')).status).toBe('disagreement');
    expect(filterFromParams(params('needs_you')).status).toBe('needs_answer');
    expect(filterFromParams(params('nonsense')).status).toBe('all');
    expect(filterFromParams(params('needs_decision')).status).toBe('needs_decision');
  });

  it('filters by text across types of data', async () => {
    const fixture = await create();
    const input = el(fixture).querySelector<HTMLInputElement>('#vendor-integrations-query')!;
    input.value = 'invoices';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(rows(fixture)).toHaveLength(1);
    expect(rows(fixture)[0]!.textContent).toContain('Acumatica');
  });

  it('writes the filter to the URL without navigating, when routed', async () => {
    const location = TestBed.inject(Location);
    const replace = vi.spyOn(location, 'replaceState');
    const fixture = await create({ urlState: true });
    chip(fixture, 'disagreement').click();
    fixture.detectChanges();
    expect(replace).toHaveBeenLastCalledWith('/?status=disagreement');
  });

  it('does not touch the URL when unrouted', async () => {
    const location = TestBed.inject(Location);
    const replace = vi.spyOn(location, 'replaceState');
    const fixture = await create();
    chip(fixture, 'disagreement').click();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('VendorIntegrationsSection — the load ladder', () => {
  it('offers a retry when the list fails, and announces its outcome', async () => {
    api.getIntegrations.mockRejectedValue(new Error('offline'));
    const fixture = await create();
    expect(text(fixture)).toContain('Could not load your integrations.');
    api.getIntegrations.mockResolvedValue(VENDOR_INTEGRATIONS_FIXTURE);
    const announce = vi.spyOn(TestBed.inject(VendorPortalAnnouncer), 'announce');
    [...el(fixture).querySelectorAll('button')]
      .find((b) => b.textContent?.includes('Try again'))!
      .click();
    await flush();
    await flush();
    fixture.detectChanges();
    expect(rows(fixture).length).toBeGreaterThan(0);
    expect(announce).toHaveBeenCalledWith('Your integrations are up to date.');
  });

  it('explains an empty surface', async () => {
    api.getIntegrations.mockResolvedValue(VENDOR_INTEGRATIONS_EMPTY_FIXTURE);
    const fixture = await create();
    expect(text(fixture)).toContain('No integrations are on record for your products yet.');
  });

  it('explains the read-only state without access, and still lists everything', async () => {
    const fixture = await create({ canAuthor: false });
    expect(text(fixture)).toContain('opens up with active vendor access');
    expect(rows(fixture)).toHaveLength(VENDOR_INTEGRATIONS_FIXTURE.integrations.length);
  });

  it('declares no live region of its own', async () => {
    const fixture = await create();
    expect(el(fixture).querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it('summarises rows of data and those waiting on the caller', async () => {
    const fixture = await create({ contextProductId: PRIMARY });
    expect(el(fixture).querySelector('[data-testid="integrations-summary"]')?.textContent).toMatch(
      /rows of data on record · \d+ need your answer/,
    );
  });
});

describe('VendorIntegrationsSection — per-product scoping', () => {
  it('shows only the entries filed under the given product', async () => {
    const fixture = await create({ contextProductId: PRIMARY });
    const expected = VENDOR_INTEGRATIONS_FIXTURE.integrations.filter(
      (i) => i.context_product.id === PRIMARY,
    ).length;
    expect(rows(fixture)).toHaveLength(expected);
  });

  it('issues ONE vendor-wide read, not one per product', async () => {
    await create({ contextProductId: PRIMARY });
    expect(api.getIntegrations).toHaveBeenCalledTimes(1);
  });
});
