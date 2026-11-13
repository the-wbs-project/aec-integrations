/**
 * AECI-1637: the sign-in acceptance of the Terms of Service (`reader-legal-acceptance.ts`).
 * Signing in is the acceptance (ruling of 2026-11-13).
 *
 * THE INVARIANT pinned first: while no Terms version is in force, a sign-in reads nothing
 * and writes nothing.
 */
import {
  LEGAL_IN_FORCE_MAPS,
  legalEffectiveAtMs,
  SIGN_IN_TERMS_LINE,
  type LegalInForceMaps,
} from '@aeci/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { auditLog, legalVersions, profiles, termsAcceptances } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import { sha256Hex } from './hash';
import {
  readerTermsInForce,
  readerTermsMayBeInForce,
  recordSignInTermsAcceptance,
  writeSignInTermsAcceptance,
  type ReaderPublishedLite,
} from './reader-legal-acceptance';

const READER = '00000000-0000-4000-8000-000000000001';
const DAY = '2027-01-15';
const MOMENT = legalEffectiveAtMs(DAY);
const AFTER = new Date(MOMENT + 86_400_000);

/** Terms 1.2 is upcoming on DAY. */
const MAPS: LegalInForceMaps = {
  ...LEGAL_IN_FORCE_MAPS,
  readerUpcoming: { terms: { version: '1.2', effectiveOn: DAY } },
};

const row = (over: Partial<ReaderPublishedLite> = {}): ReaderPublishedLite => ({
  id: 'lv12',
  document: 'terms',
  version: '1.2',
  effectiveAt: MOMENT,
  pdfSha256: 'a'.repeat(64),
  ...over,
});

describe('the invariant: nothing in force, nothing written', () => {
  it("today's maps: no Terms version can be in force at any moment, whatever D1 holds", () => {
    for (const now of [0, Date.now(), Date.parse('2099-01-01T00:00:00Z')]) {
      expect(readerTermsMayBeInForce(now)).toBe(false);
      expect(readerTermsInForce([row({ effectiveAt: 0 })], now)).toBeNull();
    }
  });

  it('a stray row for a version code does not name is never in force', () => {
    const stray = row({ version: '9.9', effectiveAt: 0 });
    expect(readerTermsInForce([stray], MOMENT, MAPS)).toBeNull();
  });

  it('an unpublished upcoming version never switches in', () => {
    expect(readerTermsMayBeInForce(AFTER.getTime(), MAPS)).toBe(true);
    expect(readerTermsInForce([], AFTER.getTime(), MAPS)).toBeNull();
  });

  it('a row whose date moved after the publish is in force nowhere', () => {
    expect(readerTermsInForce([row({ effectiveAt: MOMENT + 1 })], AFTER.getTime(), MAPS)).toBe(
      null,
    );
  });

  it('a published version is in force from its moment, not a millisecond before', () => {
    expect(readerTermsMayBeInForce(MOMENT - 1, MAPS)).toBe(false);
    expect(readerTermsInForce([row()], MOMENT - 1, MAPS)).toBeNull();
    expect(readerTermsInForce([row()], MOMENT, MAPS)).toBe('1.2');
  });

  it('a dated build version is in force with no row at all', () => {
    const dated: LegalInForceMaps = {
      ...LEGAL_IN_FORCE_MAPS,
      readerEffectiveOn: { terms: { '1.0': null, '1.1': DAY }, privacy: {} },
    };
    expect(readerTermsInForce([], MOMENT, dated)).toBe('1.1');
  });
});

describe('writeSignInTermsAcceptance', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
    await t.db.insert(profiles).values({ id: READER, role: 'reviewer' });
  });
  afterEach(() => t.dispose());

  const publish = (requiresAcceptance: boolean) =>
    t.db.insert(legalVersions).values({
      id: 'lv12',
      document: 'terms',
      version: '1.2',
      effectiveAt: MOMENT,
      summaryJson: '["The disputes section changes."]',
      material: true,
      requiresAcceptance,
      pdfKey: 'legal/terms/v1.2.pdf',
      pdfSha256: 'b'.repeat(64),
      pdfBytes: 10,
      publishedBy: 'admin',
      publishedAt: '2026-12-01T00:00:00.000Z',
    });

  const headers = () =>
    new Headers({
      'cf-connecting-ip': '203.0.113.7',
      'user-agent': `Mozilla/5.0 ${'x'.repeat(600)}`,
    });

  const write = (over: { now?: Date; maps?: LegalInForceMaps } = {}) =>
    writeSignInTermsAcceptance(t.db, {
      profileId: READER,
      email: 'reader@example.com',
      headers: headers(),
      now: over.now ?? AFTER,
      maps: over.maps ?? MAPS,
    });

  it('writes one row and its audit row for the version in force, with the evidence', async () => {
    await publish(true);
    const batch = vi.spyOn(t.db, 'batch');
    const entry = await write();
    expect(entry?.action).toBe('terms.accepted');

    // One read batch, then one write batch holding the row AND its audit row.
    expect(batch).toHaveBeenCalledTimes(2);
    expect(batch.mock.calls[1]![0]).toHaveLength(2);

    const rows = await t.db.select().from(termsAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      document: 'terms',
      version: '1.2',
      legalVersionId: 'lv12',
      profileId: READER,
      email: 'reader@example.com',
      acceptedAt: AFTER.toISOString(),
      ip: '203.0.113.7',
      checkboxLabel: SIGN_IN_TERMS_LINE,
      checkboxLabelSha256: await sha256Hex(SIGN_IN_TERMS_LINE),
      checkboxDefaultUnticked: false,
      pdfSha256: 'b'.repeat(64),
      evidenceRemovedAt: null,
    });
    expect(rows[0]!.userAgent).toHaveLength(512);

    const audits = await t.db.select().from(auditLog).where(eq(auditLog.action, 'terms.accepted'));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: READER,
      entityType: 'terms_acceptance',
      entityId: rows[0]!.id,
    });
    // The audit row is forwarded to PostHog: no email, IP or browser in it.
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain('reader@example.com');
    expect(serialized).not.toContain('203.0.113.7');
    expect(serialized).not.toContain('Mozilla');
  });

  it('writes the row whatever the publish flag says', async () => {
    await publish(false);
    expect(await write()).not.toBeNull();
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
  });

  it('a second sign-in on the same version writes nothing', async () => {
    await publish(true);
    await write();
    expect(await write({ now: new Date(AFTER.getTime() + 60_000) })).toBeNull();
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'terms.accepted')),
    ).toHaveLength(1);
  });

  it('with no version in force it reads nothing and writes nothing', async () => {
    await publish(true);
    const batch = vi.spyOn(t.db, 'batch');
    expect(await write({ maps: LEGAL_IN_FORCE_MAPS })).toBeNull();
    expect(batch).not.toHaveBeenCalled();
    expect(await write({ now: new Date(MOMENT - 1) })).toBeNull();
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('records a missing IP and browser as null', async () => {
    await publish(true);
    await writeSignInTermsAcceptance(t.db, {
      profileId: READER,
      email: undefined,
      headers: new Headers(),
      now: AFTER,
      maps: MAPS,
    });
    const [r] = await t.db.select().from(termsAcceptances);
    expect(r).toMatchObject({ ip: null, userAgent: null, email: '' });
  });
});

describe('recordSignInTermsAcceptance', () => {
  it('logs and returns null when the write fails, never throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      batch: vi.fn().mockRejectedValue(new Error('D1 is down')),
    } as unknown as Parameters<typeof recordSignInTermsAcceptance>[0];
    await expect(
      recordSignInTermsAcceptance(db, {
        profileId: READER,
        email: 'reader@example.com',
        headers: new Headers(),
        now: AFTER,
        maps: MAPS,
      }),
    ).resolves.toBeNull();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
