/**
 * Unit coverage for `scoreToxicity()` (AECI-258, supersedes the AECI-198 /
 * Phase 5.7 Perspective path).
 *
 * The contract under test: the call NEVER throws and fails open to `null` for
 * every failure mode (absent key, non-2xx, network error, timeout, malformed /
 * unparseable payload), and maps the model's reply to a clamped 0–100 integer.
 * Global `fetch` is stubbed; `DD_API_KEY` is unset so the `warn` path is a no-op.
 */

import type { Context } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { submitCount, submitDistribution } from '../posthog';
import type { Env } from '../env';
import { scoreToxicity } from './toxicity';

// AECI-206 / AECI-258: the `aeci.toxicity.api*` observability pair rides the
// shared transport; mock it so we can assert the per-branch outcome/latency. The
// file also imports `logToPosthog` (the `warn` path).
vi.mock('../posthog', () => ({
  logToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

type ScoreContext = Context<{ Bindings: Env }>;

/** The tag arrays recorded for `aeci.toxicity.api` (the outcome count) this test. */
function apiCountTags(): string[][] {
  return vi
    .mocked(submitCount)
    .mock.calls.filter((call) => call[3] === 'aeci.toxicity.api')
    .map((call) => call[5] as string[]);
}

/** The `{ value, tags }` recorded for the `aeci.toxicity.api.duration_ms` latency. */
function apiDurations(): Array<{ value: number; tags: string[] }> {
  return vi
    .mocked(submitDistribution)
    .mock.calls.filter((call) => call[3] === 'aeci.toxicity.api.duration_ms')
    .map((call) => ({ value: call[4] as number, tags: call[5] as string[] }));
}

beforeEach(() => {
  vi.mocked(submitCount).mockClear();
  vi.mocked(submitDistribution).mockClear();
});

/** Minimal context the function reads: env + the telemetry logging triple. */
function fakeContext(env: Partial<Env> = {}): ScoreContext {
  return {
    env: { DD_API_KEY: undefined, ...env } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://api.test/api/reviews', { method: 'POST' }) },
  } as unknown as ScoreContext;
}

/** An Anthropic Messages 200 response carrying the model's text reply. */
function okResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: 'end_turn',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('scoreToxicity', () => {
  it('returns the 0–100 integer for a normal 200 response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('92'));
    const score = await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'some body text');

    expect(score).toBe(92);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('https://api.anthropic.com/v1/messages');
    // Authenticates with x-api-key + the required anthropic-version header.
    const headers = init?.headers as Record<string, string>;
    expect(headers['x-api-key']).toBe('k');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    // Sends the body as the user message to Claude Haiku, with an abort signal.
    const sent = JSON.parse(String(init?.body));
    expect(sent).toMatchObject({
      model: 'claude-haiku-4-5',
      messages: [{ role: 'user', content: 'some body text' }],
    });
    expect(typeof sent.system).toBe('string');
    expect(init?.signal).toBeInstanceOf(AbortSignal);

    // AECI-206: a success emits outcome:ok + a latency point tagged outcome:ok.
    expect(apiCountTags()).toEqual([['outcome:ok']]);
    const durations = apiDurations();
    expect(durations).toHaveLength(1);
    expect(durations[0]?.tags).toEqual(['outcome:ok']);
    expect(durations[0]?.value).toBeGreaterThanOrEqual(0);
  });

  it('tolerates surrounding whitespace and clamps to the 0–100 range', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('  7  '));
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBe(7);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('150'));
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBe(100);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('-5'));
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBe(0);
  });

  it('is a silent no-op returning null when no key is configured (never calls fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await scoreToxicity(fakeContext(), 'b')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    // No-key is an intentional skip — it must NOT pollute the error-rate metric.
    expect(apiCountTags()).toEqual([]);
    expect(apiDurations()).toEqual([]);
  });

  it('returns null on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBeNull();
    expect(apiCountTags()).toEqual([['outcome:failed', 'reason:http_error']]);
    expect(apiDurations()[0]?.tags).toEqual(['outcome:failed']);
  });

  it('returns null on a network error (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    await expect(scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).resolves.toBeNull();
    expect(apiCountTags()).toEqual([['outcome:failed', 'reason:network']]);
  });

  it('returns null on a timeout (AbortError, never throws)', async () => {
    const abort = new DOMException('The operation timed out.', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    await expect(scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).resolves.toBeNull();
    expect(apiCountTags()).toEqual([['outcome:failed', 'reason:timeout']]);
  });

  it('returns null when the reply has no parseable integer', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse('not a number'));
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBeNull();
    expect(apiCountTags()).toEqual([['outcome:failed', 'reason:malformed']]);
  });

  it('returns null when the payload has no text content block', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ content: [] }), { status: 200 }),
    );
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBeNull();
    expect(apiCountTags()).toEqual([['outcome:failed', 'reason:malformed']]);
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(await scoreToxicity(fakeContext({ ANTHROPIC_API_KEY: 'k' }), 'b')).toBeNull();
    // A 200 whose body won't parse throws into the catch → counted as failed/network.
    expect(apiCountTags()).toEqual([['outcome:failed', 'reason:network']]);
  });
});
