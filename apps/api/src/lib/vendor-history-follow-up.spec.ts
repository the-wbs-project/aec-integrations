/**
 * AECI-1160 — the search follow-up of a history page. `reduceFollowUp` folds the
 * raw rows into one state per (change, URL, channel); `loadVendorHistoryFollowUp`
 * reads them over a real D1 and holds the vendor scope and the bound-parameter cap.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recrawlQueueCauses, recrawlSubmissionCauses, recrawlSubmissions } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

import {
  FOLLOW_UP_IDS_PER_STATEMENT,
  loadVendorHistoryFollowUp,
  reduceFollowUp,
  type FollowUpQueuedRow,
  type FollowUpSubmissionRow,
} from './vendor-history-follow-up';

const AUDIT = 'audit-1';
const URL_A = 'https://example.test/products/a';
const URL_B = 'https://example.test/integrations/a-b';

const sub = (over: Partial<FollowUpSubmissionRow>): FollowUpSubmissionRow => ({
  auditLogId: AUDIT,
  url: URL_A,
  channel: 'indexnow',
  outcome: 'accepted',
  httpStatus: 200,
  submittedAt: '2026-10-04T00:05:00.000Z',
  submissionId: 1,
  ...over,
});
const queued = (over: Partial<FollowUpQueuedRow>): FollowUpQueuedRow => ({
  auditLogId: AUDIT,
  url: URL_A,
  channel: 'indexnow',
  queuedAt: '2026-10-03T14:00:00.000Z',
  ...over,
});

describe('reduceFollowUp', () => {
  it('a queued URL with no attempt yet is queued, at the time the change queued it', () => {
    expect(reduceFollowUp([], [queued({})])).toEqual([
      {
        audit_log_id: AUDIT,
        url: URL_A,
        channel: 'indexnow',
        state: 'queued',
        at: '2026-10-03T14:00:00.000Z',
        http_status: null,
        retrying: false,
      },
    ]);
  });

  it('a refused attempt still queued is failed and retrying, with its status', () => {
    const [row] = reduceFollowUp([sub({ outcome: 'refused', httpStatus: 422 })], [queued({})]);
    expect(row).toMatchObject({ state: 'failed', http_status: 422, retrying: true });
  });

  it('a failed attempt no longer queued is failed and not retrying', () => {
    const [row] = reduceFollowUp([sub({ outcome: 'failed', httpStatus: null })], []);
    expect(row).toMatchObject({ state: 'failed', http_status: null, retrying: false });
  });

  it('retries collapse: refused twice then accepted is one submitted line', () => {
    const rows = reduceFollowUp(
      [
        sub({
          outcome: 'refused',
          httpStatus: 429,
          submittedAt: '2026-10-02T00:05:00.000Z',
          submissionId: 1,
        }),
        sub({
          outcome: 'refused',
          httpStatus: 429,
          submittedAt: '2026-10-03T00:05:00.000Z',
          submissionId: 2,
        }),
        sub({
          outcome: 'accepted',
          httpStatus: 202,
          submittedAt: '2026-10-04T00:05:00.000Z',
          submissionId: 3,
        }),
      ],
      [],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        state: 'submitted',
        at: '2026-10-04T00:05:00.000Z',
        http_status: 202,
      }),
    ]);
  });

  it('the latest failure is the one reported', () => {
    const [row] = reduceFollowUp(
      [
        sub({
          outcome: 'failed',
          httpStatus: 503,
          submittedAt: '2026-10-03T00:05:00.000Z',
          submissionId: 1,
        }),
        sub({
          outcome: 'refused',
          httpStatus: 403,
          submittedAt: '2026-10-04T00:05:00.000Z',
          submissionId: 2,
        }),
      ],
      [],
    );
    expect(row).toMatchObject({
      state: 'failed',
      http_status: 403,
      at: '2026-10-04T00:05:00.000Z',
    });
  });

  it('Google: on the worklist is queued; a recorded operator request is requested', () => {
    expect(reduceFollowUp([], [queued({ channel: 'gsc' })])).toEqual([
      expect.objectContaining({ channel: 'google', state: 'queued' }),
    ]);
    expect(
      reduceFollowUp([sub({ channel: 'gsc_manual', outcome: 'requested', httpStatus: null })], []),
    ).toEqual([
      expect.objectContaining({ channel: 'google', state: 'requested', http_status: null }),
    ]);
  });

  it('a cleared worklist row with no recorded request shows nothing, never requested', () => {
    // `not_requested` writes no submission row and sweeps the cause: nothing to read.
    expect(reduceFollowUp([], [])).toEqual([]);
  });

  it('one change, several URLs and both channels: one line each, ordered by URL then channel', () => {
    const rows = reduceFollowUp(
      [sub({ url: URL_B })],
      [
        queued({ url: URL_A }),
        queued({ url: URL_A, channel: 'gsc' }),
        queued({ url: URL_B, channel: 'gsc' }),
      ],
    );
    expect(rows.map((r) => [r.url, r.channel, r.state])).toEqual(
      [
        [URL_B, 'indexnow', 'submitted'],
        [URL_B, 'google', 'queued'],
        [URL_A, 'indexnow', 'queued'],
        [URL_A, 'google', 'queued'],
      ].sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)),
    );
  });

  it('drops rows with no audit id or an unknown channel', () => {
    expect(
      reduceFollowUp(
        [sub({ auditLogId: null }), sub({ channel: 'bing' })],
        [queued({ auditLogId: null })],
      ),
    ).toEqual([]);
  });
});

describe('loadVendorHistoryFollowUp', () => {
  const VENDOR = 'vendor-a';
  const OTHER = 'vendor-b';
  let t: TestDb;
  beforeEach(async () => {
    t = await makeTestDb();
  });
  afterEach(() => t.dispose());

  async function submission(
    url: string,
    outcome: string,
    auditLogId: string,
    vendorId: string | null,
  ) {
    const [row] = await t.db
      .insert(recrawlSubmissions)
      .values({
        url,
        channel: outcome === 'requested' ? 'gsc_manual' : 'indexnow',
        outcome,
        httpStatus: outcome === 'accepted' ? 200 : null,
        batchId: `batch-${url}-${outcome}`,
        submittedAt: '2026-10-04T00:05:00.000Z',
      })
      .returning({ id: recrawlSubmissions.id });
    await t.db.insert(recrawlSubmissionCauses).values({
      submissionId: row!.id,
      source: vendorId ? 'vendor' : 'admin',
      auditLogId,
      vendorId,
      queuedAt: '2026-10-03T14:00:00.000Z',
    });
  }

  it('reads an empty id list as nothing, without a query', async () => {
    expect(await loadVendorHistoryFollowUp(t.db, VENDOR, [])).toEqual([]);
  });

  it('joins submissions and queued causes on the audit id, scoped to the vendor', async () => {
    await submission(URL_A, 'accepted', 'a1', VENDOR);
    await submission(URL_A, 'requested', 'a1', VENDOR);
    await submission(URL_B, 'accepted', 'a1', OTHER); // another vendor's cause, same id
    await submission(URL_B, 'accepted', 'a2', null); // an AECi admin cause
    await t.db.insert(recrawlQueueCauses).values([
      {
        channel: 'indexnow',
        url: URL_B,
        source: 'vendor',
        auditLogId: 'a1',
        vendorId: VENDOR,
        queuedAt: '2026-10-04T09:00:00.000Z',
      },
      {
        channel: 'gsc',
        url: URL_B,
        source: 'vendor',
        auditLogId: 'a1',
        vendorId: OTHER,
        queuedAt: '2026-10-04T09:00:00.000Z',
      },
    ]);

    const rows = await loadVendorHistoryFollowUp(t.db, VENDOR, ['a1', 'a2']);
    expect(rows.map((r) => [r.audit_log_id, r.url, r.channel, r.state])).toEqual(
      [
        ['a1', URL_B, 'indexnow', 'queued'],
        ['a1', URL_A, 'indexnow', 'submitted'],
        ['a1', URL_A, 'google', 'requested'],
      ].sort((x, y) => (x[1]! < y[1]! ? -1 : x[1]! > y[1]! ? 1 : 0)),
    );
  });

  it('chunks the ids so no statement binds more than 100 parameters', async () => {
    const ids = Array.from({ length: FOLLOW_UP_IDS_PER_STATEMENT * 2 + 5 }, (_, i) => `id-${i}`);
    await submission(URL_A, 'accepted', ids.at(-1)!, VENDOR);
    const rows = await loadVendorHistoryFollowUp(t.db, VENDOR, ids);
    expect(rows).toEqual([
      expect.objectContaining({ audit_log_id: ids.at(-1), state: 'submitted' }),
    ]);
    expect(FOLLOW_UP_IDS_PER_STATEMENT + 1).toBeLessThanOrEqual(100);
  });
});
