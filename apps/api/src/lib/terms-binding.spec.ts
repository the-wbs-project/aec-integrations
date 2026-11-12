/**
 * AECI-1690: which Managed plan agreement version a charge binds. One test per row of the
 * rules table (`docs/adr/0047-stripe-billing-no-sdk-webhook-owned-licenses.md` decision 9),
 * time stepped across the 12:00 UTC effective moment and the 45-day notice line, then the
 * loader's reads on the real migrations, then the guard that the terms path never touches
 * a Stripe subscription.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_IN_FORCE_MAPS,
  legalEffectiveAtMs,
  type LegalInForceMaps,
} from '@aeci/shared';
import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import { agreementAcceptances, billingAccounts, legalVersions, vendors } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  announcedForRenewal,
  bindTermsVersion,
  firstUncoveredVersion,
  loadTermsBinding,
  RENEWAL_NOTICE_DAYS,
  type TermsAcceptedRow,
  type TermsBindingInput,
  type TermsPublishedRow,
} from './terms-binding';

const MS = 1;
const DAY = 86_400_000;
const LONG_AGO = '2026-01-01T00:00:00.000Z';

/** In-force maps with `current` as the build version and an optional upcoming one. */
function maps(current: string, upcoming?: { version: string; effectiveOn: string }) {
  return {
    ...LEGAL_IN_FORCE_MAPS,
    agreementCurrent: { ...LEGAL_IN_FORCE_MAPS.agreementCurrent, managed_plan: current },
    agreementUpcoming: upcoming ? { managed_plan: upcoming } : {},
  } satisfies LegalInForceMaps;
}

function row(
  version: string,
  effectiveOn: string,
  requiresAcceptance: boolean,
  publishedAt = LONG_AGO,
): TermsPublishedRow {
  return {
    document: 'managed_plan',
    version,
    effectiveAt: legalEffectiveAtMs(effectiveOn),
    requiresAcceptance,
    summaryJson: '[]',
    publishedAt,
  };
}

const accepted = (version: string, acceptedAt = LONG_AGO): TermsAcceptedRow[] => [
  { document: 'managed_plan', version, acceptedAt },
];

const MOMENT = legalEffectiveAtMs('2027-03-01');
const BEFORE = MOMENT - MS;

function bind(over: Partial<TermsBindingInput> & Pick<TermsBindingInput, 'maps'>) {
  return bindTermsVersion({
    interval: 'month',
    renewalAtMs: MOMENT,
    boundVersion: '1.2',
    published: [],
    accepted: [],
    ...over,
  });
}

describe('the rules table (AECI-1690)', () => {
  const upcoming13 = maps('1.2', { version: '1.3', effectiveOn: '2027-03-01' });

  it('annual: binds the version in force at the renewal moment, whatever the flag', () => {
    const published = [row('1.3', '2027-03-01', true)];
    expect(bind({ maps: upcoming13, interval: 'year', published, renewalAtMs: BEFORE })).toEqual({
      version: '1.2',
      withheld: null,
      unannounced: null,
    });
    expect(bind({ maps: upcoming13, interval: 'year', published })).toEqual({
      version: '1.3',
      withheld: null,
      unannounced: null,
    });
  });

  it('annual: an upcoming version with no published row never binds', () => {
    expect(bind({ maps: upcoming13, interval: 'year' }).version).toBe('1.2');
  });

  it('annual (D2): published 45 days before the renewal binds, 44 days before does not', () => {
    expect(RENEWAL_NOTICE_DAYS).toBe(EXPIRY_WARNING_DAYS);
    const at = MOMENT + 10 * DAY;
    const iso = (days: number) => new Date(at - days * DAY).toISOString();
    const on45 = [row('1.3', '2027-03-01', false, iso(45))];
    const on44 = [row('1.3', '2027-03-01', false, iso(44))];
    expect(bind({ maps: upcoming13, interval: 'year', published: on45, renewalAtMs: at })).toEqual({
      version: '1.3',
      withheld: null,
      unannounced: null,
    });
    expect(bind({ maps: upcoming13, interval: 'year', published: on44, renewalAtMs: at })).toEqual({
      version: '1.2',
      withheld: null,
      unannounced: '1.3',
    });
    expect(announcedForRenewal('1.3', on45, at)).toBe(true);
    expect(announcedForRenewal('1.3', on44, at)).toBe(false);
    // The 45-day rule is annual only: a monthly charge has its 30-day email.
    expect(bind({ maps: upcoming13, published: on44, renewalAtMs: at }).version).toBe('1.3');
  });

  it('monthly, no requires_acceptance: binds from the first charge at or after the moment', () => {
    const published = [row('1.3', '2027-03-01', false)];
    expect(bind({ maps: upcoming13, published, renewalAtMs: BEFORE }).version).toBe('1.2');
    expect(bind({ maps: upcoming13, published, renewalAtMs: MOMENT })).toEqual({
      version: '1.3',
      withheld: null,
      unannounced: null,
    });
  });

  it('monthly, requires_acceptance and an acceptance of it or a later version: binds it', () => {
    const published = [row('1.3', '2027-03-01', true), row('1.4', '2027-02-01', false)];
    expect(bind({ maps: upcoming13, published, accepted: accepted('1.3') }).version).toBe('1.3');
    // 1.4 is final (it has a row), so its acceptance covers 1.3.
    expect(bind({ maps: upcoming13, published, accepted: accepted('1.4') }).version).toBe('1.3');
  });

  it('monthly, requires_acceptance and no acceptance: the licenses keep their version', () => {
    const published = [row('1.3', '2027-03-01', true)];
    expect(bind({ maps: upcoming13, published })).toEqual({
      version: '1.2',
      withheld: '1.3',
      unannounced: null,
    });
    // An acceptance of an earlier version covers nothing above it.
    expect(bind({ maps: upcoming13, published, accepted: accepted('1.2') }).withheld).toBe('1.3');
  });

  it('monthly (D1): an acceptance recorded after the renewal moment waits for the next charge', () => {
    const published = [row('1.3', '2027-03-01', true)];
    const late = accepted('1.3', new Date(MOMENT + 1000).toISOString());
    expect(bind({ maps: upcoming13, published, accepted: late }).withheld).toBe('1.3');
    expect(
      bind({ maps: upcoming13, published, accepted: late, renewalAtMs: MOMENT + 30 * DAY }).version,
    ).toBe('1.3');
    const atTheMoment = accepted('1.3', new Date(MOMENT).toISOString());
    expect(bind({ maps: upcoming13, published, accepted: atTheMoment }).version).toBe('1.3');
  });

  it('mixed: a later version without the flag never carries an unaccepted change past the click', () => {
    // Bound 1.2. 1.3 is the build version and needs acceptance. 1.4 is upcoming, published
    // without the flag, and in force. Both are in force at the charge.
    const m = maps('1.3', { version: '1.4', effectiveOn: '2027-03-01' });
    const published = [row('1.3', '2027-01-01', true), row('1.4', '2027-03-01', false)];
    const at = MOMENT + DAY;
    expect(bind({ maps: m, published, renewalAtMs: at })).toEqual({
      version: '1.2',
      withheld: '1.3',
      unannounced: null,
    });
    // Once an owner accepts 1.3 (before the charge), the charge binds 1.4.
    expect(bind({ maps: m, published, renewalAtMs: at, accepted: accepted('1.3') }).version).toBe(
      '1.4',
    );
    // Each license walks from its own version: one already on 1.4 stays there, and one on
    // 1.2 stays on 1.2. Neither crosses the unaccepted 1.3.
    expect(bind({ maps: m, published, renewalAtMs: at, boundVersion: '1.4' }).version).toBe('1.4');
  });

  it('mixed: binds the highest version below the first uncovered one', () => {
    // 1.3 needs nothing, 1.4 needs acceptance and has none, 1.5 needs nothing.
    const m = maps('1.4', { version: '1.5', effectiveOn: '2027-03-01' });
    const published = [
      row('1.3', '2026-12-01', false),
      row('1.4', '2027-01-01', true),
      row('1.5', '2027-03-01', false),
    ];
    expect(bind({ maps: m, published }).version).toBe('1.3');
    expect(bind({ maps: m, published }).withheld).toBe('1.4');
    expect(firstUncoveredVersion('1.2', '1.5', published, [], m)).toBe('1.4');
    expect(firstUncoveredVersion('1.4', '1.5', published, [], m)).toBeNull();
  });

  it('compares versions by number: 1.10 is after 1.9', () => {
    const m = maps('1.10');
    const published = [row('1.10', '2027-01-01', false)];
    expect(bind({ maps: m, published, boundVersion: '1.9' }).version).toBe('1.10');
    // Never lower: a license on 1.10 stays there when 1.9 is the one in force.
    expect(bind({ maps: maps('1.9'), boundVersion: '1.10' }).version).toBe('1.10');
    expect(bind({ maps: maps('1.9'), interval: 'year', boundVersion: '1.10' }).version).toBe(
      '1.10',
    );
  });

  it('a draft version in code never needs an acceptance, even with a flagged row', () => {
    // Managed plan 1.1 is `null` in LEGAL_AGREEMENT_EFFECTIVE_ON: a draft for good.
    const published = [row('1.1', '2027-01-01', true)];
    expect(bind({ maps: maps('1.1'), published, boundVersion: '1.0' }).version).toBe('1.1');
  });
});

describe("today's data (AECI-1690)", () => {
  /** A db that fails the test on any read. */
  const noReads = new Proxy(
    {},
    {
      get(_t, prop) {
        throw new Error(`unexpected D1 access: ${String(prop)}`);
      },
    },
  ) as Db;

  it.each([
    ['month', '1.1'],
    ['month', '1.0'],
    ['month', null],
    ['year', '1.1'],
    ['year', '1.0'],
    ['year', null],
  ] as const)('a %s renewal bound %s reads nothing and binds the build version', async (i, b) => {
    const result = await loadTermsBinding(noReads, {
      vendorId: 'v1',
      interval: i,
      renewalAt: new Date('2026-11-12T12:00:00.000Z'),
      boundVersions: [b, '1.1'],
    });
    expect(result.bindFrom(b)).toEqual({
      version: LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan,
      withheld: null,
      unannounced: null,
    });
  });
});

describe('loadTermsBinding on D1 (AECI-1690)', () => {
  let t: TestDb;
  const VENDOR = '11111111-1111-4111-8111-111111111111';
  const m = maps('1.3', { version: '1.4', effectiveOn: '2027-03-01' });
  const at = new Date(MOMENT + DAY);
  const req = {
    vendorId: VENDOR,
    interval: 'month' as const,
    renewalAt: at,
    boundVersions: ['1.2', '1.4'],
    maps: m,
  };

  beforeEach(async () => {
    t = await makeTestDb();
    await t.db.insert(vendors).values({ id: VENDOR, slug: 'acme', companyName: 'Acme' });
    await t.db.insert(billingAccounts).values({ id: 'ba-1', vendorId: VENDOR, name: 'Acme' });
    const pub = (version: string, effectiveOn: string, requiresAcceptance: boolean) => ({
      document: 'managed_plan',
      version,
      effectiveAt: legalEffectiveAtMs(effectiveOn),
      summaryJson: '[]',
      material: true,
      requiresAcceptance,
      pdfKey: `legal/managed-plan-agreement/v${version}.pdf`,
      pdfSha256: '0'.repeat(64),
      pdfBytes: 10,
      publishedBy: 'admin',
      publishedAt: '2026-11-01T00:00:00.000Z',
    });
    await t.db
      .insert(legalVersions)
      .values([pub('1.3', '2027-01-01', true), pub('1.4', '2027-03-01', false)]);
  });
  afterEach(() => t.dispose());

  const acceptAt = (version: string, document: string, acceptedAt: string) =>
    t.db.insert(agreementAcceptances).values({
      id: crypto.randomUUID(),
      document,
      version,
      source: 'portal',
      email: 'owner@acme.example',
      vendorId: VENDOR,
      acceptedAt,
    });

  it('per license: 1.2 stays 1.2 and 1.4 stays 1.4 while 1.3 is unaccepted', async () => {
    const b = await loadTermsBinding(t.db, req);
    expect(b.bindFrom('1.2')).toMatchObject({ version: '1.2', withheld: '1.3' });
    expect(b.bindFrom('1.4')).toMatchObject({ version: '1.4', withheld: null });
  });

  it('an acceptance before the charge binds 1.4; one after it waits (D1)', async () => {
    await acceptAt('1.3', 'managed_plan', new Date(at.getTime() + 1000).toISOString());
    expect((await loadTermsBinding(t.db, req)).bindFrom('1.2').version).toBe('1.2');
    const next = { ...req, renewalAt: new Date(at.getTime() + 30 * DAY) };
    expect((await loadTermsBinding(t.db, next)).bindFrom('1.2').version).toBe('1.4');
  });

  it('an acceptance of the other agreement covers nothing', async () => {
    await acceptAt('1.9', 'vendor_terms', '2027-01-05T00:00:00.000Z');
    expect((await loadTermsBinding(t.db, req)).bindFrom('1.2').withheld).toBe('1.3');
  });

  it('annual binds 1.4 with no acceptance read', async () => {
    const b = await loadTermsBinding(t.db, { ...req, interval: 'year' });
    expect(b.bindFrom('1.2').version).toBe('1.4');
    expect(b.accepted).toEqual([]);
  });
});

describe('no Stripe write on the terms path (AECI-1690)', () => {
  const src = (file: string) => readFileSync(join(process.cwd(), 'src', 'lib', file), 'utf8');

  it('the binding module cannot reach Stripe', () => {
    const code = src('terms-binding.ts');
    expect(code).not.toMatch(/from '\.\/stripe'/);
    expect(code).not.toMatch(/updateSubscription|cancelSubscription|cancel_at_period_end/);
  });

  it('nothing cancels, pauses or marks a subscription for terms', () => {
    for (const file of ['stripe-licenses.ts', 'stripe-reconcile.ts', 'terms-binding.ts']) {
      const code = src(file);
      expect(code, file).not.toMatch(
        /terms-not-accepted|aeci_cancel|termsSweep|cancelled_for_terms/,
      );
    }
  });
});
