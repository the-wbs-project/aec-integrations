/**
 * The AECI-1444 backfill script's core: the argv gates, the first message, and the
 * one publish.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  backfillDayCount,
  parseTrafficBackfillArgs,
  planTrafficBackfill,
  publishTrafficBackfill,
} from './backfill-traffic-classifications';

const NOW = new Date('2026-10-27T09:00:00.000Z');

describe('parseTrafficBackfillArgs', () => {
  const range = ['--from', '2026-06-20', '--through', '2026-10-23'];

  it('is a dry run on staging by default', () => {
    expect(parseTrafficBackfillArgs(['--env', 'staging', ...range])).toEqual({
      ok: true,
      env: 'staging',
      queue: 'aeci-traffic-classify-staging',
      from: '2026-06-20',
      through: '2026-10-23',
      apply: false,
    });
  });

  it('needs an env, and has no --local', () => {
    expect(parseTrafficBackfillArgs(range).ok).toBe(false);
    expect(parseTrafficBackfillArgs(['--local', ...range]).ok).toBe(false);
  });

  it('needs both ends of the range', () => {
    expect(parseTrafficBackfillArgs(['--env', 'staging', '--from', '2026-06-20']).ok).toBe(false);
  });

  it('refuses --apply on production without --allow-production', () => {
    const args = parseTrafficBackfillArgs([
      '--env',
      'production',
      ...range,
      '--apply',
      '--queue-id',
      'q',
    ]);
    expect(args).toMatchObject({ ok: false, error: expect.stringMatching(/PRODUCTION/) });
    expect(
      parseTrafficBackfillArgs([
        '--env',
        'production',
        ...range,
        '--apply',
        '--allow-production',
        '--queue-id',
        'q',
      ]),
    ).toMatchObject({ ok: true, apply: true, queueId: 'q' });
  });

  it('refuses --apply without --queue-id, naming the wrangler command', () => {
    expect(parseTrafficBackfillArgs(['--env', 'demo', ...range, '--apply'])).toMatchObject({
      ok: false,
      error: expect.stringContaining('wrangler queues info aeci-traffic-classify-demo'),
    });
  });
});

describe('planTrafficBackfill', () => {
  it('builds the first message of the chain', () => {
    expect(planTrafficBackfill({ from: '2026-06-20', through: '2026-10-23' }, NOW)).toEqual({
      ok: true,
      days: 126,
      message: {
        job: 'traffic_classify',
        trigger: 'manual',
        enqueuedAt: NOW.toISOString(),
        trafficClassify: { day: '2026-06-20', through: '2026-10-23' },
      },
    });
  });

  it('refuses what the consumer would refuse', () => {
    expect(planTrafficBackfill({ from: '2026-10-24', through: '2026-10-23' }, NOW)).toEqual({
      ok: false,
      refusal: 'day_after_through',
    });
    expect(planTrafficBackfill({ from: '2026-10-20', through: '2026-10-27' }, NOW)).toEqual({
      ok: false,
      refusal: 'evidence_open',
    });
  });

  it('counts both ends', () => {
    expect(backfillDayCount('2026-10-01', '2026-10-01')).toBe(1);
    expect(backfillDayCount('2026-10-01', '2026-11-01')).toBe(32);
  });
});

describe('publishTrafficBackfill', () => {
  const plan = planTrafficBackfill({ from: '2026-10-01', through: '2026-10-02' }, NOW);
  const message = plan.ok ? plan.message : (undefined as never);
  const args = { accountId: 'acct', queueId: 'qid', apiToken: 'tok', message };

  it('posts the message as a JSON body to the queue', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('{"success":true}', { status: 200 }));

    expect(await publishTrafficBackfill({ ...args, fetch: fetchFn })).toEqual({
      ok: true,
      status: 200,
    });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/queues/qid/messages');
    expect(JSON.parse(init.body as string)).toEqual({ body: message, content_type: 'json' });
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('reports a refused publish and a network error without throwing', async () => {
    const refused = vi
      .fn()
      .mockResolvedValue(new Response('{"success":false,"errors":[1]}', { status: 200 }));
    expect(await publishTrafficBackfill({ ...args, fetch: refused })).toMatchObject({
      ok: false,
      status: 200,
    });
    const down = vi.fn().mockRejectedValue(new Error('offline'));
    expect(await publishTrafficBackfill({ ...args, fetch: down })).toEqual({
      ok: false,
      status: null,
      error: 'offline',
    });
  });
});
