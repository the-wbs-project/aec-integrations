import type { CachePurgeMessage } from '@aeci/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WebEnv } from '../env';

// The Datadog transport is mocked so we can assert the `aeci.cache.purge` emission
// (the metric moved to this consumer in WC-5) without a real network dispatch.
vi.mock('../server-datadog', () => ({
  submitCount: vi.fn(),
  logToDatadog: vi.fn(),
}));

import { logToDatadog, submitCount } from '../server-datadog';
import { createCachePurgeQueueHandler } from './cache-purge-queue';

const env = { ENV: 'staging' } as unknown as WebEnv;
const handler = createCachePurgeQueueHandler();

function makeMessage(body: CachePurgeMessage) {
  return {
    id: 'msg-1',
    timestamp: new Date(0),
    attempts: 1,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]): MessageBatch<CachePurgeMessage> {
  return {
    queue: 'aeci-cache-purge-staging',
    messages,
    ackAll: vi.fn(),
    retryAll: vi.fn(),
  } as unknown as MessageBatch<CachePurgeMessage>;
}

function makeCtx(cache?: { purge: ReturnType<typeof vi.fn> }): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
    exports: {},
    cache,
  } as unknown as ExecutionContext;
}

beforeEach(() => {
  vi.mocked(submitCount).mockClear();
  vi.mocked(logToDatadog).mockClear();
});

describe('createCachePurgeQueueHandler (WC-5 / AECI-319)', () => {
  it('purges the message tags, acks, and emits outcome:ok on success', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = makeCtx({ purge });
    const msg = makeMessage({ tags: ['product:revit', 'index:products'], source: 'promote' });

    await handler(makeBatch([msg]), env, ctx);

    expect(purge).toHaveBeenCalledWith({ tags: ['product:revit', 'index:products'] });
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(submitCount).toHaveBeenCalledWith(ctx, env, expect.any(Request), 'aeci.cache.purge', 1, [
      'source:promote',
      'outcome:ok',
    ]);
  });

  it('carries the message source into the metric tag (moderation)', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = makeCtx({ purge });

    await handler(
      makeBatch([makeMessage({ tags: ['product:revit'], source: 'moderation' })]),
      env,
      ctx,
    );

    expect(submitCount).toHaveBeenCalledWith(ctx, env, expect.any(Request), 'aeci.cache.purge', 1, [
      'source:moderation',
      'outcome:ok',
    ]);
  });

  it('retries + emits outcome:purge_failed + warns when purge reports !success', async () => {
    const purge = vi
      .fn()
      .mockResolvedValue({ success: false, errors: [{ code: 10, message: 'boom' }] });
    const ctx = makeCtx({ purge });
    const msg = makeMessage({ tags: ['product:revit'], source: 'promote' });

    await handler(makeBatch([msg]), env, ctx);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(msg.ack).not.toHaveBeenCalled();
    expect(submitCount).toHaveBeenCalledWith(ctx, env, expect.any(Request), 'aeci.cache.purge', 1, [
      'source:promote',
      'outcome:purge_failed',
    ]);
    expect(logToDatadog).toHaveBeenCalledWith(
      ctx,
      env,
      expect.any(Request),
      expect.objectContaining({ level: 'warn', message: 'aeci.cache.purge.failed' }),
    );
  });

  it('retries + emits outcome:purge_failed + errors when purge throws', async () => {
    const purge = vi.fn().mockRejectedValue(new Error('cache down'));
    const ctx = makeCtx({ purge });
    const msg = makeMessage({ tags: ['product:revit'], source: 'promote' });

    await handler(makeBatch([msg]), env, ctx);

    expect(msg.retry).toHaveBeenCalledTimes(1);
    expect(submitCount).toHaveBeenCalledWith(ctx, env, expect.any(Request), 'aeci.cache.purge', 1, [
      'source:promote',
      'outcome:purge_failed',
    ]);
    expect(logToDatadog).toHaveBeenCalledWith(
      ctx,
      env,
      expect.any(Request),
      expect.objectContaining({ level: 'error', message: 'aeci.cache.purge.crashed' }),
    );
  });

  it('acks + emits outcome:no_cache when the entrypoint has no cache (demo/prod pre-WC-6/8)', async () => {
    const ctx = makeCtx(undefined); // ctx.cache is undefined
    const msg = makeMessage({ tags: ['product:revit'], source: 'promote' });

    await handler(makeBatch([msg]), env, ctx);

    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(msg.retry).not.toHaveBeenCalled();
    expect(submitCount).toHaveBeenCalledWith(ctx, env, expect.any(Request), 'aeci.cache.purge', 1, [
      'source:promote',
      'outcome:no_cache',
    ]);
  });

  it('acks a message with no purge directive as outcome:noop (never calls purge)', async () => {
    const purge = vi.fn();
    const ctx = makeCtx({ purge });
    const msg = makeMessage({ source: 'promote' });

    await handler(makeBatch([msg]), env, ctx);

    expect(purge).not.toHaveBeenCalled();
    expect(msg.ack).toHaveBeenCalledTimes(1);
    expect(submitCount).toHaveBeenCalledWith(ctx, env, expect.any(Request), 'aeci.cache.purge', 1, [
      'source:promote',
      'outcome:noop',
    ]);
  });

  it('forwards purgeEverything / pathPrefixes to ctx.cache.purge', async () => {
    const purge = vi.fn().mockResolvedValue({ success: true, errors: [] });
    const ctx = makeCtx({ purge });

    await handler(
      makeBatch([makeMessage({ purgeEverything: true, source: 'datatool' })]),
      env,
      ctx,
    );

    expect(purge).toHaveBeenCalledWith({ purgeEverything: true });
  });

  it('processes each message in a batch independently', async () => {
    const purge = vi
      .fn()
      .mockResolvedValueOnce({ success: true, errors: [] })
      .mockResolvedValueOnce({ success: false, errors: [{ code: 1, message: 'x' }] });
    const ctx = makeCtx({ purge });
    const good = makeMessage({ tags: ['product:a'], source: 'promote' });
    const bad = makeMessage({ tags: ['product:b'], source: 'promote' });

    await handler(makeBatch([good, bad]), env, ctx);

    expect(good.ack).toHaveBeenCalledTimes(1);
    expect(bad.retry).toHaveBeenCalledTimes(1);
  });
});
