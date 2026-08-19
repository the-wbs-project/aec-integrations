/**
 * `VendorPlanPanel` (AECI-614 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §8) — the
 * vendor-facing entitlement surface.
 *
 * Named `.component.spec.ts` so it runs under `ng test`: the panel injects
 * `LOCALE_ID` and renders a `routerLink`, so it needs `TestBed` DI, and the plain
 * vitest lane deliberately excludes this suffix.
 *
 * These specs pin the things §8 actually decides, rather than the markup:
 *
 *  1. the THREE states each render, and each renders the right one;
 *  2. `status: null` and `status: 'revoked'` are DIFFERENT panels — the spec is
 *     explicit that never-arranged and lost-it are different conversations, and
 *     a `?? 'lapsed'` collapse would silently pass a smoke test;
 *  3. the downgraded panel offers a renewal path and does not read as an error;
 *  4. the copy discipline: no arrangement/pricing detail, no ranking claim, no
 *     instant-search promise — asserted as a scan over the rendered text, so a
 *     future copy edit that reintroduces one fails here;
 *  5. the fail-closed resolution `tierFor` uses: `status: 'active'` over a tier
 *     this build does not know must NOT render as verified.
 */
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import type { VendorEntitlementBlock } from '@aeci/shared';

import {
  VENDOR_ME_DOWNGRADED_FIXTURE,
  VENDOR_ME_EXPIRING_FIXTURE,
  VENDOR_ME_FIXTURE,
  VENDOR_ME_UNVERIFIED_FIXTURE,
} from '../vendor-fixtures';

import { VendorPlanPanel } from './vendor-plan-panel';

const DAY_MS = 86_400_000;
/** A fixed clock, so "expires in N days" is arithmetic and not a race. */
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection(), provideRouter([])],
  });
});

function create(entitlement: VendorEntitlementBlock, now = NOW): ComponentFixture<VendorPlanPanel> {
  const fixture = TestBed.createComponent(VendorPlanPanel);
  fixture.componentRef.setInput('entitlement', entitlement);
  fixture.componentRef.setInput('now', now);
  fixture.detectChanges();
  return fixture;
}

const el = (f: ComponentFixture<VendorPlanPanel>) => f.nativeElement as HTMLElement;
const text = (f: ComponentFixture<VendorPlanPanel>) =>
  (el(f).textContent ?? '').replace(/\s+/g, ' ').trim();
const renewLink = (f: ComponentFixture<VendorPlanPanel>) =>
  el(f).querySelector<HTMLAnchorElement>('a[href="/contact"]');

/** An active entitlement whose term ends `days` from the frozen clock. */
function activeIn(days: number): VendorEntitlementBlock {
  return {
    tier: 'verified',
    status: 'active',
    period_end: new Date(NOW + days * DAY_MS).toISOString(),
    // Read off the shipped fixture rather than re-deriving the ladder here, so
    // the spec cannot drift from what the API actually sends.
    capabilities: VENDOR_ME_FIXTURE.entitlement.capabilities,
  };
}

describe('VendorPlanPanel — state 1: active, far term', () => {
  it('is quiet: the public badge, the term, and no call to action', () => {
    const fixture = create(activeIn(300));

    expect(el(fixture).querySelector('aec-verified-badge')).not.toBeNull();
    expect(text(fixture)).toContain('Verified through');
    // Nothing shouty: no renewal CTA, and no countdown.
    expect(renewLink(fixture)).toBeNull();
    expect(text(fixture)).not.toContain('ends in');
  });

  it('handles a perpetual term (the §2.4 backfilled rows) without inventing a date', () => {
    const fixture = create({ ...activeIn(300), period_end: null });

    expect(el(fixture).querySelector('aec-verified-badge')).not.toBeNull();
    expect(text(fixture)).toContain('No end date on record');
  });

  it('renders from the shipped fixture the dashboard specs use', () => {
    const fixture = create(VENDOR_ME_FIXTURE.entitlement);
    expect(el(fixture).querySelector('aec-verified-badge')).not.toBeNull();
    expect(renewLink(fixture)).toBeNull();
  });
});

describe('VendorPlanPanel — state 2: active, expiring soon', () => {
  it('counts the days down and offers a renewal path', () => {
    const fixture = create(activeIn(12));

    expect(text(fixture)).toContain('Your verification ends in 12 days');
    expect(renewLink(fixture)?.textContent?.trim()).toBe('Renew verification');
  });

  it('still shows the badge: warning is not lapsing (§7.3)', () => {
    const fixture = create(activeIn(3));
    expect(el(fixture).querySelector('aec-verified-badge')).not.toBeNull();
    expect(text(fixture)).toContain('Nothing changes before then');
  });

  it('says "1 day", not "1 days"', () => {
    // Half a day out, so the ceil lands on exactly one.
    const fixture = create(activeIn(0.5));
    expect(text(fixture)).toContain('ends in 1 day.');
    expect(text(fixture)).not.toContain('1 days');
  });

  it('says "today" rather than "in 0 days" on the last day', () => {
    const fixture = create(activeIn(-0.5));
    expect(text(fixture)).toContain('Your verification ends today');
  });

  it('renders from the shipped expiring fixture', () => {
    // The fixture is relative to real load time, so let it use the real clock.
    const fixture = TestBed.createComponent(VendorPlanPanel);
    fixture.componentRef.setInput('entitlement', VENDOR_ME_EXPIRING_FIXTURE.entitlement);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain(
      'Your verification ends in',
    );
  });
});

describe('VendorPlanPanel — state 3: downgraded', () => {
  const REVOKED = VENDOR_ME_DOWNGRADED_FIXTURE.entitlement;
  const NEVER = VENDOR_ME_UNVERIFIED_FIXTURE.entitlement;

  it('drops the badge and leads with what the vendor KEEPS', () => {
    const fixture = create(REVOKED);

    expect(el(fixture).querySelector('aec-verified-badge')).toBeNull();
    const body = text(fixture);
    expect(body).toContain('You are still signed in');
    expect(body).toContain('stay published');
    expect(body).toContain('here to read');
  });

  it('names the one thing that is paused, and how to undo it', () => {
    const fixture = create(REVOKED);

    expect(text(fixture)).toContain('What is paused: the verified badge');
    expect(renewLink(fixture)?.textContent?.trim()).toBe('Renew verification');
  });

  it('does not read as an error: no alert role, no error token', () => {
    const fixture = create(REVOKED);
    const host = el(fixture);

    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.innerHTML).not.toContain('--status-error');
    expect(text(fixture)).not.toMatch(/error|problem|failed|sorry|denied|suspend/i);
  });

  it('shows the term that ended, so the vendor can date it', () => {
    const fixture = create({ ...REVOKED, period_end: '2026-07-05T00:00:00.000Z' });
    expect(text(fixture)).toContain('Ended July 5, 2026');
  });

  it('tells a NEVER-arranged vendor something different from a revoked one', () => {
    const never = text(create(NEVER));
    const revoked = text(create(REVOKED));

    expect(never).toContain('not verified yet');
    expect(never).toContain('Ask about verification');
    // The lapsed reassurance is about something you lost. Don't say it to someone
    // who never had it.
    expect(never).not.toContain('no longer active');
    expect(revoked).toContain('no longer active');
    expect(revoked).not.toContain('not verified yet');
  });

  it('treats a PENDING arrangement as its own state, not as lapsed', () => {
    const fixture = create({
      tier: 'verified',
      status: 'pending',
      period_end: null,
      capabilities: [],
    });
    expect(text(fixture)).toContain('Verification pending');
    expect(text(fixture)).toContain('switches on shortly');
  });

  it('fails CLOSED: an active row on a tier this build does not know is downgraded', () => {
    // `vendor_entitlements.tier` is deliberately unconstrained at the DB layer
    // (§2.2), so this row is reachable. `tierFor` resolves it to `unclaimed`, the
    // capability list is empty, and the forms go read-only — so a panel that said
    // "Verified" would be lying about a surface the vendor can see is locked.
    const fixture = create({
      tier: 'unclaimed',
      status: 'active',
      period_end: null,
      capabilities: [],
    });

    expect(el(fixture).querySelector('aec-verified-badge')).toBeNull();
    expect(text(fixture)).toContain('Verification ended');
  });
});

describe('VendorPlanPanel — copy discipline (§8, a trust surface)', () => {
  const ALL: ReadonlyArray<[string, VendorEntitlementBlock]> = [
    ['active', activeIn(300)],
    ['expiring', activeIn(12)],
    ['pending', { tier: 'verified', status: 'pending', period_end: null, capabilities: [] }],
    ['revoked', VENDOR_ME_DOWNGRADED_FIXTURE.entitlement],
    ['never', VENDOR_ME_UNVERIFIED_FIXTURE.entitlement],
  ];

  it.each(ALL)('says verification is an account status, not an endorsement (%s)', (_name, e) => {
    const body = text(create(e));
    expect(body).toContain('It is an account status, not an endorsement');
    expect(body).toContain('does not affect search ranking or placement');
  });

  it.each(ALL)('leaks no arrangement or pricing detail (%s)', (_name, e) => {
    // Amount, terms, payer, PO number are admin-side only (§5.1). The panel shows
    // status and term, never the money.
    expect(text(create(e))).not.toMatch(
      /\$|USD|EUR|price|pricing|invoice|purchase order|\bPO\b|payment|billing|per year|\/yr|subscription|plan tier|upgrade to/i,
    );
  });

  it.each(ALL)('promises nothing about search freshness (%s)', (_name, e) => {
    // Vendor edits reach Algolia on the nightly watermark (≤24h), so no state may
    // imply an immediate search effect (§8.3(5)).
    expect(text(create(e))).not.toMatch(/immediately|right away|instantly|search results now/i);
  });
});
