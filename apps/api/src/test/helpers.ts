/**
 * Shared scaffolding for Phase 2.8 route specs (AECI-54). Each spec builds a
 * Hono sub-app, mounts the handler under test, applies `errorMiddleware()`,
 * and uses `fakeExecutionContext()` for the `c.executionCtx` slot.
 */

import { Hono } from 'hono';
import { vi } from 'vitest';

import type { Env } from '../env';
import { errorHandler } from '../errors';

export function fakeExecutionContext(): ExecutionContext {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}

/** Default env for spec runs. `ENV` is `'preview'` so dev-only response
 *  validation runs — drift in mappers fails loudly in tests. */
export const TEST_ENV: Env = {
  ENV: 'preview',
};

/** Build a Hono app with the supplied handler factory wired under the given
 *  path. The Phase 2.8 `errorHandler` is always installed so 4xx/5xx
 *  responses come back in the canonical envelope. */
export function buildAppWithHandler(args: {
  method: 'get' | 'post';
  path: string;
  handler: (c: import('hono').Context<{ Bindings: Env }>) => Promise<Response>;
}): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError(errorHandler());
  if (args.method === 'get') {
    app.get(args.path, args.handler);
  } else {
    app.post(args.path, args.handler);
  }
  return app;
}
