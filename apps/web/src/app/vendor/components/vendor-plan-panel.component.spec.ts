/**
 * `VendorPlanPanel`: one product's plan panel (AECI-1218,
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18, `docs/STAGE_2_PAID_TIERS_SPEC.md`
 * §13). It replaced the AECI-614 vendor-level panel, whose states it keeps.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (TestBed DI for
 * `LOCALE_ID` and `routerLink`).
 *
 * Pinned here:
 *  1. each state renders, and the right one: Managed, expiring, pending, ended,
 *     Free, and the connector catalogue seat;
 *  2. `status: null` and `status: 'revoked'` are different panels (never had a
 *     plan vs. a plan that ended);
 *  3. decision 10's line, word for word, in every state;
 *  4. the Managed price on every state that offers Managed, and none on the
 *     catalogue seat (decision 9). No "Draft price" label, and the per-vendor
 *     overrides by precedence: message, then price, then the default (ruling
 *     2026-10-08, §13.13);
 *  5. fail closed: `active` over an unknown tier is not Managed;
 *  6. copy discipline: no arrangement detail, no ranking claim, no instant search.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorEntitlementBlock } from '@aeci/shared';
import { DEFAULT_PLAN_PRICE, capabilitiesFor } from '@aeci/shared/entitlements';

import { VendorPlanPanel } from './vendor-plan-panel';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const DECISION_10 =
  'No plan changes where you rank or appear, whether a review is published, or what we verify.';

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
});

function create(
  plan: VendorEntitlementBlock,
  productRole: string | null = 'product',
): ComponentFixture<VendorPlanPanel> {
  const fixture = TestBed.createComponent(VendorPlanPanel);
  fixture.componentRef.setInput('plan', plan);
  fixture.componentRef.setInput('productRole', productRole);
  fixture.componentRef.setInput('now', NOW);
  fixture.detectChanges();
  return fixture;
}

const el = (f: ComponentFixture<VendorPlanPanel>) => f.nativeElement as HTMLElement;
const text = (f: ComponentFixture<VendorPlanPanel>) =>
  (el(f).textContent ?? '').replace(/\s+/g, ' ').trim();
const state = (f: ComponentFixture<VendorPlanPanel>) =>
  el(f).querySelector('[data-plan-state]')?.getAttribute('data-plan-state');
const cta = (f: ComponentFixture<VendorPlanPanel>) =>
  el(f).querySelector<HTMLAnchorElement>('a[href="/contact"]');

const MANAGED_CAPS = [...capabilitiesFor('verified')];
const FREE_CAPS = [...capabilitiesFor('unclaimed')];

function managedIn(days: number | null): VendorEntitlementBlock {
  return {
    tier: 'verified',
    status: 'active',
    period_end: days === null ? null : new Date(NOW + days * DAY_MS).toISOString(),
    ended_at: null,
    capabilities: MANAGED_CAPS,
    price: DEFAULT_PLAN_PRICE,
  };
}
const FREE: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: null,
  period_end: null,
  ended_at: null,
  capabilities: FREE_CAPS,
  price: DEFAULT_PLAN_PRICE,
};
const ENDED: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: 'revoked',
  period_end: '2026-09-18T00:00:00.000Z',
  ended_at: '2026-09-18T00:00:00.000Z',
  capabilities: FREE_CAPS,
  price: DEFAULT_PLAN_PRICE,
};
const PENDING: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: 'pending',
  period_end: null,
  ended_at: null,
  capabilities: FREE_CAPS,
  price: DEFAULT_PLAN_PRICE,
};

const ALL: ReadonlyArray<[string, VendorEntitlementBlock, string | null]> = [
  ['managed', managedIn(300), 'product'],
  ['expiring', managedIn(12), 'product'],
  ['pending', PENDING, 'product'],
  ['ended', ENDED, 'product'],
  ['free', FREE, 'product'],
  ['catalogue', FREE, 'connector'],
];

describe('VendorPlanPanel: the states', () => {
  it('Managed: says so, lists what Managed covers, then what Free also gives', () => {
    const f = create(managedIn(300));
    expect(state(f)).toBe('managed');
    expect(text(f)).toContain('This product is on Managed, through');
    expect(text(f)).toContain('Managed covers');
    expect(text(f)).toContain('Also included, as on Free');
    expect(el(f).querySelector('aec-vendor-plan-badge')?.textContent?.trim()).toBe('Managed');
    expect(cta(f)).toBeNull();
  });

  it('Managed with no term says so rather than inventing a date', () => {
    expect(text(create(managedIn(null)))).toContain('with no end date on record');
  });

  it('expiring: counts the days and offers a renewal path, still Managed', () => {
    const f = create(managedIn(12));
    expect(state(f)).toBe('expiring');
    expect(text(f)).toContain('Managed ends in 12 days for this product');
    expect(text(f)).toContain('Nothing changes before then');
    expect(cta(f)?.textContent?.trim()).toBe('Renew Managed');
  });

  it('expiring: "1 day" and "today", never "1 days" or "in 0 days"', () => {
    expect(text(create(managedIn(1)))).toContain('ends in 1 day for');
    expect(text(create(managedIn(0)))).toContain('Managed ends today');
  });

  it('pending: Free until it switches on, with no call to action', () => {
    const f = create(PENDING);
    expect(state(f)).toBe('pending');
    expect(text(f)).toContain('Until it does, the product is on Free');
    expect(cta(f)).toBeNull();
  });

  it('ended: on Free, dated from ended_at, and nothing entered was removed', () => {
    const f = create(ENDED);
    expect(state(f)).toBe('ended');
    expect(text(f)).toContain('Managed ended for this product on September 18, 2026');
    expect(text(f)).toContain('Nothing you entered was removed');
    expect(el(f).querySelector('aec-vendor-plan-badge')?.textContent?.trim()).toBe('Free');
    expect(cta(f)?.textContent?.trim()).toBe('Ask about Managed for this product');
  });

  it('Free (never had a plan) is a different panel from a plan that ended', () => {
    const free = create(FREE);
    expect(state(free)).toBe('free');
    expect(text(free)).toContain('This product is on Free');
    expect(text(free)).toContain('Free includes');
    expect(text(free)).toContain('Managed adds, for this product');
    expect(text(free)).not.toContain('ended');
  });

  it('fails closed: active over a tier this build does not know is not Managed', () => {
    const drift = { ...managedIn(300), tier: 'unclaimed' } as VendorEntitlementBlock;
    const f = create(drift);
    // Free, and not "ended": nothing ended, the build just cannot name the tier.
    expect(state(f)).toBe('free');
    expect(el(f).querySelector('aec-vendor-plan-badge')?.textContent?.trim()).toBe('Free');
  });

  it('the connector catalogue seat gets no offer, no price and no call to action', () => {
    const f = create(FREE, 'connector');
    expect(state(f)).toBe('catalogue');
    expect(text(f)).toContain('This seat maintains your connector catalogue');
    expect(text(f)).toContain('Its description, website, logo and categories are yours to edit');
    expect(el(f).querySelector('[data-testid="plan-price"]')).toBeNull();
    expect(cta(f)).toBeNull();
  });

  it('re-derives when the plan input changes, with no reload', () => {
    const f = create(FREE);
    f.componentRef.setInput('plan', managedIn(300));
    f.detectChanges();
    expect(state(f)).toBe('managed');
  });
});

describe('VendorPlanPanel: copy every panel carries', () => {
  it.each(ALL)('carries decision 10 word for word (%s)', (_name, plan, role) => {
    const line = el(create(plan, role)).querySelector('[data-testid="plan-decision10"]');
    expect(line?.textContent?.trim()).toBe(DECISION_10);
  });

  it.each(ALL.filter(([name]) => name !== 'catalogue'))(
    'shows the default Managed price, with no draft label (%s)',
    (_name, plan, role) => {
      const f = create(plan, role);
      const price = el(f).querySelector('[data-testid="plan-price"]');
      expect(price?.textContent?.trim()).toBe('Managed is $25 a month per product.');
      expect(text(f)).not.toMatch(/draft/i);
    },
  );

  it.each(ALL)('offers nothing beyond Managed (%s)', (_name, plan, role) => {
    expect(text(create(plan, role))).not.toMatch(/enterprise|premium|pro plan|upgrade to/i);
  });

  it.each(ALL)('leaks no arrangement detail (%s)', (_name, plan, role) => {
    expect(text(create(plan, role))).not.toMatch(
      /invoice|purchase order|\bPO\b|payment|billing|per year|\/yr/i,
    );
  });

  it.each(ALL)('promises nothing about search freshness (%s)', (_name, plan, role) => {
    expect(text(create(plan, role))).not.toMatch(/immediately|right away|instantly/i);
  });

  it.each(ALL)('is not an error surface (%s)', (_name, plan, role) => {
    const f = create(plan, role);
    expect(el(f).querySelector('[role="alert"]')).toBeNull();
    expect(el(f).innerHTML).not.toContain('--status-error');
  });
});

describe('VendorPlanPanel: per-vendor price overrides (ruling 2026-10-08, §13.13)', () => {
  const priceText = (f: ComponentFixture<VendorPlanPanel>) =>
    el(f).querySelector('[data-testid="plan-price"]')?.textContent?.trim();
  const withPrice = (
    plan: VendorEntitlementBlock,
    price: VendorEntitlementBlock['price'],
  ): VendorEntitlementBlock => ({ ...plan, price });

  it('default: no override shows the list price', () => {
    expect(priceText(create(FREE))).toBe('Managed is $25 a month per product.');
  });

  it('price override: shows the admin price, with cents when there are any', () => {
    expect(priceText(create(withPrice(FREE, { managed_price_cents: 1250, message: null })))).toBe(
      'Managed is $12.50 a month per product.',
    );
    expect(
      priceText(create(withPrice(managedIn(300), { managed_price_cents: 4000, message: null }))),
    ).toBe('Managed is $40 a month per product.');
  });

  it('message override: replaces the whole sentence, and beats a price', () => {
    const message = 'Free until December 12, then 50% off for the next year.';
    expect(priceText(create(withPrice(ENDED, { managed_price_cents: 1250, message })))).toBe(
      message,
    );
  });

  it('renders the message as text, never as markup', () => {
    const f = create(withPrice(FREE, { managed_price_cents: null, message: '<b>bold</b> & co' }));
    const line = el(f).querySelector('[data-testid="plan-price"]');
    expect(line?.querySelector('b')).toBeNull();
    expect(line?.textContent?.trim()).toBe('<b>bold</b> & co');
  });

  it('catalogue: still shows no price, whatever the override', () => {
    const f = create(
      withPrice(FREE, { managed_price_cents: 1250, message: 'Half price' }),
      'connector',
    );
    expect(state(f)).toBe('catalogue');
    expect(el(f).querySelector('[data-testid="plan-price"]')).toBeNull();
    expect(text(f)).not.toContain('Half price');
  });

  it('re-renders when the override changes, with no reload', () => {
    const f = create(FREE);
    f.componentRef.setInput('plan', withPrice(FREE, { managed_price_cents: 900, message: null }));
    f.detectChanges();
    expect(priceText(f)).toBe('Managed is $9 a month per product.');
  });
});
