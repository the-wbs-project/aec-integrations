import { describe, expect, it } from 'vitest';

import { EnvironmentSchema, VersionResponseSchema } from './version';

describe('EnvironmentSchema', () => {
  it.each(['development', 'preview', 'staging', 'demo', 'production'])(
    'accepts the fixed literal %s',
    (env) => {
      expect(EnvironmentSchema.parse(env)).toBe(env);
    },
  );

  it('accepts the preview-pr-N shape reserved for per-PR CI deploys', () => {
    // Guards: AECI-71 composes ENV=preview + PR number into preview-pr-<n>.
    expect(EnvironmentSchema.parse('preview-pr-123')).toBe('preview-pr-123');
  });

  it('rejects a preview-pr value without a numeric suffix', () => {
    expect(EnvironmentSchema.safeParse('preview-pr-').success).toBe(false);
    expect(EnvironmentSchema.safeParse('preview-pr-abc').success).toBe(false);
  });

  it('rejects an unrelated environment label', () => {
    expect(EnvironmentSchema.safeParse('qa').success).toBe(false);
  });
});

describe('VersionResponseSchema', () => {
  it('parses a well-formed version payload', () => {
    // Guards: the GET /api/version contract used by promote-to-prod to verify
    // staging is at the commit being promoted.
    const parsed = VersionResponseSchema.parse({
      sha: 'a1b2c3d',
      deployedAt: '2026-05-29T03:00:00.000Z',
      environment: 'staging',
    });
    expect(parsed.sha).toBe('a1b2c3d');
    expect(parsed.environment).toBe('staging');
  });

  it('rejects an empty sha (the "unknown"/unset placeholder must not validate as a real build)', () => {
    const result = VersionResponseSchema.safeParse({
      sha: '',
      deployedAt: '2026-05-29T03:00:00.000Z',
      environment: 'staging',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-ISO deployedAt', () => {
    const result = VersionResponseSchema.safeParse({
      sha: 'a1b2c3d',
      deployedAt: 'last tuesday',
      environment: 'staging',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown environment value', () => {
    const result = VersionResponseSchema.safeParse({
      sha: 'a1b2c3d',
      deployedAt: '2026-05-29T03:00:00.000Z',
      environment: 'qa',
    });
    expect(result.success).toBe(false);
  });
});
