import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { validateResponseInDev } from './handler-utils';

function envWith(env: Env['ENV']): Env {
  return { DATABASE_URL: 'prisma://test', ENV: env };
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
    validateResponseInDev({ DATABASE_URL: 'prisma://test' }, validate);
    expect(validate).toHaveBeenCalledTimes(1);
  });

  it('skips the validator when ENV is "production" (per-request Zod cost stripped)', () => {
    const validate = vi.fn();
    validateResponseInDev(envWith('production'), validate);
    expect(validate).not.toHaveBeenCalled();
  });

  it('propagates a throw from the validator in non-production (mapper drift fails loudly)', () => {
    const boom = () => {
      throw new Error('shape drift');
    };
    expect(() => validateResponseInDev(envWith('preview'), boom)).toThrow('shape drift');
  });
});
