/**
 * AECI-1689: the version in force at request time, as the API reads it, against the
 * in-memory D1 harness. Source of truth: `STAGE_1_SPEC.md` §27.3, the legal README
 * "The effective date switches by itself".
 *
 * INVARIANTS. None should be deleted without reopening the decision behind it:
 *
 *   1. **Today's data reads nothing and changes nothing.** With the real, empty upcoming
 *      maps no query runs, and every answer is the build's current version.
 *   2. **An unpublished upcoming agreement version never switches**, before, at or long
 *      after its moment: not the stamp, not the gate, not the public read.
 *   3. **A published one switches exactly at its moment**: one millisecond before, the
 *      old version; at the moment, the new one. The stamp, the gate, the claim box and
 *      the public read the web decides from all agree.
 *   4. **The acceptance screen agrees** (`lib/legal-acceptance.ts`, AECI-1677): the
 *      version it finds newest in force is the one a new acceptance stamps.
 */

import {
  LEGAL_AGREEMENT_CURRENT_VERSIONS,
  LEGAL_IN_FORCE_MAPS,
  LEGAL_POLICY_CURRENT_VERSIONS,
  LegalPublishedResponseSchema,
  legalAgreementVersionInForce,
  legalEffectiveAtMs,
  legalPublishedLiteOf,
  type LegalInForceMaps,
} from '@aeci/shared';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client';
import { legalVersions, profiles } from '../db/schema';
import type { Env } from '../env';
import { errorHandler } from '../errors';
import { createLegalPublishedHandler } from '../routes/legal-published';
import { makeTestDb, type TestDb } from '../test/d1';
import { agreementAcceptanceStatements, claimBoxFor } from './agreement-acceptances';
import { inForceVersions } from './legal-acceptance';
import { loadLegalInForce, loadLegalPublishedLite } from './legal-in-force';

const DAY = '2027-03-31';
const MOMENT = legalEffectiveAtMs(DAY);
const BEFORE = new Date(MOMENT - 1);
const AT = new Date(MOMENT);
const LATER = new Date(MOMENT + 90 * 86_400_000);
const ADMIN = '00000000-0000-4000-8000-000000000900';

/** Vendor Terms 1.4 announced for `DAY`; the Listing Accuracy Policy 1.1 too. */
const MAPS: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.3', managed_plan: '1.1' },
  agreementUpcoming: { vendor_terms: { version: '1.4', effectiveOn: DAY } },
  policyCurrent: { listing_accuracy: '1.0', review_guidelines: '1.0' },
  policyUpcoming: { listing_accuracy: { version: '1.1', effectiveOn: DAY } },
};

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
  await t.db.insert(profiles).values({ id: ADMIN, role: 'admin' });
});
afterEach(() => t.dispose());

async function publish(over: Partial<typeof legalVersions.$inferInsert> = {}) {
  await t.db.insert(legalVersions).values({
    document: 'vendor_terms',
    version: '1.4',
    effectiveAt: MOMENT,
    summaryJson: '["A change."]',
    material: true,
    requiresAcceptance: false,
    pdfKey: 'legal/vendor-terms/v1.4.pdf',
    pdfSha256: 'a'.repeat(64),
    pdfBytes: 10,
    publishedBy: ADMIN,
    publishedAt: '2027-02-01T00:00:00.000Z',
    ...over,
  });
}

/** A `Db` that fails the spec on any use: proves no query ran. */
const NO_DB = new Proxy({} as Db, {
  get() {
    throw new Error('legal-in-force read D1 when it could not matter');
  },
});

async function readPublic(now: Date, maps: LegalInForceMaps = MAPS) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  app.get('/api/legal/published', createLegalPublishedHandler(t.factory, { now: () => now, maps }));
  const res = await app.request('/api/legal/published', {}, { ENV: 'development' } as Env);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('private, no-store');
  return LegalPublishedResponseSchema.parse(await res.json());
}

/** What the web decides from the public read (`legal-in-force-state.ts`). */
async function webVendorTerms(now: Date) {
  const res = await readPublic(now);
  return legalAgreementVersionInForce(
    'vendor_terms',
    legalPublishedLiteOf(res.published),
    Date.parse(res.now),
    MAPS,
  );
}

describe("today's data (invariant 1)", () => {
  it('reads nothing and answers the build versions, at any moment', async () => {
    for (const now of [new Date('2026-11-12T00:00:00Z'), new Date('2099-01-01T00:00:00Z')]) {
      expect(await loadLegalPublishedLite(NO_DB, now.getTime())).toEqual([]);
      expect(await loadLegalInForce(NO_DB, now)).toEqual({
        agreements: LEGAL_AGREEMENT_CURRENT_VERSIONS,
        policies: LEGAL_POLICY_CURRENT_VERSIONS,
      });
    }
  });

  it('the public read lists nothing, whatever D1 holds', async () => {
    await publish({ effectiveAt: 0 });
    const res = await readPublic(LATER, LEGAL_IN_FORCE_MAPS);
    expect(res.published).toEqual([]);
    expect(res.now).toBe(LATER.toISOString());
  });
});

describe('an unpublished upcoming agreement version (invariant 2)', () => {
  it('reads nothing before the moment', async () => {
    expect(await loadLegalPublishedLite(NO_DB, BEFORE.getTime(), MAPS)).toEqual([]);
  });

  it.each([AT, LATER])('never switches the stamp or the public read (%s)', async (now) => {
    const inForce = await loadLegalInForce(t.db, now, MAPS);
    expect(inForce.agreements.vendor_terms).toBe('1.3');
    expect((await readPublic(now)).published).toEqual([]);
    expect(await webVendorTerms(now)).toBe('1.3');
  });

  it('the policy switches on its date anyway: it has no publish record', async () => {
    expect((await loadLegalInForce(t.db, BEFORE, MAPS)).policies.listing_accuracy).toBe('1.0');
    expect((await loadLegalInForce(t.db, AT, MAPS)).policies.listing_accuracy).toBe('1.1');
  });

  it('a row with another moment does not switch either (fail safe)', async () => {
    await publish({ effectiveAt: MOMENT - 86_400_000 });
    expect((await loadLegalInForce(t.db, LATER, MAPS)).agreements.vendor_terms).toBe('1.3');
    expect((await readPublic(LATER)).published).toEqual([]);
  });
});

describe('a published upcoming agreement version (invariant 3)', () => {
  beforeEach(() => publish());

  it('switches exactly at the moment, on the API and in what the web decides', async () => {
    expect((await loadLegalInForce(t.db, BEFORE, MAPS)).agreements.vendor_terms).toBe('1.3');
    expect(await webVendorTerms(BEFORE)).toBe('1.3');
    expect((await loadLegalInForce(t.db, AT, MAPS)).agreements.vendor_terms).toBe('1.4');
    expect(await webVendorTerms(AT)).toBe('1.4');
  });

  it('the public read hides the row until its moment, then names only it', async () => {
    expect((await readPublic(BEFORE)).published).toEqual([]);
    expect((await readPublic(AT)).published).toEqual([
      { document: 'vendor_terms', version: '1.4', effective_at: AT.toISOString() },
    ]);
  });

  it('the gate and the claim box follow the version in force', async () => {
    const accept = (version: string, inForce: Awaited<ReturnType<typeof loadLegalInForce>>) =>
      agreementAcceptanceStatements(t.db, {
        document: 'vendor_terms',
        version,
        inForce,
        source: 'claim',
        email: 'a@example.test',
        acceptedAt: AT.toISOString(),
        actorType: 'user',
      });
    const before = await loadLegalInForce(t.db, BEFORE, MAPS);
    const at = await loadLegalInForce(t.db, AT, MAPS);
    expect(() => accept('1.3', before)).not.toThrow();
    expect(() => accept('1.4', before)).toThrow(/not the current version \(1\.3\)/);
    expect(() => accept('1.4', at)).not.toThrow();
    expect(() => accept('1.3', at)).toThrow(/not the current version \(1\.4\)/);
    expect(claimBoxFor('1.4', at)).not.toBeNull();
    expect(claimBoxFor('1.3', at)).toBeNull();
    expect(claimBoxFor('1.3', before)).not.toBeNull();
  });
});

describe('the acceptance screen agrees (invariant 4)', () => {
  it('finds the stamped version newest in force, and nothing before the moment', async () => {
    await publish();
    const rows = await t.db
      .select({
        document: legalVersions.document,
        version: legalVersions.version,
        effectiveAt: legalVersions.effectiveAt,
        requiresAcceptance: legalVersions.requiresAcceptance,
        summaryJson: legalVersions.summaryJson,
      })
      .from(legalVersions);
    expect(inForceVersions('vendor_terms', rows, BEFORE.getTime())).toEqual([]);
    expect(inForceVersions('vendor_terms', rows, AT.getTime())[0]).toBe(
      (await loadLegalInForce(t.db, AT, MAPS)).agreements.vendor_terms,
    );
  });
});
