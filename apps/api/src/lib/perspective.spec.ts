/**
 * Unit coverage for `scoreToxicity()` (AECI-198 / Phase 5.7).
 *
 * The contract under test: the call NEVER throws and fails open to `null` for
 * every failure mode (absent key, non-2xx, network error, timeout, malformed
 * payload), and maps Perspective's 0.0–1.0 float to a 0–100 `smallint`. Global
 * `fetch` is stubbed; `DD_API_KEY` is unset so the `warn` path is a no-op.
 */

import type { Context } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { scoreToxicity } from './perspective';

type ScoreContext = Context<{ Bindings: Env }>;

/** Minimal context the function reads: env + the Datadog logging triple. */
function fakeContext(env: Partial<Env> = {}): ScoreContext {
  return {
    env: { DD_API_KEY: undefined, ...env } as Env,
    executionCtx: { waitUntil: () => {}, passThroughOnException: () => {} },
    req: { raw: new Request('https://api.test/api/reviews', { method: 'POST' }) },
  } as unknown as ScoreContext;
}

/** A Perspective 200 response carrying `summaryScore.value`. */
function okResponse(value: number): Response {
  return new Response(
    JSON.stringify({ attributeScores: { TOXICITY: { summaryScore: { value } } } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

afterEach(() => vi.restoreAllMocks());

describe('scoreToxicity', () => {
  it('returns the 0–100 integer for a normal 200 response', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(0.92));
    const score = await scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'some body text');

    expect(score).toBe(92);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('commentanalyzer.googleapis.com');
    expect(String(url)).toContain('key=k');
    // Scores the body text, requests TOXICITY, sends an abort signal (timeout).
    // `doNotStore` keeps private/pending content out of Google's retention.
    expect(JSON.parse(String(init?.body))).toMatchObject({
      comment: { text: 'some body text' },
      requestedAttributes: { TOXICITY: {} },
      doNotStore: true,
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('rounds to the nearest integer (0.875 → 88)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(0.875));
    expect(await scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'b')).toBe(88);
  });

  it('is a silent no-op returning null when no key is configured (never calls fetch)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await scoreToxicity(fakeContext(), 'b')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null on a non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 503 }));
    expect(await scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'b')).toBeNull();
  });

  it('returns null on a network error (never throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network down'));
    await expect(scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'b')).resolves.toBeNull();
  });

  it('returns null on a timeout (AbortError, never throws)', async () => {
    const abort = new DOMException('The operation timed out.', 'AbortError');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(abort);
    await expect(scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'b')).resolves.toBeNull();
  });

  it('returns null when the payload lacks a TOXICITY summaryScore', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ attributeScores: {} }), { status: 200 }),
    );
    expect(await scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'b')).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{not json', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    expect(await scoreToxicity(fakeContext({ PERSPECTIVE_API_KEY: 'k' }), 'b')).toBeNull();
  });
});
