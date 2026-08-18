/**
 * `GET /api/admin/audience` (AECI-586 / P5.1) against the in-memory D1 harness.
 *
 * Two things get more attention here than on the other panel endpoints, because
 * the AC singles them out:
 *
 * **The zero-row case is first, not last.** `mailing_list` and `feedback` are both
 * empty in production (§3), so an empty response is what an operator actually
 * sees on day one. Every figure is asserted explicitly — and in particular both
 * churn rates must be `null`, never `0`: a rate over nobody is undefined, and
 * reporting `0%` would be a clean bill of health nobody measured.
 *
 * **The fixture is hand-checked, and it contains a resubscribe.** `POST
 * /api/subscribe`'s reactivation path clears `unsubscribed_at` and keeps the
 * original `created_at` (`landing-forms.ts`, covered by `landing-forms.spec.ts`),
 * so a returning subscriber is one row that reads as never-churned. The series
 * must count them once, on their original signup day, and never as a churn — the
 * arithmetic below is worked out longhand in the comment beside the seed.
 */

import { AdminAudienceResponseSchema, type AdminAudienceResponse } from '@aeci/shared';
import { and, isNull, lt, or, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog, feedback, mailingList } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createAdminAudienceHandler } from './admin-audience';

const NOW = new Date('2026-08-11T05:00:00.000Z');
/** 10 complete UTC days, all in the past relative to NOW — so `partial_day` does
 *  not fire and the arithmetic below is stable. */
const RANGE = 'from=2026-08-01&to=2026-08-10';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

function call(query: string, env: Env = TEST_ENV) {
  return buildAppWithHandler({
    method: 'get',
    path: '/api/admin/audience',
    handler: createAdminAudienceHandler(t.factory, { now: () => NOW }),
  }).request(`/api/admin/audience?${query}`, {}, env, fakeExecutionContext());
}

async function audience(query: string, env?: Env): Promise<AdminAudienceResponse> {
  const res = await call(query, env);
  expect(res.status).toBe(200);
  return AdminAudienceResponseSchema.parse(await res.json());
}

const codes = (r: AdminAudienceResponse): string[] => r.notes.map((n) => n.code);
const day = (r: AdminAudienceResponse, d: string) => r.series.find((p) => p.day === d);

/**
 * The hand-checked fixture. Worked out longhand so a failure points at the code
 * rather than at arithmetic nobody can re-derive.
 *
 * Window is `[2026-08-01T00:00Z, 2026-08-11T00:00Z)`.
 *
 * | who   | created    | unsubscribed | in `active_at_start`?            |
 * |-------|-----------|--------------|----------------------------------|
 * | alice | 07-20     | —            | yes                              |
 * | bob   | 07-25     | 08-03        | yes (left DURING the window)     |
 * | henry | 07-28     | —            | yes                              |
 * | erin  | 07-10     | 07-15        | no (already gone before it)      |
 * | carol | 08-02     | —            | no (joined inside)               |
 * | dave  | 08-02     | 08-05        | no (joined AND left inside)      |
 * | frank | 08-04     | — (RESUB)    | no (joined inside; came back)    |
 * | grace | 08-11T02Z | —            | no (joined AFTER the window)     |
 *
 * Lifetime: 8 rows · 3 unsubscribed (bob, dave, erin) · 5 active · churn 3/8.
 * Window: active_at_start 3 · signups 3 (carol, dave, frank) · unsubscribes 2
 * (bob, dave) · net +1 · active_at_end 4 (alice, henry, carol, frank) ·
 * churn 2/3.
 */
async function seed(): Promise<void> {
  await t.db.insert(mailingList).values([
    { email: 'alice@example.com', createdAt: '2026-07-20T10:00:00.000Z' },
    {
      email: 'bob@example.com',
      createdAt: '2026-07-25T10:00:00.000Z',
      unsubscribedAt: '2026-08-03T09:00:00.000Z',
    },
    { email: 'henry@example.com', createdAt: '2026-07-28T10:00:00.000Z' },
    {
      email: 'erin@example.com',
      createdAt: '2026-07-10T10:00:00.000Z',
      unsubscribedAt: '2026-07-15T10:00:00.000Z',
    },
    {
      email: 'carol@example.com',
      createdAt: '2026-08-02T08:00:00.000Z',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch',
      country: 'ID',
      region: 'Jakarta',
      city: 'Jakarta',
      asn: 23700,
      asOrganization: 'PT Telkom Indonesia',
    },
    {
      email: 'dave@example.com',
      createdAt: '2026-08-02T09:00:00.000Z',
      unsubscribedAt: '2026-08-05T09:00:00.000Z',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch',
      country: 'US',
      region: 'California',
      city: 'San Francisco',
      asn: 7922,
      asOrganization: 'Comcast',
    },
    // The resubscribe. `unsubscribed_at` is NULL because the reactivation path
    // cleared it; `created_at` is still the ORIGINAL signup. Nothing on the row
    // records that a churn happened — which is exactly what
    // `audience_history_is_current_state` discloses.
    { email: 'frank@example.com', createdAt: '2026-08-04T08:00:00.000Z' },
    { email: 'grace@example.com', createdAt: '2026-08-11T02:00:00.000Z' },
  ]);

  await t.db.insert(feedback).values([
    { features: 'Better search', tools: 'Procore', createdAt: '2026-08-03T10:00:00.000Z' },
    { features: null, tools: 'Revit', createdAt: '2026-08-06T10:00:00.000Z' },
    { features: 'Older', tools: null, createdAt: '2026-07-01T10:00:00.000Z' },
  ]);
}

// ─── Zero rows: the state production is actually in (§3) ─────────────────────

describe('GET /api/admin/audience — empty tables', () => {
  it('reports zeros and NULL churn rates rather than 0%', async () => {
    const r = await audience(RANGE);

    expect(r.subscribers).toEqual({
      active: 0,
      unsubscribed: 0,
      total_ever: 0,
      // The whole point: undefined, not zero.
      churn_rate: null,
    });
    expect(r.window_totals).toEqual({
      signups: 0,
      unsubscribes: 0,
      net: 0,
      active_at_start: 0,
      active_at_end: 0,
      churn_rate: null,
    });
    expect(r.feedback).toEqual({ total_ever: 0, in_window: 0 });
  });

  it('still zero-fills the whole window, so a chart never infers a gap', async () => {
    const r = await audience(RANGE);

    expect(r.series).toHaveLength(10);
    expect(r.series[0]?.day).toBe('2026-08-01');
    expect(r.series.at(-1)?.day).toBe('2026-08-10');
    expect(r.series.every((p) => p.signups === 0 && p.unsubscribes === 0)).toBe(true);
    expect(r.series.every((p) => p.active_cumulative === 0)).toBe(true);
  });

  it('returns empty breakdowns rather than a fabricated bucket', async () => {
    const r = await audience(RANGE);

    expect(r.utm).toEqual({ source: [], medium: [], campaign: [] });
    expect(r.geography).toEqual({ country: [], region: [], city: [], asn: [] });
  });

  it('emits no notes — 0 of 0 signups is not incomplete, and there is no history to caveat', async () => {
    const r = await audience(RANGE);
    expect(r.notes).toEqual([]);
  });

  it('serialises no NaN, Infinity or undefined anywhere in the body', async () => {
    const res = await call(RANGE);
    const text = await res.text();
    expect(text).not.toMatch(/NaN|Infinity|undefined/);
  });
});

// ─── The hand-checked fixture ────────────────────────────────────────────────

describe('GET /api/admin/audience — populated', () => {
  beforeEach(seed);

  it('computes lifetime stocks and all-time churn exactly', async () => {
    const r = await audience(RANGE);

    expect(r.subscribers.total_ever).toBe(8);
    expect(r.subscribers.unsubscribed).toBe(3); // bob, dave, erin
    expect(r.subscribers.active).toBe(5); // alice, henry, carol, frank, grace
    expect(r.subscribers.churn_rate).toBeCloseTo(3 / 8, 10);
  });

  it("reports the lifetime `active` count the overview's tile and the snapshot cron report", async () => {
    const r = await audience(RANGE);

    // The three surfaces share `unsubscribed_at IS NULL` via `countAll`; this
    // asserts the endpoint did not quietly grow a second definition.
    const [row] = await t.db
      .select({ value: sql<number>`count(*)` })
      .from(mailingList)
      .where(isNull(mailingList.unsubscribedAt));
    expect(r.subscribers.active).toBe(Number(row?.value));
  });

  it('computes the window totals from the two timestamps', async () => {
    const r = await audience(RANGE);

    expect(r.window_totals.active_at_start).toBe(3); // alice, bob, henry
    expect(r.window_totals.signups).toBe(3); // carol, dave, frank
    expect(r.window_totals.unsubscribes).toBe(2); // bob, dave
    expect(r.window_totals.net).toBe(1);
    expect(r.window_totals.active_at_end).toBe(4); // alice, henry, carol, frank
    expect(r.window_totals.churn_rate).toBeCloseTo(2 / 3, 10);
  });

  it('balances: active_at_start + net === active_at_end, and matches an independent count', async () => {
    const r = await audience(RANGE);
    const { active_at_start, net, active_at_end } = r.window_totals;

    expect(active_at_start + net).toBe(active_at_end);

    // Independently: who was subscribed at the instant the window closed?
    const endIso = r.window.to;
    const [row] = await t.db
      .select({ value: sql<number>`count(*)` })
      .from(mailingList)
      .where(
        and(
          lt(mailingList.createdAt, endIso),
          or(isNull(mailingList.unsubscribedAt), sql`${mailingList.unsubscribedAt} >= ${endIso}`),
        ),
      );
    expect(active_at_end).toBe(Number(row?.value));
  });

  it('buckets signups and unsubscribes on their own day and carries the cumulative forward', async () => {
    const r = await audience(RANGE);

    expect(day(r, '2026-08-01')).toMatchObject({
      signups: 0,
      unsubscribes: 0,
      active_cumulative: 3,
    });
    expect(day(r, '2026-08-02')).toMatchObject({
      signups: 2,
      unsubscribes: 0,
      active_cumulative: 5,
    });
    expect(day(r, '2026-08-03')).toMatchObject({
      signups: 0,
      unsubscribes: 1,
      active_cumulative: 4,
    });
    expect(day(r, '2026-08-04')).toMatchObject({
      signups: 1,
      unsubscribes: 0,
      active_cumulative: 5,
    });
    expect(day(r, '2026-08-05')).toMatchObject({
      signups: 0,
      unsubscribes: 1,
      active_cumulative: 4,
    });
    // Quiet tail: the line holds, it does not drop to zero.
    expect(day(r, '2026-08-10')).toMatchObject({
      signups: 0,
      unsubscribes: 0,
      active_cumulative: 4,
    });
  });

  it('counts a resubscribe once, on its original day, and never as a churn', async () => {
    const r = await audience(RANGE);

    // Frank rejoined on 08-04 after an opt-out the row no longer records. He
    // appears as exactly one signup on that day…
    expect(day(r, '2026-08-04')?.signups).toBe(1);
    // …contributes no unsubscribe on any day…
    expect(r.series.reduce((n, p) => n + p.unsubscribes, 0)).toBe(2); // bob + dave only
    // …and is counted once in the lifetime figures, since `mailing_list` holds
    // one row per email ever (`mailing_list_email_key`).
    expect(r.subscribers.total_ever).toBe(8);
    expect(r.window_totals.signups).toBe(3);
  });

  it('discloses that the series reads current row state, since a resubscribe erased the churn', async () => {
    const r = await audience(RANGE);
    expect(codes(r)).toContain('audience_history_is_current_state');
  });
});

// ─── Window boundaries ───────────────────────────────────────────────────────

describe('GET /api/admin/audience — UTC boundaries', () => {
  it('places the last millisecond of a day inside it and midnight in the next', async () => {
    await t.db.insert(mailingList).values([
      { email: 'last@example.com', createdAt: '2026-08-10T23:59:59.999Z' },
      { email: 'next@example.com', createdAt: '2026-08-11T00:00:00.000Z' },
    ]);

    const r = await audience(RANGE);

    expect(day(r, '2026-08-10')?.signups).toBe(1);
    expect(r.window_totals.signups).toBe(1);
    // The midnight row exists, it is simply outside the window.
    expect(r.subscribers.total_ever).toBe(2);
    expect(r.window.from).toBe('2026-08-01T00:00:00.000Z');
    expect(r.window.to).toBe('2026-08-11T00:00:00.000Z');
    expect(r.window.days).toBe(10);
  });

  it('flags a window that reaches into the current UTC day', async () => {
    const r = await audience('from=2026-08-01&to=2026-08-11');
    expect(codes(r)).toContain('partial_day');
  });
});

// ─── Breakdowns ──────────────────────────────────────────────────────────────

describe('GET /api/admin/audience — breakdowns', () => {
  beforeEach(seed);

  it('groups UTM over signups in the window and surfaces the unattributed bucket', async () => {
    const r = await audience(RANGE);

    expect(r.utm.source).toEqual([
      { key: 'newsletter', label: 'newsletter', subscribers: 2 },
      // Frank arrived with no campaign parameters. Real signup, named bucket.
      { key: null, label: 'Unattributed', subscribers: 1 },
    ]);
    expect(r.utm.medium.map((g) => g.key)).toEqual(['email', null]);
    expect(r.utm.campaign.map((g) => g.key)).toEqual(['launch', null]);

    // Every row reconciles against the window's signup total.
    const total = r.utm.source.reduce((n, g) => n + g.subscribers, 0);
    expect(total).toBe(r.window_totals.signups);
  });

  it('reports how many signups carry no utm_source, derived from the window', async () => {
    const r = await audience(RANGE);

    const n = r.notes.find((x) => x.code === 'utm_attribution_incomplete');
    expect(n?.params).toEqual({ missing: 1, total: 3 });
  });

  it('orders named groups ahead of the NULL bucket at an equal count', async () => {
    const r = await audience(RANGE);

    // Three countries, one signup each: named first, then the key ascending,
    // then the unattributed bucket last.
    expect(r.geography.country.map((g) => g.key)).toEqual(['ID', 'US', null]);
    expect(r.geography.country.at(-1)?.label).toBe('Unknown');
  });

  it('labels an ASN from as_organization, because an ASN cannot label itself', async () => {
    const r = await audience(RANGE);

    expect(r.geography.asn).toEqual([
      { key: '7922', label: 'Comcast', subscribers: 1 },
      { key: '23700', label: 'PT Telkom Indonesia', subscribers: 1 },
      { key: null, label: 'Unknown', subscribers: 1 },
    ]);
  });

  it('falls back to AS<number> when the holder name was never captured', async () => {
    await t.db
      .update(mailingList)
      .set({ asOrganization: null })
      .where(sql`${mailingList.email} = 'carol@example.com'`);

    const r = await audience(RANGE);
    expect(r.geography.asn.find((g) => g.key === '23700')?.label).toBe('AS23700');
  });

  it('caps each breakdown at breakdown_limit and reports the limit it used', async () => {
    const r = await audience(`${RANGE}&breakdown_limit=1`);

    expect(r.breakdown_limit).toBe(1);
    expect(r.utm.source).toHaveLength(1);
    expect(r.geography.country).toHaveLength(1);
    // The cap does not distort the note: the missing count is queried, not read
    // off a truncated bucket.
    expect(r.notes.find((x) => x.code === 'utm_attribution_incomplete')?.params).toEqual({
      missing: 1,
      total: 3,
    });
  });

  it('defaults breakdown_limit to 8', async () => {
    const r = await audience(RANGE);
    expect(r.breakdown_limit).toBe(8);
  });
});

// ─── Feedback counts ─────────────────────────────────────────────────────────

describe('GET /api/admin/audience — feedback counts', () => {
  it('separates the lifetime total from the windowed one', async () => {
    await seed();
    const r = await audience(RANGE);
    expect(r.feedback).toEqual({ total_ever: 3, in_window: 2 });
  });
});

// ─── Conventions ─────────────────────────────────────────────────────────────

describe('GET /api/admin/audience — conventions', () => {
  it('400s a reversed range, an impossible date, and an over-long window', async () => {
    expect((await call('from=2026-08-10&to=2026-08-01')).status).toBe(400);
    expect((await call('from=2026-02-30&to=2026-03-01')).status).toBe(400);
    expect((await call('from=2020-01-01&to=2026-08-10')).status).toBe(400);
  });

  it('400s a missing range and an out-of-band breakdown_limit', async () => {
    expect((await call('to=2026-08-10')).status).toBe(400);
    expect((await call(`${RANGE}&breakdown_limit=0`)).status).toBe(400);
    expect((await call(`${RANGE}&breakdown_limit=51`)).status).toBe(400);
  });

  it('writes no audit_log row and is never edge-cacheable', async () => {
    const res = await call(RANGE);

    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(res.headers.get('Cache-Tag')).toBeNull();
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it('reports source as live — this endpoint never reads metrics_daily', async () => {
    const r = await audience(RANGE);
    expect(r.source).toBe('live');
    expect(r.generated_at).toBe(NOW.toISOString());
  });
});
