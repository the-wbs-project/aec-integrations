/**
 * The send ledger (AECI-1202) against the in-memory D1 harness, so the UNIQUE index and
 * `ON CONFLICT(dedupe_key) DO NOTHING` are real SQLite, not a mock.
 */

import { asc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Db } from '../../db/client';
import { notificationSends } from '../../db/schema';
import { makeTestDb, type TestDb } from '../../test/d1';
import {
  finalizeSend,
  ledgerDb,
  readProviderMessageId,
  recordSend,
  reserveSend,
} from './send-ledger';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const BASE = {
  notificationId: 'claim-approved',
  recipientHash: 'a'.repeat(64),
  tier: 'production',
};

const rows = () => t.db.select().from(notificationSends).orderBy(asc(notificationSends.id));
const silent = { warn: vi.fn() };

/** A Db whose every statement throws, for the fail-open paths. */
function brokenDb(): Db {
  const boom = () => {
    throw new Error('D1_ERROR: no such table');
  };
  return { insert: boom, update: boom } as unknown as Db;
}

describe('reserveSend', () => {
  it('inserts a sending row that holds the key and carries the entity', async () => {
    const out = await reserveSend(t.db, {
      ...BASE,
      dedupeKey: 'claim-approved:c1',
      entity: { type: 'claim', id: 'c1' },
    });

    expect(out).toEqual({ rowId: expect.any(Number), duplicate: false });
    expect(await rows()).toEqual([
      expect.objectContaining({
        id: out.rowId,
        notificationId: 'claim-approved',
        recipientHash: BASE.recipientHash,
        tier: 'production',
        outcome: 'sending',
        providerMessageId: null,
        dedupeKey: 'claim-approved:c1',
        entityType: 'claim',
        entityId: 'c1',
      }),
    ]);
  });

  it('refuses a held key and records a duplicate row with a NULL key', async () => {
    const first = await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });
    const second = await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });

    expect(second.duplicate).toBe(true);
    expect(second.rowId).not.toBe(first.rowId);
    const all = await rows();
    expect(all.map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['sending', 'k'],
      ['duplicate', null],
    ]);
  });

  it('never conflicts without a key: NULLs are distinct under the UNIQUE index', async () => {
    const a = await reserveSend(t.db, BASE);
    const b = await reserveSend(t.db, BASE);
    expect([a.duplicate, b.duplicate]).toEqual([false, false]);
    expect((await rows()).map((r) => r.dedupeKey)).toEqual([null, null]);
  });

  it('blocks a resend while an earlier send is still sending (a crash mid-send)', async () => {
    await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });
    // No finalize: the isolate died. The key stays held.
    expect((await reserveSend(t.db, { ...BASE, dedupeKey: 'k' })).duplicate).toBe(true);
  });

  it('fails open on a DB error: no row id, not a duplicate, a warning', async () => {
    const logger = { warn: vi.fn() };
    const out = await reserveSend(brokenDb(), { ...BASE, dedupeKey: 'k' }, logger);
    expect(out).toEqual({ rowId: null, duplicate: false });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sending anyway'));
  });

  it('is a no-op without a ledger', async () => {
    expect(await reserveSend(null, { ...BASE, dedupeKey: 'k' })).toEqual({
      rowId: null,
      duplicate: false,
    });
  });
});

describe('finalizeSend', () => {
  it('marks sent with the Resend id and keeps the key held', async () => {
    const { rowId } = await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });
    await finalizeSend(t.db, rowId, { outcome: 'sent', providerMessageId: 're_1' });

    const [row] = await rows();
    expect(row).toMatchObject({ outcome: 'sent', providerMessageId: 're_1', dedupeKey: 'k' });
    expect((await reserveSend(t.db, { ...BASE, dedupeKey: 'k' })).duplicate).toBe(true);
  });

  it('marks failed and releases the key, so a retry can send', async () => {
    const { rowId } = await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });
    await finalizeSend(t.db, rowId, { outcome: 'failed' });

    const [row] = await rows();
    expect(row).toMatchObject({ outcome: 'failed', dedupeKey: null, providerMessageId: null });

    const retry = await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });
    expect(retry.duplicate).toBe(false);
    expect((await rows()).map((r) => [r.outcome, r.dedupeKey])).toEqual([
      ['failed', null],
      ['sending', 'k'],
    ]);
  });

  it('is a no-op for a null row id, and never throws on a DB error', async () => {
    await expect(finalizeSend(t.db, null, { outcome: 'sent' })).resolves.toBeUndefined();
    const logger = { warn: vi.fn() };
    await expect(finalizeSend(brokenDb(), 1, { outcome: 'sent' }, logger)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledOnce();
  });
});

describe('recordSend', () => {
  it.each(['skipped', 'suppressed', 'sent', 'failed', 'duplicate'] as const)(
    'writes one settled %s row with no dedupe key',
    async (outcome) => {
      const id = await recordSend(t.db, { ...BASE, outcome, providerMessageId: null }, silent);
      expect(id).toEqual(expect.any(Number));
      expect(await rows()).toEqual([
        expect.objectContaining({ id, outcome, dedupeKey: null, entityType: null }),
      ]);
    },
  );

  it('returns null and warns on a DB error', async () => {
    const logger = { warn: vi.fn() };
    expect(await recordSend(brokenDb(), { ...BASE, outcome: 'skipped' }, logger)).toBeNull();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it('a duplicate whose own row fails to write is still a duplicate', async () => {
    await reserveSend(t.db, { ...BASE, dedupeKey: 'k' });
    // Break inserts only after the holder exists.
    const real = t.db.insert.bind(t.db);
    let calls = 0;
    const flaky = {
      ...t.db,
      insert: (table: typeof notificationSends) => {
        calls++;
        if (calls === 2) throw new Error('D1_ERROR');
        return real(table);
      },
    } as unknown as Db;
    const out = await reserveSend(flaky, { ...BASE, dedupeKey: 'k' }, silent);
    expect(out).toEqual({ rowId: null, duplicate: true });
  });
});

describe('readProviderMessageId', () => {
  it('reads the Resend id and consumes the body', async () => {
    const res = new Response('{"id":"re_1"}', { status: 200 });
    expect(await readProviderMessageId(res)).toBe('re_1');
    expect(res.bodyUsed).toBe(true);
  });

  it.each([
    ['not json', 'nope'],
    ['no id', '{"ok":true}'],
    ['a non-string id', '{"id":7}'],
    ['an empty id', '{"id":""}'],
    ['an empty body', ''],
  ])('returns null for %s', async (_label, body) => {
    expect(await readProviderMessageId(new Response(body, { status: 200 }))).toBeNull();
  });
});

describe('ledgerDb', () => {
  it('is null without a DB binding', () => {
    expect(ledgerDb({})).toBeNull();
    expect(ledgerDb({ DB: undefined })).toBeNull();
  });
});
