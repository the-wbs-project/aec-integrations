import { describe, expect, it } from 'vitest';

import type { WebEnv } from './env';
import { shouldEmitRenderLog } from './server-render-log';

// Moved out of `server-datadog.spec.ts` by AECI-642 alongside the gate itself:
// this is web-only *policy* (what is worth logging), independent of which
// observability vendor receives the log.

function makeEnv(overrides: Partial<WebEnv> = {}): WebEnv {
  return {
    ASSETS: {} as Fetcher,
    API: {} as Fetcher,
    ENV: 'preview',
    ...overrides,
  };
}

describe('shouldEmitRenderLog (AECI-103 ssr.render log gate)', () => {
  // Errors are kept at full fidelity in every env — including production —
  // because the non-cacheable branch's 404/5xx visibility leans on this log.
  it.each<WebEnv['ENV']>(['production', 'demo'])(
    'logs error status even on the public tier %s',
    (env) => {
      for (const status of [404, 500, 503]) {
        expect(shouldEmitRenderLog(makeEnv({ ENV: env }), status)).toBe(true);
      }
    },
  );

  // Non-public tiers keep every render (dev/preview/staging volume is tiny; the
  // full stream verifies the pipe end-to-end).
  it.each<WebEnv['ENV']>(['development', 'preview', 'staging'])(
    'logs 2xx renders in non-public env %s',
    (env) => {
      expect(shouldEmitRenderLog(makeEnv({ ENV: env }), 200)).toBe(true);
    },
  );

  it('logs 2xx renders when ENV is unset (development default)', () => {
    expect(shouldEmitRenderLog(makeEnv({ ENV: undefined }), 200)).toBe(true);
  });

  // Public-tier 2xx (production + demo) is the unbounded firehose we drop — the
  // aeci.ssr.render count metric carries that signal instead.
  it.each<WebEnv['ENV']>(['production', 'demo'])(
    'drops non-error 2xx/3xx on the public tier %s',
    (env) => {
      for (const status of [200, 204, 301, 304]) {
        expect(shouldEmitRenderLog(makeEnv({ ENV: env }), status)).toBe(false);
      }
    },
  );
});
