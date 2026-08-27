import { describe, expect, it } from 'vitest';

import { mapWithConcurrency, WORKER_CONNECTION_LIMIT } from './concurrency';

describe('mapWithConcurrency', () => {
  it('never exceeds the requested width', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency(
      Array.from({ length: 25 }, (_, i) => i),
      6,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
      },
    );

    expect(peak).toBeLessThanOrEqual(6);
  });

  it('returns results in input order, not completion order', async () => {
    const results = await mapWithConcurrency([30, 1, 20, 2], 4, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });

    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([30, 1, 20, 2]);
  });

  it('reports a rejection as a settled result instead of rejecting', async () => {
    const results = await mapWithConcurrency([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    });

    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  });

  it('passes the original index through, across wave boundaries', async () => {
    const seen: number[] = [];

    await mapWithConcurrency(['a', 'b', 'c', 'd', 'e'], 2, async (_item, index) => {
      seen.push(index);
    });

    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it('handles an empty list and coerces a nonsense width to 1', async () => {
    expect(await mapWithConcurrency([], 6, async () => 1)).toEqual([]);
    const results = await mapWithConcurrency([1, 2], 0, async (n) => n);
    expect(results.map((r) => (r.status === 'fulfilled' ? r.value : null))).toEqual([1, 2]);
  });

  it('pins the Cloudflare per-invocation connection limit', () => {
    expect(WORKER_CONNECTION_LIMIT).toBe(6);
  });
});
