/**
 * The Free plan portal pieces (AECI-1218, `docs/STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §6.18, `docs/STAGE_2_PAID_TIERS_SPEC.md` §13): the plan badge, the checklist
 * card and its rows, "Looks right", the plan-ended banner and the vendor plan
 * summary. The product plan panel has its own spec.
 *
 * `.component.spec.ts` so it runs under `ng test` (TestBed DI).
 */
import { provideHttpClient } from '@angular/common/http';
import { HttpErrorResponse } from '@angular/common/http';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { VendorEntitlementBlock, VendorProduct } from '@aeci/shared';

import { productChecklistRows, vendorChecklistRows } from '../checklist-rows';
import { VendorPortalAnnouncer } from '../vendor-announcer';
import { VendorApi } from '../vendor-api';
import {
  CHECKLIST_MIXED_STATE,
  NOTHING_CHECKED,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_FREE_FIXTURE,
  VENDOR_ME_MIXED_FIXTURE,
  VENDOR_ME_PILOT_ENDED_FIXTURE,
  productChecklistFixture,
  vendorChecklistFixture,
  type ChecklistFixtureState,
} from '../vendor-fixtures';
import { VendorPortalStore } from '../vendor-portal-store';

import { VendorChecklist } from './vendor-checklist';
import { VendorLooksRight } from './vendor-looks-right';
import { VendorPlanBadge } from './vendor-plan-badge';
import { VendorPlanEndedBanner } from './vendor-plan-ended-banner';

const flush = () => new Promise<void>((resolve) => setTimeout(resolve));
const textOf = (f: ComponentFixture<unknown>) =>
  ((f.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ').trim();

const MANAGED: VendorEntitlementBlock = VENDOR_ME_FIXTURE.entitlement;
const FREE: VendorEntitlementBlock = VENDOR_ME_FREE_FIXTURE.entitlement;
const PRIMARY = VENDOR_ME_FIXTURE.products[0]!;

function onPlan(product: VendorProduct, plan: VendorEntitlementBlock): VendorProduct {
  return { ...product, plan };
}

let api: {
  reviewProfile: ReturnType<typeof vi.fn>;
  reviewProduct: ReturnType<typeof vi.fn>;
  reviewProductIntegrations: ReturnType<typeof vi.fn>;
  getMe: ReturnType<typeof vi.fn>;
  getIntegrations: ReturnType<typeof vi.fn>;
  getChecklist: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  api = {
    reviewProfile: vi.fn().mockResolvedValue({ last_reviewed_at: '2026-10-02T00:00:00.000Z' }),
    reviewProduct: vi.fn().mockResolvedValue({
      product_id: PRIMARY.id,
      last_reviewed_at: '2026-10-02T00:00:00.000Z',
    }),
    reviewProductIntegrations: vi.fn().mockResolvedValue({
      product_id: PRIMARY.id,
      integrations_reviewed_at: '2026-10-02T00:00:00.000Z',
      stamped_count: 0,
    }),
    getMe: vi.fn().mockResolvedValue(VENDOR_ME_FIXTURE),
    getIntegrations: vi.fn().mockResolvedValue({ integrations: [] }),
    getChecklist: vi
      .fn()
      .mockResolvedValue(vendorChecklistFixture(VENDOR_ME_FIXTURE, NOTHING_CHECKED)),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideRouter([]),
      { provide: VendorApi, useValue: api as Partial<VendorApi> },
      VendorPortalStore,
      VendorPortalAnnouncer,
    ],
  });
});

// ── The plan badge ──────────────────────────────────────────────────────────

describe('VendorPlanBadge', () => {
  function badge(plan: VendorEntitlementBlock): string {
    const f = TestBed.createComponent(VendorPlanBadge);
    f.componentRef.setInput('plan', plan);
    f.detectChanges();
    return textOf(f);
  }

  it('names Managed for an active known tier and Free for no row', () => {
    expect(badge(MANAGED)).toBe('Managed');
    expect(badge(FREE)).toBe('Free');
  });

  it('names Free for a plan that ended, and for a pending one', () => {
    expect(badge(VENDOR_ME_PILOT_ENDED_FIXTURE.entitlement)).toBe('Free');
    expect(badge({ ...FREE, status: 'pending' })).toBe('Free');
  });

  it('fails closed: active over an unknown tier is Free', () => {
    expect(badge({ ...MANAGED, tier: 'unclaimed' })).toBe('Free');
  });
});

// ── The checklist ───────────────────────────────────────────────────────────

describe('VendorChecklist with product rows', () => {
  function render(product: VendorProduct, state: ChecklistFixtureState = NOTHING_CHECKED) {
    const checklist = productChecklistFixture(product, state);
    const f = TestBed.createComponent(VendorChecklist);
    f.componentRef.setInput('heading', 'Product checklist');
    f.componentRef.setInput('headingId', 'h');
    f.componentRef.setInput('rows', productChecklistRows(checklist, product));
    f.componentRef.setInput('done', checklist.done);
    f.componentRef.setInput('total', checklist.total);
    f.detectChanges();
    return f;
  }
  const step = (f: ComponentFixture<VendorChecklist>, key: string) =>
    (f.nativeElement as HTMLElement).querySelector(`[data-step="${key}"]`) as HTMLElement;
  const score = (f: ComponentFixture<VendorChecklist>) =>
    (f.nativeElement as HTMLElement)
      .querySelector('[data-testid="checklist-score"]')
      ?.textContent?.trim();

  it('a finished Free product reads 3 of 3, with data flows optional (decision 6)', () => {
    const done: ChecklistFixtureState = {
      ...NOTHING_CHECKED,
      products: { [PRIMARY.id]: { details: true, list: true, claims: true, flows: false } },
    };
    const f = render(onPlan(PRIMARY, FREE), done);
    expect(score(f)).toBe('3 of 3 done');
    const flows = step(f, 'confirm_data_flows');
    expect(flows.textContent).toContain('Optional');
    expect(flows.textContent).toContain('Available on Managed');
    // The lock replaces the number, and the step is said to be optional.
    expect(flows.textContent).toContain('Not done, optional');
  });

  it('a Managed product reads x of 4, and data flows count', () => {
    const partial: ChecklistFixtureState = {
      ...NOTHING_CHECKED,
      products: { [PRIMARY.id]: { details: true, list: false, claims: true, flows: false } },
    };
    const f = render(onPlan(PRIMARY, MANAGED), partial);
    expect(score(f)).toBe('2 of 4 done');
    const flows = step(f, 'confirm_data_flows');
    expect(flows.textContent).not.toContain('Optional');
    expect(flows.querySelector('a')?.textContent?.trim()).toBe('Confirm data flows');
  });

  it('offers Looks right on product details and the integration list', () => {
    const f = render(onPlan(PRIMARY, FREE));
    expect(step(f, 'product_details').querySelector('aec-vendor-looks-right')).not.toBeNull();
    expect(step(f, 'integration_list').querySelector('aec-vendor-looks-right')).not.toBeNull();
    expect(step(f, 'claim_integrations').querySelector('aec-vendor-looks-right')).toBeNull();
  });

  it('marks a done step for a screen reader, not by colour alone', () => {
    const done: ChecklistFixtureState = {
      ...NOTHING_CHECKED,
      products: { [PRIMARY.id]: { details: true, list: false, claims: false, flows: false } },
    };
    const f = render(onPlan(PRIMARY, FREE), done);
    expect(step(f, 'product_details').querySelector('.sr-only')?.textContent).toBe('Done');
    expect(step(f, 'integration_list').querySelector('.sr-only')?.textContent).toBe('Not done');
  });
});

describe('VendorChecklist with vendor rows', () => {
  it('marks Invite a colleague optional and counts only the two other steps', () => {
    const checklist = vendorChecklistFixture(VENDOR_ME_FIXTURE, NOTHING_CHECKED);
    const f = TestBed.createComponent(VendorChecklist);
    f.componentRef.setInput('heading', 'Getting started');
    f.componentRef.setInput('headingId', 'h');
    f.componentRef.setInput('rows', vendorChecklistRows(checklist));
    f.componentRef.setInput('done', checklist.done);
    f.componentRef.setInput('total', checklist.total);
    f.detectChanges();
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="checklist-score"]')?.textContent?.trim()).toBe(
      '0 of 2 done',
    );
    expect(el.querySelector('[data-step="invite_colleague"]')?.textContent).toContain('Optional');
    expect(el.querySelector('[data-step="company_details"]')?.textContent).not.toContain(
      'Optional',
    );
    expect(el.querySelector('[data-step="finish_products"]')?.textContent).toContain(
      '0 of 2 product checklists done.',
    );
  });

  it('scores a mixed catalog per product plan: Free out of 3, Managed out of 4', () => {
    const checklist = vendorChecklistFixture(VENDOR_ME_MIXED_FIXTURE, CHECKLIST_MIXED_STATE);
    const totals = new Set(checklist.products.map((p) => `${p.plan.tier}:${p.total}`));
    expect(totals).toEqual(new Set(['verified:4', 'unclaimed:3']));
  });
});

// ── "Looks right" ───────────────────────────────────────────────────────────

describe('VendorLooksRight', () => {
  function create(target: 'profile' | 'product' | 'integrations') {
    const f = TestBed.createComponent(VendorLooksRight);
    f.componentRef.setInput('target', target);
    f.componentRef.setInput('productId', target === 'profile' ? null : PRIMARY.id);
    f.componentRef.setInput('productName', PRIMARY.name);
    f.detectChanges();
    return f;
  }
  const button = (f: ComponentFixture<VendorLooksRight>) =>
    (f.nativeElement as HTMLElement).querySelector('button') as HTMLButtonElement;

  it.each([
    ['profile', 'reviewProfile', 'Company details marked as checked.', ['profile']],
    ['product', 'reviewProduct', `${PRIMARY.name} details marked as checked.`, ['products']],
    [
      'integrations',
      'reviewProductIntegrations',
      `${PRIMARY.name} integration list marked as checked.`,
      ['products', 'integrations'],
    ],
  ] as const)(
    '%s: calls its route, refetches me and the checklists, and announces',
    async (target, method, message, scopes) => {
      const store = TestBed.inject(VendorPortalStore);
      const revalidate = vi.spyOn(store, 'revalidate');
      const f = create(target);

      button(f).click();
      await flush();
      f.detectChanges();

      const call = api[method];
      expect(call).toHaveBeenCalledTimes(1);
      if (target !== 'profile') expect(call).toHaveBeenCalledWith(PRIMARY.id);
      expect(revalidate).toHaveBeenCalledWith([...scopes]);
      expect(TestBed.inject(VendorPortalAnnouncer).message().trim()).toBe(message);
      expect(
        (f.nativeElement as HTMLElement).querySelector('[data-testid="looks-right-done"]'),
      ).not.toBeNull();
    },
  );

  it('shows a retryable error beside the button and announces nothing on failure', async () => {
    api.reviewProduct.mockRejectedValue(new HttpErrorResponse({ status: 500 }));
    const f = create('product');

    button(f).click();
    await flush();
    f.detectChanges();

    const alert = (f.nativeElement as HTMLElement).querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('This could not be saved. Please try again.');
    expect(button(f).getAttribute('aria-describedby')).toBe(alert?.id);
    expect(button(f).disabled).toBe(false);
    expect(TestBed.inject(VendorPortalAnnouncer).message()).toBe('');
    expect(
      (f.nativeElement as HTMLElement).querySelector('[data-testid="looks-right-done"]'),
    ).toBeNull();
  });

  it('says to wait on a 429', async () => {
    api.reviewProfile.mockRejectedValue(new HttpErrorResponse({ status: 429 }));
    const f = create('profile');
    button(f).click();
    await flush();
    f.detectChanges();
    expect(textOf(f)).toContain('Wait a minute and try again');
  });
});

// ── The plan-ended banner (§13.11) ──────────────────────────────────────────

describe('VendorPlanEndedBanner', () => {
  function create(entitlement: VendorEntitlementBlock) {
    const f = TestBed.createComponent(VendorPlanEndedBanner);
    f.componentRef.setInput('entitlement', entitlement);
    f.detectChanges();
    return f;
  }
  const banner = (f: ComponentFixture<VendorPlanEndedBanner>) =>
    (f.nativeElement as HTMLElement).querySelector('[data-testid="plan-ended-banner"]');

  it.each(['expired', 'revoked'] as const)('shows for %s, with the end date', (status) => {
    const f = create({
      ...VENDOR_ME_PILOT_ENDED_FIXTURE.entitlement,
      status,
      ended_at: '2026-09-18T10:00:00.000Z',
    });
    expect(banner(f)).not.toBeNull();
    expect(textOf(f)).toContain('It ended on September 18, 2026.');
    expect(textOf(f)).toContain('Nothing you entered was removed.');
    expect(textOf(f)).toContain('Still works');
    expect(textOf(f)).toContain('Now read-only');
  });

  it('never shows for a vendor with no plan row (status null)', () => {
    expect(banner(create(FREE))).toBeNull();
  });

  it('does not show for an active or a pending plan', () => {
    expect(banner(create(MANAGED))).toBeNull();
    expect(banner(create({ ...FREE, status: 'pending' }))).toBeNull();
  });

  it('is not dismissible and not an alert', () => {
    const f = create(VENDOR_ME_PILOT_ENDED_FIXTURE.entitlement);
    expect(banner(f)?.querySelector('button')).toBeNull();
    expect(banner(f)?.getAttribute('role')).toBeNull();
    expect((f.nativeElement as HTMLElement).querySelector('[role="alert"]')).toBeNull();
  });

  // AECI-1264 (marketing review B1): the plan never switched a public label.
  it('lists no public account label among the things that went read-only', () => {
    const f = create(VENDOR_ME_PILOT_ENDED_FIXTURE.entitlement);
    expect(textOf(f)).not.toMatch(/Active on AEC Integrations|account label/i);
  });

  it('still reads without an ended_at', () => {
    const f = create({ ...VENDOR_ME_PILOT_ENDED_FIXTURE.entitlement, ended_at: null });
    expect(textOf(f)).toContain('Your products are now on the Free plan.');
  });
});
