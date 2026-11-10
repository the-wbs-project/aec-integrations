/**
 * The acceptance evidence removal (AECI-1636), against the in-memory D1 harness. Real
 * `agreement_acceptances` and `audit_log` rows, and a fixed `now` to travel in time.
 *
 * What it must hold:
 *   - a row accepted more than 90 days ago loses `ip` and `user_agent` and is stamped;
 *   - a row inside 90 days is untouched;
 *   - a row that never held either (checkout, signed deal) gets no stamp;
 *   - email, time and version stay;
 *   - one `agreement.evidence_removed` audit row per batch, in the same batch, no PII;
 *   - a re-run, as a queue retry would be, writes nothing.
 */

import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { agreementAcceptances, auditLog } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  ACCEPTANCE_EVIDENCE_DAYS,
  acceptanceEvidenceCutoff,
  AGREEMENT_EVIDENCE_REMOVED_ACTION,
  EVIDENCE_REMOVAL_CHUNK,
  EVIDENCE_REMOVAL_MAX_CHUNKS,
  runAcceptanceEvidenceRemoval,
} from './acceptance-evidence-removal';

const NOW = new Date('2027-03-01T17:00:00.000Z');
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY).toISOString();
const IP = '203.0.113.7';
const UA = 'Mozilla/5.0 (Macintosh) Test';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

type Seed = {
  id: string;
  acceptedAt: string;
  source?: 'claim' | 'checkout' | 'grant';
  method?: 'portal_checkbox' | 'signed_deal' | null;
  ip?: string | null;
  userAgent?: string | null;
};

async function seed(rows: Seed[]) {
  await t.db.insert(agreementAcceptances).values(
    rows.map((r) => ({
      id: r.id,
      document: r.source === 'claim' || !r.source ? 'vendor_terms' : 'managed_plan',
      version: '1.2',
      source: r.source ?? 'claim',
      email: `${r.id}@example.com`,
      acceptedAt: r.acceptedAt,
      ip: r.ip === undefined ? IP : r.ip,
      userAgent: r.userAgent === undefined ? UA : r.userAgent,
      method: r.method ?? null,
      createdAt: r.acceptedAt,
    })),
  );
}

const rowsById = async () =>
  Object.fromEntries(
    (await t.db.select().from(agreementAcceptances).orderBy(asc(agreementAcceptances.id))).map(
      (r) => [r.id, r],
    ),
  );

const removalAudits = () =>
  t.db.select().from(auditLog).where(eq(auditLog.action, AGREEMENT_EVIDENCE_REMOVED_ACTION));

describe('acceptanceEvidenceCutoff', () => {
  it('is 90 days before now', () => {
    expect(ACCEPTANCE_EVIDENCE_DAYS).toBe(90);
    expect(acceptanceEvidenceCutoff(NOW)).toBe(daysAgo(90));
  });
});

describe('runAcceptanceEvidenceRemoval', () => {
  it('nulls IP and browser past 90 days and leaves newer rows alone', async () => {
    await seed([
      { id: 'a-old', acceptedAt: daysAgo(91) },
      { id: 'a-ua-only', acceptedAt: daysAgo(200), ip: null },
      { id: 'a-young', acceptedAt: daysAgo(89) },
      { id: 'a-boundary', acceptedAt: daysAgo(90) },
    ]);

    const result = await runAcceptanceEvidenceRemoval(t.db, { now: NOW });

    expect(result).toMatchObject({ removed: 2, batches: 1, truncated: false });
    const rows = await rowsById();
    for (const id of ['a-old', 'a-ua-only']) {
      expect(rows[id]).toMatchObject({
        ip: null,
        userAgent: null,
        evidenceRemovedAt: NOW.toISOString(),
      });
    }
    // Inside the window, and exactly at it: kept until a later run.
    for (const id of ['a-young', 'a-boundary']) {
      expect(rows[id]).toMatchObject({ ip: IP, userAgent: UA, evidenceRemovedAt: null });
    }
    // The evidence that proves the acceptance stays.
    expect(rows['a-old']).toMatchObject({
      email: 'a-old@example.com',
      acceptedAt: daysAgo(91),
      version: '1.2',
      document: 'vendor_terms',
    });
  });

  it('removes them from a portal grant accept too, and stamps no row that never held them', async () => {
    await seed([
      { id: 'g-portal', acceptedAt: daysAgo(120), source: 'grant', method: 'portal_checkbox' },
      {
        id: 'g-deal',
        acceptedAt: daysAgo(120),
        source: 'grant',
        method: 'signed_deal',
        ip: null,
        userAgent: null,
      },
      { id: 'c-checkout', acceptedAt: daysAgo(120), source: 'checkout', ip: null, userAgent: null },
    ]);

    const result = await runAcceptanceEvidenceRemoval(t.db, { now: NOW });

    expect(result.removed).toBe(1);
    const rows = await rowsById();
    expect(rows['g-portal']).toMatchObject({ ip: null, userAgent: null });
    expect(rows['g-portal'].evidenceRemovedAt).toBe(NOW.toISOString());
    // "Not recorded", not "Removed": the admin view keys on this stamp.
    expect(rows['g-deal'].evidenceRemovedAt).toBeNull();
    expect(rows['c-checkout'].evidenceRemovedAt).toBeNull();
  });

  it('writes one audit row per batch, in the same batch as the update, with ids and no PII', async () => {
    await seed([
      { id: 'a-1', acceptedAt: daysAgo(100) },
      { id: 'a-2', acceptedAt: daysAgo(95) },
    ]);
    const batchSpy = vi.spyOn(t.db, 'batch');

    await runAcceptanceEvidenceRemoval(t.db, { now: NOW });

    expect(batchSpy).toHaveBeenCalledTimes(1);
    const stmts = batchSpy.mock.calls[0][0] as unknown as { toSQL(): { sql: string } }[];
    expect(stmts).toHaveLength(2);
    expect(stmts[0].toSQL().sql).toMatch(/^update "agreement_acceptances"/);
    expect(stmts[1].toSQL().sql).toMatch(/^insert into "audit_log"/);

    const audits = await removalAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      entityType: 'agreement_acceptance',
      vendorId: null,
    });
    expect(audits[0].metadata).toEqual({
      source: 'acceptance-evidence-removal',
      cutoff: daysAgo(90),
      count: 2,
      acceptance_ids: ['a-1', 'a-2'],
    });
    const serialized = JSON.stringify(audits[0]);
    expect(serialized).not.toContain(IP);
    expect(serialized).not.toContain(UA);
    expect(serialized).not.toContain('@example.com');
  });

  it('writes nothing on a re-run, as a queue retry would be', async () => {
    await seed([{ id: 'a-old', acceptedAt: daysAgo(91) }]);
    await runAcceptanceEvidenceRemoval(t.db, { now: NOW });
    const later = new Date(NOW.getTime() + DAY);

    const again = await runAcceptanceEvidenceRemoval(t.db, { now: later });

    expect(again).toMatchObject({ removed: 0, batches: 0, truncated: false });
    expect(await removalAudits()).toHaveLength(1);
    // The first run's stamp is kept, not moved.
    expect((await rowsById())['a-old'].evidenceRemovedAt).toBe(NOW.toISOString());
  });

  it('removes a row once it ages past 90 days on a later run (time travel)', async () => {
    await seed([{ id: 'a-young', acceptedAt: daysAgo(89) }]);
    expect((await runAcceptanceEvidenceRemoval(t.db, { now: NOW })).removed).toBe(0);

    const twoDaysLater = new Date(NOW.getTime() + 2 * DAY);
    const result = await runAcceptanceEvidenceRemoval(t.db, { now: twoDaysLater });

    expect(result.removed).toBe(1);
    expect((await rowsById())['a-young']).toMatchObject({ ip: null, userAgent: null });
  });

  it('works in batches of 80, oldest first, and stops at the run cap', async () => {
    const total = EVIDENCE_REMOVAL_CHUNK * EVIDENCE_REMOVAL_MAX_CHUNKS + 5;
    await seed(
      Array.from({ length: total }, (_, i) => ({
        id: `a-${String(i).padStart(4, '0')}`,
        // Oldest first: a-0000 is the oldest.
        acceptedAt: daysAgo(1000 - i / 10),
      })),
    );

    const result = await runAcceptanceEvidenceRemoval(t.db, { now: NOW });

    expect(result).toMatchObject({
      removed: EVIDENCE_REMOVAL_CHUNK * EVIDENCE_REMOVAL_MAX_CHUNKS,
      batches: EVIDENCE_REMOVAL_MAX_CHUNKS,
      truncated: true,
    });
    const audits = await removalAudits();
    expect(audits).toHaveLength(EVIDENCE_REMOVAL_MAX_CHUNKS);
    const rows = await rowsById();
    // The five youngest wait for tomorrow.
    expect(rows[`a-${String(total - 1).padStart(4, '0')}`].ip).toBe(IP);
    expect(rows['a-0000'].ip).toBeNull();

    const tomorrow = await runAcceptanceEvidenceRemoval(t.db, {
      now: new Date(NOW.getTime() + DAY),
    });
    expect(tomorrow).toMatchObject({ removed: 5, batches: 1, truncated: false });
  });

  it('writes nothing when no row is due', async () => {
    const batchSpy = vi.spyOn(t.db, 'batch');
    const result = await runAcceptanceEvidenceRemoval(t.db, { now: NOW });
    expect(result).toMatchObject({ removed: 0, batches: 0, truncated: false });
    expect(batchSpy).not.toHaveBeenCalled();
    expect(await removalAudits()).toHaveLength(0);
  });
});
