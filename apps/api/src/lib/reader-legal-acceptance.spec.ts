/**
 * AECI-1637: the sign-in acceptance of the Terms of Service (`reader-legal-acceptance.ts`).
 * Signing in is the acceptance (ruling of 2026-11-13).
 *
 * THE INVARIANT pinned first: while no Terms version is in force, a sign-in reads nothing
 * and writes nothing. Then the tick box (counsel Q63, ruling 53): only the first sign-in
 * after a version that reduces rights asks for it, and the sign-in alone writes nothing then.
 */
import {
  LEGAL_IN_FORCE_MAPS,
  legalEffectiveAtMs,
  SIGN_IN_TERMS_LINE,
  TERMS_CHANGE_BOX_LABEL,
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
  readTermsBoxPending,
  recordSignInTermsAcceptance,
  termsBoxPendingVersion,
  writeSignInTermsAcceptance,
  writeTermsBoxAcceptance,
  type ReaderPublishedLite,
} from './reader-legal-acceptance';

const READER = '00000000-0000-4000-8000-000000000001';
const DAY = '2027-01-15';
const MOMENT = legalEffectiveAtMs(DAY);
const AFTER = new Date(MOMENT + 86_400_000);
/** The reader's account predates the version. */
const JOINED = '2026-06-01T00:00:00.000Z';

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
  requiresAcceptance: false,
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
    await t.db.insert(profiles).values({ id: READER, role: 'reviewer', createdAt: JOINED });
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

  const write = async (over: { now?: Date; maps?: LegalInForceMaps; created?: boolean } = {}) =>
    (
      await writeSignInTermsAcceptance(t.db, {
        profileId: READER,
        email: 'reader@example.com',
        headers: headers(),
        now: over.now ?? AFTER,
        created: over.created,
        maps: over.maps ?? MAPS,
      })
    ).entry;

  it('writes one row and its audit row for the version in force, with the evidence', async () => {
    await publish(false);
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

  it('an account created by this sign-in gets the line row even for a rights-reducing version', async () => {
    await publish(true);
    expect(await write({ created: true })).not.toBeNull();
    const rows = await t.db.select().from(termsAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      checkboxLabel: SIGN_IN_TERMS_LINE,
      checkboxDefaultUnticked: false,
    });
    // Its next sign-in shows no box: the line row covers the version.
    const next = await writeSignInTermsAcceptance(t.db, {
      profileId: READER,
      email: 'reader@example.com',
      headers: headers(),
      now: new Date(AFTER.getTime() + 60_000),
      maps: MAPS,
    });
    expect(next).toEqual({ entry: null, boxVersion: null });
  });

  it('a second sign-in on the same version writes nothing', async () => {
    await publish(false);
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
    await publish(false);
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

  // ── The tick box (counsel Q63, ruling 53) ─────────────────────────────────────
  it('a rights-reducing version: the sign-in writes nothing and names the box', async () => {
    await publish(true);
    const result = await writeSignInTermsAcceptance(t.db, {
      profileId: READER,
      email: 'reader@example.com',
      headers: headers(),
      now: AFTER,
      maps: MAPS,
    });
    expect(result).toEqual({ entry: null, boxVersion: '1.2' });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  const tick = (version = '1.2', now = AFTER) =>
    writeTermsBoxAcceptance(t.db, {
      profileId: READER,
      email: 'reader@example.com',
      headers: headers(),
      now,
      version,
      maps: MAPS,
    });

  it('the tick writes the row with the box label, its hash and the unticked flag, with its audit row', async () => {
    await publish(true);
    const batch = vi.spyOn(t.db, 'batch');
    const result = await tick();
    expect(result.entry?.action).toBe('terms.accepted');
    expect(result.entry?.metadata).toEqual({ source: 'terms-box' });
    expect(batch.mock.calls[1]![0]).toHaveLength(2);
    const rows = await t.db.select().from(termsAcceptances);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      version: '1.2',
      legalVersionId: 'lv12',
      email: 'reader@example.com',
      ip: '203.0.113.7',
      checkboxLabel: TERMS_CHANGE_BOX_LABEL,
      checkboxLabelSha256: await sha256Hex(TERMS_CHANGE_BOX_LABEL),
      checkboxDefaultUnticked: true,
      pdfSha256: 'b'.repeat(64),
    });
    expect(
      await t.db.select().from(auditLog).where(eq(auditLog.action, 'terms.accepted')),
    ).toHaveLength(1);
  });

  it('after the tick, the next sign-in shows no box and writes nothing', async () => {
    await publish(true);
    await tick();
    const result = await writeSignInTermsAcceptance(t.db, {
      profileId: READER,
      email: 'reader@example.com',
      headers: headers(),
      now: new Date(AFTER.getTime() + 60_000),
      maps: MAPS,
    });
    expect(result).toEqual({ entry: null, boxVersion: null });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
  });

  it('a second tick answers with the first acceptance and writes nothing', async () => {
    await publish(true);
    await tick();
    const again = await tick('1.2', new Date(AFTER.getTime() + 60_000));
    expect(again).toEqual({ entry: null, acceptedAt: AFTER.toISOString() });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
  });

  it('a tick that loses a race to another tab answers with the winning acceptance', async () => {
    await publish(true);
    // The other tab's row lands between this tick's read and its insert.
    const real = t.db.batch.bind(t.db);
    let calls = 0;
    vi.spyOn(t.db, 'batch').mockImplementation(async (stmts) => {
      calls += 1;
      if (calls === 2) {
        await t.db.insert(termsAcceptances).values({
          document: 'terms',
          version: '1.2',
          profileId: READER,
          email: 'reader@example.com',
          acceptedAt: '2027-01-16T09:00:00.000Z',
          checkboxLabel: TERMS_CHANGE_BOX_LABEL,
          checkboxLabelSha256: 'c'.repeat(64),
          checkboxDefaultUnticked: true,
        });
      }
      return real(stmts as never);
    });
    const result = await tick();
    expect(result).toEqual({ entry: null, acceptedAt: '2027-01-16T09:00:00.000Z' });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(1);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('refuses a version that is not waiting for a box, writing nothing', async () => {
    await publish(false);
    await expect(tick()).rejects.toMatchObject({
      status: 422,
      code: 'LEGAL_ACCEPTANCE_NOT_PENDING',
    });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
  });

  it('refuses a stale or forged version', async () => {
    await publish(true);
    await expect(tick('9.9')).rejects.toMatchObject({ code: 'LEGAL_ACCEPTANCE_NOT_PENDING' });
    await expect(tick('1.2', new Date(MOMENT - 1))).rejects.toMatchObject({
      code: 'LEGAL_ACCEPTANCE_NOT_PENDING',
    });
    expect(await t.db.select().from(termsAcceptances)).toHaveLength(0);
  });

  it('readTermsBoxPending: the version, its date, the published summary and the version before', async () => {
    await publish(true);
    // The reader accepted 1.1 by the line when it was in force (dated in these maps).
    const maps11: LegalInForceMaps = {
      ...MAPS,
      readerEffectiveOn: { terms: { '1.0': null, '1.1': '2026-07-01' }, privacy: {} },
    };
    await t.db.insert(termsAcceptances).values({
      document: 'terms',
      version: '1.1',
      profileId: READER,
      email: 'reader@example.com',
      acceptedAt: '2026-08-01T00:00:00.000Z',
      checkboxLabel: SIGN_IN_TERMS_LINE,
      checkboxLabelSha256: 'd'.repeat(64),
      checkboxDefaultUnticked: false,
    });
    expect(await readTermsBoxPending(t.db, READER, AFTER, maps11)).toEqual({
      version: '1.2',
      effective_at: new Date(MOMENT).toISOString(),
      summary: ['The disputes section changes.'],
      previous_version: '1.1',
    });
    // After the tick nothing waits.
    await writeTermsBoxAcceptance(t.db, {
      profileId: READER,
      email: 'reader@example.com',
      headers: headers(),
      now: AFTER,
      version: '1.2',
      maps: maps11,
    });
    expect(await readTermsBoxPending(t.db, READER, AFTER, maps11)).toBeNull();
  });

  it('readTermsBoxPending: no box due, null; no earlier acceptance, previous null', async () => {
    await publish(false);
    expect(await readTermsBoxPending(t.db, READER, AFTER, MAPS)).toBeNull();
  });

  it('readTermsBoxPending reads nothing while no version can be in force', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    expect(await readTermsBoxPending(t.db, READER, AFTER)).toBeNull();
    expect(batch).not.toHaveBeenCalled();
  });

  it('refuses while no version is in force, with no read', async () => {
    const batch = vi.spyOn(t.db, 'batch');
    await expect(
      writeTermsBoxAcceptance(t.db, {
        profileId: READER,
        email: 'reader@example.com',
        headers: headers(),
        now: AFTER,
        version: '1.2',
      }),
    ).rejects.toMatchObject({ code: 'LEGAL_ACCEPTANCE_NOT_PENDING' });
    expect(batch).not.toHaveBeenCalled();
  });
});

describe('termsBoxPendingVersion', () => {
  const JOINED_MS = Date.parse(JOINED);
  const NOW = AFTER.getTime();

  it('no flag in force, no box', () => {
    expect(termsBoxPendingVersion([row()], [], JOINED_MS, NOW, MAPS)).toBeNull();
  });

  it('a flagged version in force for an older account is the box', () => {
    expect(
      termsBoxPendingVersion([row({ requiresAcceptance: true })], [], JOINED_MS, NOW, MAPS),
    ).toBe('1.2');
  });

  it('not before its moment', () => {
    expect(
      termsBoxPendingVersion([row({ requiresAcceptance: true })], [], JOINED_MS, MOMENT - 1, MAPS),
    ).toBeNull();
  });

  it('an account created after the reduction took effect never sees the box', () => {
    expect(
      termsBoxPendingVersion([row({ requiresAcceptance: true })], [], MOMENT + 1, NOW, MAPS),
    ).toBeNull();
    expect(
      termsBoxPendingVersion(
        [row({ requiresAcceptance: true })],
        [],
        Number.POSITIVE_INFINITY,
        NOW,
        MAPS,
      ),
    ).toBeNull();
  });

  it('a row for the version covers it, line or box (a line row is only written when no box was due)', () => {
    const published = [row({ requiresAcceptance: true })];
    expect(
      termsBoxPendingVersion(
        published,
        [{ version: '1.2', checkboxDefaultUnticked: false }],
        JOINED_MS,
        NOW,
        MAPS,
      ),
    ).toBeNull();
    expect(
      termsBoxPendingVersion(
        published,
        [{ version: '1.1', checkboxDefaultUnticked: true }],
        JOINED_MS,
        NOW,
        MAPS,
      ),
    ).toBe('1.2');
    expect(
      termsBoxPendingVersion(
        published,
        [{ version: '1.2', checkboxDefaultUnticked: true }],
        JOINED_MS,
        NOW,
        MAPS,
      ),
    ).toBeNull();
  });

  it('a later ordinary version still asks for the box while an earlier reduction is unticked', () => {
    const later: LegalInForceMaps = {
      ...LEGAL_IN_FORCE_MAPS,
      readerEffectiveOn: { terms: { '1.0': null, '1.1': null, '1.2': DAY }, privacy: {} },
      readerUpcoming: { terms: { version: '1.3', effectiveOn: '2027-03-01' } },
    };
    const m13 = legalEffectiveAtMs('2027-03-01');
    const published = [
      row({ requiresAcceptance: true }),
      row({ id: 'lv13', version: '1.3', effectiveAt: m13 }),
    ];
    const now = m13 + 1;
    expect(termsBoxPendingVersion(published, [], JOINED_MS, now, later)).toBe('1.3');
    // A box ticked for 1.2 covers the reduction; 1.3 then binds by the line.
    expect(
      termsBoxPendingVersion(
        published,
        [{ version: '1.2', checkboxDefaultUnticked: true }],
        JOINED_MS,
        now,
        later,
      ),
    ).toBeNull();
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
    ).resolves.toEqual({ entry: null, boxVersion: null });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
