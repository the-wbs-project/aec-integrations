import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ALGOLIA_LOCAL_WRITE_OPT_IN,
  algoliaWritesAllowed,
  guardAlgoliaWrite,
  resetAlgoliaWriteGuardWarning,
} from './algolia-write-guard';

describe('algoliaWritesAllowed (AECI-1268)', () => {
  it('lets every deployed tier write its own index set without an opt-in', () => {
    for (const ENV of ['staging', 'demo', 'production']) {
      expect(algoliaWritesAllowed({ ENV })).toBe(true);
    }
  });

  it('blocks a local run: ENV development or unset', () => {
    expect(algoliaWritesAllowed({ ENV: 'development' })).toBe(false);
    expect(algoliaWritesAllowed({})).toBe(false);
  });

  it('blocks a stale or unknown label, such as a leftover ENV=preview', () => {
    expect(algoliaWritesAllowed({ ENV: 'preview' })).toBe(false);
    expect(algoliaWritesAllowed({ ENV: 'Production' })).toBe(false);
    expect(algoliaWritesAllowed({ ENV: '' })).toBe(false);
  });

  it('lets a local run write only when the opt-in is exactly "true"', () => {
    expect(algoliaWritesAllowed({ ENV: 'development', ALGOLIA_ALLOW_LOCAL_WRITES: 'true' })).toBe(
      true,
    );
    expect(algoliaWritesAllowed({ ALGOLIA_ALLOW_LOCAL_WRITES: 'true' })).toBe(true);
    for (const value of ['1', 'TRUE', 'yes', '', 'false']) {
      expect(algoliaWritesAllowed({ ENV: 'development', ALGOLIA_ALLOW_LOCAL_WRITES: value })).toBe(
        false,
      );
    }
  });

  it('names the opt-in key the Worker Env declares', () => {
    expect(ALGOLIA_LOCAL_WRITE_OPT_IN).toBe('ALGOLIA_ALLOW_LOCAL_WRITES');
  });
});

describe('guardAlgoliaWrite', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAlgoliaWriteGuardWarning();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('passes a deployed tier silently', () => {
    expect(guardAlgoliaWrite({ ENV: 'staging' }, 'algolia-sync cron')).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses a local run and logs once per isolate, naming the site and the opt-in', () => {
    expect(guardAlgoliaWrite({ ENV: 'development' }, 'algolia-sync cron')).toBe(false);
    expect(guardAlgoliaWrite({}, 'promote algolia-sync hook')).toBe(false);
    expect(guardAlgoliaWrite({ ENV: 'development' }, 'owner-write search sync')).toBe(false);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('algolia-sync cron');
    expect(message).toContain('ALGOLIA_ALLOW_LOCAL_WRITES=true');
    expect(message).toContain('staging_*');
  });

  it('passes an opted-in local run silently', () => {
    expect(guardAlgoliaWrite({ ENV: 'development', ALGOLIA_ALLOW_LOCAL_WRITES: 'true' }, 'x')).toBe(
      true,
    );
    expect(warn).not.toHaveBeenCalled();
  });
});
