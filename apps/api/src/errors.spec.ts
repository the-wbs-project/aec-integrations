/**
 * `errorHandler()` — the canonical `docs/API_CONTRACTS.md` §3.3 envelope plus the
 * `logClientErrors` observability opt-in used by the review-app promote endpoint
 * (`docs/REVIEW_APP_PROMOTE_API.md` §6). The Datadog transport is mocked so we can
 * assert exactly which errors are logged, at which level, with which detail.
 */

import { ApiErrorCode } from '@aeci/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { logToPosthog } from './posthog';
import type { Env } from './env';
import { ApiError, errorHandler } from './errors';
import { fakeExecutionContext } from './test/helpers';

vi.mock('./posthog', () => ({
  logToPosthog: vi.fn(),
  logBatchToPosthog: vi.fn(),
  submitCount: vi.fn(),
  submitDistribution: vi.fn(),
  submitGauge: vi.fn(),
}));

const ENV: Env = { ENV: 'preview' };

/** Build an app whose single route throws `err`, wired to `errorHandler(opts)`. */
function appThatThrows(err: unknown, opts?: Parameters<typeof errorHandler>[0]) {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler(opts));
  app.get('/boom', () => {
    throw err;
  });
  return app;
}

function request(app: Hono<{ Bindings: Env }>) {
  return app.request('/boom', {}, ENV, fakeExecutionContext());
}

/** The single `logToPosthog` event payload (4th arg) of the most recent call. */
function lastLogEvent(): Record<string, unknown> {
  const calls = vi.mocked(logToPosthog).mock.calls;
  return calls[calls.length - 1]![3] as Record<string, unknown>;
}

beforeEach(() => {
  vi.mocked(logToPosthog).mockClear();
});

describe('errorHandler — default (client errors are silent)', () => {
  it('renders an ApiError envelope without logging a 4xx to Datadog', async () => {
    const res = await request(
      appThatThrows(new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'bad input', { field: 'x' })),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string }; trace_id: string };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.trace_id).toBeTruthy();
    expect(logToPosthog).not.toHaveBeenCalled();
  });

  it('still logs an unknown error as a 500 (existing behavior)', async () => {
    const res = await request(appThatThrows(new Error('kaboom')));

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('INTERNAL_ERROR');
    expect(logToPosthog).toHaveBeenCalledTimes(1);
    expect(lastLogEvent()).toMatchObject({ level: 'error', message: 'Unhandled error: kaboom' });
  });

  it("surfaces a D1-style error's `cause` chain in the 500 log (the real SQLite reason)", async () => {
    // A D1 batch rejection wraps the underlying SQLite failure as `err.cause`; the
    // bare `.message` drops it, so the log must flatten the chain to be diagnosable.
    const d1Err = new Error('D1_ERROR: batch failed', {
      cause: new Error('SQLITE_CONSTRAINT: UNIQUE constraint failed: products.slug'),
    });
    const res = await request(appThatThrows(d1Err));

    expect(res.status).toBe(500);
    const event = lastLogEvent();
    expect(event).toMatchObject({
      level: 'error',
      message: 'Unhandled error: D1_ERROR: batch failed',
    });
    expect(String(event.cause)).toContain(
      'SQLITE_CONSTRAINT: UNIQUE constraint failed: products.slug',
    );
  });

  it('omits `cause` when the error has none', async () => {
    await request(appThatThrows(new Error('plain')));
    expect(lastLogEvent()).not.toHaveProperty('cause');
  });
});

describe('errorHandler — logClientErrors (review-app-promote observability)', () => {
  const opts = { logClientErrors: true, source: 'review-app-promote' } as const;

  it('logs a 4xx ApiError at warn with code/field/details + the response trace_id', async () => {
    const res = await request(
      appThatThrows(
        new ApiError(400, ApiErrorCode.VALIDATION_FAILED, 'duplicate ref', {
          field: 'vendors.0.ref',
          details: { hint: 'refs must be unique' },
        }),
        opts,
      ),
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { trace_id: string };
    expect(logToPosthog).toHaveBeenCalledTimes(1);
    expect(lastLogEvent()).toMatchObject({
      level: 'warn',
      source: 'review-app-promote',
      code: 'VALIDATION_FAILED',
      // `http_status`, not `status` — the transport clobbers a `status` key with
      // the log level, so the numeric HTTP status is carried under `http_status`.
      http_status: 400,
      field: 'vendors.0.ref',
      details: { hint: 'refs must be unique' },
      method: 'GET',
      // The logged trace_id is the SAME one the caller receives in the envelope.
      trace_id: body.trace_id,
    });
  });

  it('logs a thrown ZodError as a 400 VALIDATION_FAILED carrying the issues', async () => {
    let zodErr: unknown;
    try {
      z.object({ name: z.string() }).parse({});
    } catch (e) {
      zodErr = e;
    }

    const res = await request(appThatThrows(zodErr, opts));

    expect(res.status).toBe(400);
    expect(logToPosthog).toHaveBeenCalledTimes(1);
    const event = lastLogEvent();
    expect(event).toMatchObject({ level: 'warn', code: 'VALIDATION_FAILED', http_status: 400 });
    expect((event.details as { issues: unknown[] }).issues.length).toBeGreaterThan(0);
  });

  it('logs a 409 SLUG_CONFLICT at warn (client-resolvable, not a server fault)', async () => {
    const res = await request(
      appThatThrows(new ApiError(409, ApiErrorCode.SLUG_CONFLICT, 'retry'), opts),
    );

    expect(res.status).toBe(409);
    expect(lastLogEvent()).toMatchObject({
      level: 'warn',
      code: 'SLUG_CONFLICT',
      http_status: 409,
    });
  });

  it('logs an ApiError-carried 5xx at error level', async () => {
    const res = await request(
      appThatThrows(new ApiError(503, ApiErrorCode.INTERNAL_ERROR, 'down'), opts),
    );

    expect(res.status).toBe(503);
    expect(lastLogEvent()).toMatchObject({ level: 'error', http_status: 503 });
  });

  it('stamps `source` onto the unknown-500 log too', async () => {
    const res = await request(appThatThrows(new Error('kaboom'), opts));

    expect(res.status).toBe(500);
    expect(logToPosthog).toHaveBeenCalledTimes(1);
    expect(lastLogEvent()).toMatchObject({
      level: 'error',
      source: 'review-app-promote',
      message: 'Unhandled error: kaboom',
    });
  });
});
