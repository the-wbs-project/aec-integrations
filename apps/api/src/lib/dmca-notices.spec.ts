/**
 * `lib/dmca-notices.ts` (AECI-1665). Source of truth: `ADMIN_PANEL_SPEC.md` §5.23.
 *
 * INVARIANTS:
 *
 *   1. **The restore clock counts business days from receipt.** Weekends and observed
 *      federal holidays are skipped. The window opens at the start of business day 10 and
 *      closes at the end of business day 14, never early.
 *   2. **The takedown count is ruling 2A.** It counts notices against the account whose
 *      material was removed or disabled. `pending`, `no_action` and a takedown restored after
 *      a counter-notice do not count. A takedown whose counter-notice ended `not_restored`
 *      does.
 *   3. **The restores due are the open counter-notices that need the operator now**
 *      (AECI-1944): overdue, window open, or never forwarded. Most urgent first. The
 *      data-quality check and the Overview strip read the same list.
 */

import { count } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dmcaNotices } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';
import {
  accountCountStatements,
  counterNoticeCountWhere,
  countRestoresDue,
  readRestoresDue,
  restoreClock,
  takedownCountWhere,
  type DmcaNoticeRow,
} from './dmca-notices';

const counter = (over: Partial<DmcaNoticeRow> = {}) => ({
  kind: 'counter_notice',
  receivedAt: '2026-11-20T15:00:00.000Z',
  forwardedAt: '2026-11-20T16:00:00.000Z',
  courtActionAt: null,
  restoreOutcome: null,
  ...over,
});

describe('restoreClock', () => {
  it('is null on a notice', () => {
    expect(restoreClock({ ...counter(), kind: 'notice' }, new Date())).toBeNull();
  });

  it('skips the weekend and Thanksgiving: received Fri 20 Nov, window 7 to 11 Dec', () => {
    const clock = restoreClock(counter(), new Date('2026-11-21T00:00:00.000Z'))!;
    expect(clock).toEqual({
      opens_on: '2026-12-07',
      due_on: '2026-12-11',
      // 05:00 UTC is midnight EST: the window never opens early.
      earliest: '2026-12-07T05:00:00.000Z',
      // businessWindowEnd: the first moment safely past 11 Dec in New York.
      latest: '2026-12-12T05:00:00.000Z',
      state: 'waiting',
    });
  });

  it('skips Christmas and New Year across the year end', () => {
    const clock = restoreClock(
      counter({ receivedAt: '2026-12-18T15:00:00.000Z' }),
      new Date('2026-12-19T00:00:00.000Z'),
    )!;
    expect(clock.opens_on).toBe('2027-01-05');
    expect(clock.due_on).toBe('2027-01-11');
  });

  it('uses the New York date of receipt, not the UTC date', () => {
    // 02:00 UTC on Saturday 21 Nov is still Friday 20 Nov in New York.
    const clock = restoreClock(
      counter({ receivedAt: '2026-11-21T02:00:00.000Z' }),
      new Date('2026-11-21T03:00:00.000Z'),
    )!;
    expect(clock.opens_on).toBe('2026-12-07');
  });

  it('moves through waiting, open and overdue', () => {
    const at = (iso: string) => restoreClock(counter(), new Date(iso))!.state;
    expect(at('2026-12-07T04:59:59.999Z')).toBe('waiting');
    expect(at('2026-12-07T05:00:00.000Z')).toBe('restore_window_open');
    expect(at('2026-12-12T04:59:59.999Z')).toBe('restore_window_open');
    expect(at('2026-12-12T05:00:00.000Z')).toBe('overdue');
  });

  it('reports awaiting_forward, court_action and the outcomes ahead of the dates', () => {
    const late = new Date('2027-02-01T00:00:00.000Z');
    expect(restoreClock(counter({ forwardedAt: null }), late)!.state).toBe('awaiting_forward');
    expect(restoreClock(counter({ courtActionAt: '2026-12-01T00:00:00.000Z' }), late)!.state).toBe(
      'court_action',
    );
    expect(restoreClock(counter({ restoreOutcome: 'restored' }), late)!.state).toBe('restored');
    expect(restoreClock(counter({ restoreOutcome: 'not_restored' }), late)!.state).toBe(
      'not_restored',
    );
  });
});

describe('the per-account counts', () => {
  const ACCOUNT = '00000000-0000-4000-8000-000000000001';
  const OTHER = '00000000-0000-4000-8000-000000000002';
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  let n = 0;
  async function seed(over: Partial<DmcaNoticeRow>): Promise<string> {
    n += 1;
    const id = `00000000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
    await t.db.insert(dmcaNotices).values({
      id,
      kind: 'notice',
      receivedAt: '2026-11-01T12:00:00.000Z',
      submitterName: 'Rights Holder',
      submitterContact: 'rights@example.test',
      contentIdentified: 'https://example.test/x',
      accountId: ACCOUNT,
      action: 'removed',
      createdBy: 'admin',
      updatedBy: 'admin',
      ...over,
    });
    return id;
  }

  async function counts(accountId = ACCOUNT) {
    const [takedowns, counters] = await t.db.batch(accountCountStatements(t.db, accountId));
    return { takedowns: takedowns[0]?.value, counters: counters[0]?.value };
  }

  it('counts removed and disabled notices, and nothing pending or without action', async () => {
    await seed({ action: 'removed' });
    await seed({ action: 'disabled' });
    await seed({ action: 'pending' });
    await seed({ action: 'no_action' });
    await seed({ action: 'removed', accountId: OTHER });
    await seed({ action: 'removed', accountId: null });
    expect(await counts()).toEqual({ takedowns: 2, counters: 0 });
  });

  it('drops a takedown restored after a counter-notice, and keeps a not_restored one', async () => {
    const restored = await seed({ action: 'removed' });
    const kept = await seed({ action: 'removed' });
    await seed({
      kind: 'counter_notice',
      noticeId: restored,
      action: 'pending',
      restoreOutcome: 'restored',
    });
    await seed({
      kind: 'counter_notice',
      noticeId: kept,
      action: 'pending',
      restoreOutcome: 'not_restored',
    });
    expect(await counts()).toEqual({ takedowns: 1, counters: 2 });
    // The kept one is the not-restored takedown, by id.
    const rows = await t.db
      .select({ id: dmcaNotices.id })
      .from(dmcaNotices)
      .where(takedownCountWhere(ACCOUNT));
    expect(rows).toEqual([{ id: kept }]);
  });

  it('a restore on one notice never clears another', async () => {
    const a = await seed({ action: 'removed' });
    await seed({ action: 'removed' });
    // A restored counter-notice from ANOTHER account, on notice a.
    await seed({
      kind: 'counter_notice',
      noticeId: a,
      accountId: OTHER,
      action: 'pending',
      restoreOutcome: 'restored',
    });
    expect((await counts()).takedowns).toBe(1);
  });

  it('counts counter-notices by the account that filed them', async () => {
    const notice = await seed({ accountId: OTHER });
    await seed({ kind: 'counter_notice', noticeId: notice, action: 'pending' });
    const [row] = await t.db
      .select({ value: count() })
      .from(dmcaNotices)
      .where(counterNoticeCountWhere(ACCOUNT));
    expect(row?.value).toBe(1);
    expect(await counts(OTHER)).toEqual({ takedowns: 1, counters: 0 });
  });
});

describe('readRestoresDue (AECI-1944)', () => {
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  // Received Fri 20 Nov 2026: the window is 7 Dec to 11 Dec (see restoreClock above).
  const OPEN = new Date('2026-12-08T12:00:00.000Z');
  let n = 0;
  async function seed(over: Partial<DmcaNoticeRow>): Promise<string> {
    n += 1;
    const id = `00000000-0000-4000-8000-0000000002${String(n).padStart(2, '0')}`;
    await t.db.insert(dmcaNotices).values({
      id,
      kind: 'counter_notice',
      noticeId: '00000000-0000-4000-8000-000000000200',
      receivedAt: '2026-11-20T15:00:00.000Z',
      forwardedAt: '2026-11-20T16:00:00.000Z',
      action: 'pending',
      createdBy: 'admin',
      updatedBy: 'admin',
      ...over,
    });
    return id;
  }

  it('lists overdue, window-open and unforwarded counter-notices, most urgent first', async () => {
    const open = await seed({});
    const overdue = await seed({ receivedAt: '2026-11-02T15:00:00.000Z' });
    const unforwarded = await seed({ forwardedAt: null, receivedAt: '2026-12-07T15:00:00.000Z' });
    // Waiting: forwarded, and day 10 has not started.
    await seed({ receivedAt: '2026-12-01T15:00:00.000Z' });
    await seed({ restoreOutcome: 'restored' });
    await seed({ restoreOutcome: 'not_restored' });
    await seed({ courtActionAt: '2026-12-01T12:00:00.000Z' });
    await seed({ kind: 'notice', noticeId: null, action: 'removed', contentIdentified: 'x' });

    const due = await readRestoresDue(t.db, OPEN);
    expect(due.map((d) => [d.id, d.clock.state])).toEqual([
      [overdue, 'overdue'],
      [open, 'restore_window_open'],
      [unforwarded, 'awaiting_forward'],
    ]);
    expect(countRestoresDue(due)).toEqual({ overdue: 1, window_open: 1, awaiting_forward: 1 });
  });

  it('counts an unforwarded counter-notice past business day 14 as overdue, once', async () => {
    const unsentLate = await seed({ forwardedAt: null, receivedAt: '2026-11-02T15:00:00.000Z' });
    const open = await seed({});
    const unsent = await seed({ forwardedAt: null, receivedAt: '2026-12-07T15:00:00.000Z' });
    const due = await readRestoresDue(t.db, OPEN);
    // Past the deadline sorts first, whatever the state.
    expect(due.map((d) => [d.id, d.clock.state, d.pastDeadline])).toEqual([
      [unsentLate, 'awaiting_forward', true],
      [open, 'restore_window_open', false],
      [unsent, 'awaiting_forward', false],
    ]);
    expect(countRestoresDue(due)).toEqual({ overdue: 1, window_open: 1, awaiting_forward: 1 });
  });

  it('is empty on an empty log', async () => {
    expect(await readRestoresDue(t.db, OPEN)).toEqual([]);
  });
});
