import { describe, expect, it, vi } from 'vitest';

import { purgeEnvCache } from './cache-purge';
import type { Env } from './env';

type PurgeQueue = NonNullable<Env['CACHE_PURGE_QUEUE_STAGING']>;

describe('purgeEnvCache', () => {
  it('enqueues a purgeEverything datatool message and reports enqueued', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const outcome = await purgeEnvCache({ send } as unknown as PurgeQueue);
    expect(outcome).toEqual({ ok: true, enqueued: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ purgeEverything: true, source: 'datatool' });
  });

  it('gracefully skips (no throw) when no queue is bound', async () => {
    const outcome = await purgeEnvCache(undefined);
    expect(outcome).toEqual({
      ok: false,
      enqueued: false,
      message: 'cache_purge_queue_unconfigured',
    });
  });

  it('never throws when queue.send() rejects — returns the failure outcome', async () => {
    const send = vi.fn().mockRejectedValue(new Error('queue overloaded'));
    const outcome = await purgeEnvCache({ send } as unknown as PurgeQueue);
    expect(outcome.ok).toBe(false);
    expect(outcome.enqueued).toBe(false);
    expect(outcome.message).toBe('queue overloaded');
  });
});
