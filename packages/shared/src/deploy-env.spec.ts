import { describe, expect, it } from 'vitest';

import { isPublicSite, PUBLIC_SITE_ENVS } from './deploy-env';

describe('isPublicSite', () => {
  it('is true for the two public, non-Access-gated tiers', () => {
    expect(isPublicSite('production')).toBe(true);
    expect(isPublicSite('demo')).toBe(true);
  });

  it('is false for the Access-gated / local envs', () => {
    expect(isPublicSite('staging')).toBe(false);
    expect(isPublicSite('preview')).toBe(false);
    expect(isPublicSite('development')).toBe(false);
  });

  it('is false for the unset ENV (local `wrangler dev`)', () => {
    expect(isPublicSite(undefined)).toBe(false);
    expect(isPublicSite(null)).toBe(false);
    expect(isPublicSite('')).toBe(false);
  });

  it('matches PUBLIC_SITE_ENVS exactly', () => {
    for (const env of PUBLIC_SITE_ENVS) {
      expect(isPublicSite(env)).toBe(true);
    }
    expect([...PUBLIC_SITE_ENVS].sort()).toEqual(['demo', 'production']);
  });
});
