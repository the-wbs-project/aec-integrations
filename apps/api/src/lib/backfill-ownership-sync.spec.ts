import { describe, expect, it, vi } from 'vitest';

import {
  buildOwnedVendorsSql,
  parseBackfillArgs,
  planOwnershipBackfill,
  publishOwnershipMessages,
  queuePublishUrl,
} from './backfill-ownership-sync';

const V1 = '00000000-0000-4000-8000-000000000001';
const V2 = '00000000-0000-4000-8000-000000000002';
const NOW = new Date('2026-10-20T00:00:00.000Z');

describe('parseBackfillArgs (AECI-1418, ruling Q7)', () => {
  it('is a dry run by default', () => {
    const args = parseBackfillArgs(['--env', 'production']);
    expect(args).toMatchObject({ ok: true, apply: false, target: { label: 'production' } });
  });

  it('refuses production --apply without --allow-production', () => {
    const args = parseBackfillArgs(['--env', 'production', '--apply', '--queue-id', 'q']);
    expect(args.ok).toBe(false);
    expect(!args.ok && args.error).toMatch(/--allow-production/);
  });

  it('accepts production --apply with --allow-production and a queue id', () => {
    const args = parseBackfillArgs([
      '--env',
      'production',
      '--apply',
      '--allow-production',
      '--queue-id',
      'q-prod',
    ]);
    expect(args).toMatchObject({
      ok: true,
      apply: true,
      queueId: 'q-prod',
      target: { queue: 'aeci-ownership-sync-production', db: 'aeci-app-production' },
    });
  });

  it('refuses --apply without --queue-id, naming the command that finds it', () => {
    const args = parseBackfillArgs(['--env', 'staging', '--apply']);
    expect(!args.ok && args.error).toMatch(/wrangler queues info aeci-ownership-sync-staging/);
  });

  it('refuses --apply on --local and accepts a local dry run', () => {
    expect(parseBackfillArgs(['--local', '--apply']).ok).toBe(false);
    expect(parseBackfillArgs(['--local'])).toMatchObject({
      ok: true,
      target: { label: 'local', remote: false },
    });
  });

  it('refuses a missing or unknown env', () => {
    expect(parseBackfillArgs([]).ok).toBe(false);
    expect(parseBackfillArgs(['--env', 'preview']).ok).toBe(false);
  });
});

describe('buildOwnedVendorsSql', () => {
  it('reads every owned vendor, or one named vendor', () => {
    expect(buildOwnedVendorsSql()).toContain('WHERE owned_at IS NOT NULL');
    expect(buildOwnedVendorsSql(V1)).toContain(`WHERE id = '${V1}'`);
  });

  it('refuses a vendor id that is not a UUID, so nothing is interpolated', () => {
    expect(() => buildOwnedVendorsSql("x' OR 1=1 --")).toThrow(/UUID/);
  });
});

describe('planOwnershipBackfill', () => {
  it('one backfill message per vendor, deduplicated, carrying no ownership data', () => {
    const row = (id: string) => ({ id, slug: 's', company_name: 'C', owned_at: 'x' });
    expect(planOwnershipBackfill([row(V1), row(V2), row(V1)], NOW)).toEqual([
      { vendorId: V1, reason: 'backfill', enqueuedAt: NOW.toISOString() },
      { vendorId: V2, reason: 'backfill', enqueuedAt: NOW.toISOString() },
    ]);
  });
});

describe('publishOwnershipMessages', () => {
  const messages = planOwnershipBackfill(
    [
      { id: V1, slug: 'a', company_name: 'A', owned_at: 'x' },
      { id: V2, slug: 'b', company_name: 'B', owned_at: 'x' },
    ],
    NOW,
  );

  it('posts one message per vendor to the Queues publish endpoint and reports each', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"success":true}', { status: 200 }))
      .mockResolvedValueOnce(new Response('{"success":false}', { status: 403 }));
    const out = await publishOwnershipMessages({
      fetch: fetchMock as unknown as typeof fetch,
      accountId: 'acct',
      queueId: 'q1',
      apiToken: 'cf-token',
      messages,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(queuePublishUrl('acct', 'q1'));
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/queues/q1/messages');
    expect(JSON.parse(init.body as string)).toEqual({ body: messages[0], content_type: 'json' });
    expect(out.map((o) => [o.vendorId, o.ok, o.status])).toEqual([
      [V1, true, 200],
      [V2, false, 403],
    ]);
  });

  it('a thrown fetch is reported, not raised', async () => {
    const out = await publishOwnershipMessages({
      fetch: vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch,
      accountId: 'acct',
      queueId: 'q1',
      apiToken: 't',
      messages: messages.slice(0, 1),
    });
    expect(out).toEqual([{ vendorId: V1, ok: false, status: null, error: 'offline' }]);
  });
});
