/**
 * `VendorPlanPanel`: one product's plan panel (AECI-1218,
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18, `docs/STAGE_2_PAID_TIERS_SPEC.md`
 * §13). It replaced the AECI-614 vendor-level panel, whose states it keeps.
 *
 * Named `.component.spec.ts` so it runs under `ng test` (TestBed DI for
 * `LOCALE_ID` and `routerLink`).
 *
 * Pinned here:
 *  1. each state renders, and the right one: Managed, expiring, overdue,
 *     pending, ended, Free, and the connector catalogue seat. "Ends today" only
 *     on the end day itself (AECI-1408);
 *  2. `status: null` and `status: 'revoked'` are different panels (never had a
 *     plan vs. a plan that ended);
 *  3. decision 10's line, word for word, in every state;
 *  4. Managed's two list prices on every state that offers Managed, and none on
 *     the catalogue seat (decision 9). No "Draft price" label. The per-vendor
 *     override is retired (AECI-1357);
 *  5. fail closed: `active` over an unknown tier is not Managed;
 *  6. copy discipline: no arrangement detail, no ranking claim, no instant search,
 *     and no public account label (AECI-1264).
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorEntitlementBlock } from '@aeci/shared';
import { capabilitiesFor } from '@aeci/shared/entitlements';

import { VendorPlanPanel } from './vendor-plan-panel';
import { expectVendorDocsLink } from './vendor-docs-link.testing';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-02T12:00:00.000Z');
// Reworded by AECI-1265 (marketing review B2): "or what we verify" is gone.
const DECISION_10 = 'No plan changes where you rank or appear, or whether a review is published.';
const PRICE_LINE = 'Managed is $25 a month or $250 a year per product.';

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
});

const BILLING = '/vendor/summit-bim/billing';

function create(
  plan: VendorEntitlementBlock,
  productRole: string | null = 'product',
  billingLink: string | null = null,
): ComponentFixture<VendorPlanPanel> {
  const fixture = TestBed.createComponent(VendorPlanPanel);
  fixture.componentRef.setInput('plan', plan);
  fixture.componentRef.setInput('productRole', productRole);
  fixture.componentRef.setInput('billingLink', billingLink);
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
const getLicenses = (f: ComponentFixture<VendorPlanPanel>) =>
  el(f).querySelector<HTMLAnchorElement>('[data-testid="plan-get-licenses"]');

const MANAGED_CAPS = [...capabilitiesFor('verified')];
const FREE_CAPS = [...capabilitiesFor('unclaimed')];

function managedIn(days: number | null): VendorEntitlementBlock {
  return {
    tier: 'verified',
    status: 'active',
    period_end: days === null ? null : new Date(NOW + days * DAY_MS).toISOString(),
    ended_at: null,
    capabilities: MANAGED_CAPS,
  };
}
/** A live Managed block whose term ends at exactly `iso`. */
function endsOn(iso: string): VendorEntitlementBlock {
  return { ...managedIn(0), period_end: iso };
}
const FREE: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: null,
  period_end: null,
  ended_at: null,
  capabilities: FREE_CAPS,
};
const ENDED: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: 'revoked',
  period_end: '2026-09-18T00:00:00.000Z',
  ended_at: '2026-09-18T00:00:00.000Z',
  capabilities: FREE_CAPS,
};
const PENDING: VendorEntitlementBlock = {
  tier: 'unclaimed',
  status: 'pending',
  period_end: null,
  ended_at: null,
  capabilities: FREE_CAPS,
};

const ALL: ReadonlyArray<[string, VendorEntitlementBlock, string | null]> = [
  ['managed', managedIn(300), 'product'],
  ['expiring', managedIn(12), 'product'],
  ['overdue', managedIn(-1), 'product'],
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

  it('expiring: states the date and counts the days, with a renewal path, still Managed', () => {
    const f = create(managedIn(12));
    expect(state(f)).toBe('expiring');
    expect(text(f)).toContain('Managed ends on October 14, 2026 for this product, in 12 days.');
    expect(text(f)).toContain('Nothing changes before then');
    expect(cta(f)?.textContent?.trim()).toBe('Renew Managed');
  });

  it('expiring: an end date 30 days out is inside the window and dated', () => {
    const f = create(managedIn(30));
    expect(state(f)).toBe('expiring');
    expect(text(f)).toContain('Managed ends on November 1, 2026 for this product, in 30 days.');
  });

  it('expiring: "1 day" and "today", never "1 days" or "in 0 days"', () => {
    expect(text(create(managedIn(1)))).toContain('for this product, in 1 day.');
    expect(text(create(managedIn(0)))).toContain(
      'Managed ends today, October 2, 2026, for this product.',
    );
  });

  // AECI-1408: the "ends today" bug. The end day is a UTC calendar day, so a term
  // that ended at 00:00Z today still reads "today", and only today.
  it('end date today: "ends today", even after midnight UTC has passed', () => {
    const f = create(endsOn('2026-10-02T00:00:00.000Z'));
    expect(state(f)).toBe('expiring');
    expect(text(f)).toContain('Managed ends today, October 2, 2026, for this product.');
  });

  it('end date in the past: "ended on {date}", never "ends today"', () => {
    for (const end of ['2026-10-01T00:00:00.000Z', '2026-09-20T00:00:00.000Z']) {
      const f = create(endsOn(end));
      expect(state(f)).toBe('overdue');
      expect(text(f)).not.toContain('ends today');
      expect(text(f)).toContain('The change is on its way.');
    }
    expect(text(create(endsOn('2026-10-01T00:00:00.000Z')))).toContain(
      'Managed ended on October 1, 2026. The change is on its way.',
    );
  });

  it('overdue: still Managed until the job runs, with the ended call to action', () => {
    const f = create(managedIn(-1));
    expect(el(f).querySelector('aec-vendor-plan-badge')?.textContent?.trim()).toBe('Managed');
    expect(text(f)).toContain('Managed covers');
    expect(cta(f)?.textContent?.trim()).toBe('Ask about Managed for this product');
    expect(getLicenses(create(managedIn(-1), 'product', BILLING))?.getAttribute('href')).toBe(
      BILLING,
    );
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
    expect(getLicenses(f)).toBeNull();
  });

  // AECI-1408 ruling 4: an owner gets licenses on the Billing tab.
  it('ended: an owner is sent to Billing to get licenses, in place of the contact path', () => {
    const f = create(ENDED, 'product', BILLING);
    expect(getLicenses(f)?.textContent?.trim()).toBe('Get licenses');
    expect(getLicenses(f)?.getAttribute('href')).toBe(BILLING);
    expect(cta(f)).toBeNull();
  });

  it('a Billing link changes nothing on the Free and expiring states', () => {
    expect(getLicenses(create(FREE, 'product', BILLING))).toBeNull();
    expect(getLicenses(create(managedIn(12), 'product', BILLING))).toBeNull();
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
    expect(text(f)).toContain('This seat maintains your connector catalog');
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
    "shows Managed's two list prices, with no draft label (%s)",
    (_name, plan, role) => {
      const f = create(plan, role);
      const price = el(f).querySelector('[data-testid="plan-price"]');
      expect(price?.textContent?.trim()).toBe(PRICE_LINE);
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

  // AECI-1264 (marketing review B1): no plan turns a public label on or off.
  // The panel names the plan in words, through its own badge and lede.
  it.each(ALL)('names no public account label (%s)', (_name, plan, role) => {
    const f = create(plan, role);
    expect(text(f)).not.toMatch(/Active on AEC Integrations|account label|public label/i);
    expect(el(f).querySelector('aec-vendor-account-badge')).toBeNull();
    expect(el(f).querySelector('aec-vendor-plan-badge')?.textContent?.trim()).toMatch(
      /^(Free|Managed)$/,
    );
  });

  it.each(ALL)('is not an error surface (%s)', (_name, plan, role) => {
    const f = create(plan, role);
    expect(el(f).querySelector('[role="alert"]')).toBeNull();
    expect(el(f).innerHTML).not.toContain('--status-error');
  });
});

// AECI-1357 (E1.8): the per-vendor override is retired (VENDOR_SIGNUP_PROCESS.md §2
// decision 8). Every vendor reads the same two list prices.
describe('VendorPlanPanel: the price line', () => {
  it('catalogue: shows no price', () => {
    const f = create(FREE, 'connector');
    expect(state(f)).toBe('catalogue');
    expect(el(f).querySelector('[data-testid="plan-price"]')).toBeNull();
    expect(text(f)).not.toContain('$25');
  });

  it('reads the list prices, not the block: a stale price field is ignored', () => {
    const stale = { ...FREE, price: { managed_price_cents: 1250, message: 'Half price' } };
    const f = create(stale as VendorEntitlementBlock);
    expect(el(f).querySelector('[data-testid="plan-price"]')?.textContent?.trim()).toBe(PRICE_LINE);
    expect(text(f)).not.toContain('Half price');
  });
});

describe('VendorPlanPanel: the guide link (AECI-1253)', () => {
  it('links the Plans page in a new tab', () => {
    expectVendorDocsLink(el(create(managedIn(300))), 'plans');
  });
});
