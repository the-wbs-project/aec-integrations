import type { Context } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { reportMissingVendors, validateResponseInDev } from './handler-utils';

function envWith(env: Env['ENV']): Env {
  return { ENV: env };
}

describe('validateResponseInDev (AECI-111 — hoisted from route handlers)', () => {
  it('runs the validator when ENV is "preview"', () => {
    const validate = vi.fn();
    validateResponseInDev(envWith('preview'), validate);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('runs the validator when ENV is "staging"', () => {
    const validate = vi.fn();
    validateResponseInDev(envWith('staging'), validate);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('runs the validator when ENV is absent (local dev — undefined !== "production")', () => {
    // Guards the latent behaviour the AECI-111 audit flagged: local validation
    // runs because ENV is *absent*, not because of a 'development' member. The
    // gate is intentionally moved verbatim — the Env.ENV cleanup is a separate issue.
    const validate = vi.fn();
    validateResponseInDev({}, validate);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('skips the validator when ENV is "production" (per-request Zod cost stripped)', () => {
    const validate = vi.fn();
    validateResponseInDev(envWith('production'), validate);
    expect(validate).not.toHaveBeenCalled();
  });

  it('skips the validator when ENV is "demo" (public tier, same as production)', () => {
    const validate = vi.fn();
    validateResponseInDev(envWith('demo'), validate);
    expect(validate).not.toHaveBeenCalled();
  });

  it('propagates a throw from the validator in non-production (mapper drift fails loudly)', () => {
    const boom = () => {
      throw new Error('shape drift');
    };
    expect(() => validateResponseInDev(envWith('preview'), boom)).toThrow('shape drift');
  });
});

describe('reportMissingVendors (AECI-115 — data-gap observability)', () => {
  const withVendor = {
    id: 'p1',
    slug: 'procore',
    vendor: { id: 'v1', slug: 'procore', name: 'Procore', logo_url: null },
  };
  const noVendor = { id: 'p2', slug: 'revizto', vendor: null };

  function ctxWith(env: Partial<Env>) {
    const waitUntil = vi.fn();
    const c = {
      executionCtx: { waitUntil },
      env: { ...env } as Env,
      req: { raw: new Request('https://api.test/api/products') },
    } as unknown as Context<{ Bindings: Env }>;
    return { c, waitUntil };
  }

  it('does nothing when every product has a vendor', () => {
    const { c, waitUntil } = ctxWith({ POSTHOG_PROJECT_KEY: 'phc_test_token' });
    reportMissingVendors(c, [withVendor, withVendor]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('emits one warn log per gap + one count metric when a vendor is missing (DD configured)', () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 202 }));
    const { c, waitUntil } = ctxWith({ POSTHOG_PROJECT_KEY: 'phc_test_token' });

    reportMissingVendors(c, [withVendor, noVendor]);

    // 1 missing product → 1 logToPosthog dispatch + 1 submitCount dispatch.
    expect(waitUntil).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
  });

  it('no-ops without POSTHOG_PROJECT_KEY (clean local dev)', () => {
    const { c, waitUntil } = ctxWith({});
    reportMissingVendors(c, [noVendor]);
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('never throws when executionCtx is unavailable (non-Worker harness) — empty state, not a 500', () => {
    const c = {
      get executionCtx(): ExecutionContext {
        throw new Error('This context has no ExecutionContext');
      },
      env: { POSTHOG_PROJECT_KEY: 'phc_test_token' } as Env,
      req: { raw: new Request('https://api.test/api/products') },
    } as unknown as Context<{ Bindings: Env }>;
    // A legitimately vendorless product must not break the request path even
    // when the runtime has no ExecutionContext to dispatch the emit onto.
    expect(() => reportMissingVendors(c, [noVendor])).not.toThrow();
  });
});
