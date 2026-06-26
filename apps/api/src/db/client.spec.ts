/**
 * `getDb` D1 Sessions API wiring (AECI-250).
 *
 * The in-memory harness (`test/d1.ts`) has no real D1 session, so these unit-test
 * the behavioural contract against stub bindings: the anchor selection
 * (read-default `'first-unconstrained'`, write `'first-primary'`, bookmark
 * precedence), the `getBookmark()` proxy, and the `withSession`-less fallback.
 * The runtime-shape cast `drizzle(session as unknown as D1Database)` is a contract
 * against real D1 (validated in prod, not over better-sqlite3); here we assert the
 * Drizzle client still constructs into a usable shape over a session-like client.
 */

import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../env';
import { getDb } from './client';

function stubSession(bookmark: string | null) {
  return {
    prepare: vi.fn(),
    batch: vi.fn(),
    getBookmark: vi.fn(() => bookmark),
  };
}

function envWithSession(session: ReturnType<typeof stubSession>) {
  const withSession = vi.fn((_anchor?: string) => session);
  const env = {
    DATABASE_URL: 'prisma://test',
    ENV: 'preview',
    DB: { withSession },
  } as unknown as Env;
  return { env, withSession };
}

describe('getDb (AECI-250 Sessions API)', () => {
  it('throws loudly when the DB binding is missing', () => {
    expect(() => getDb({ DATABASE_URL: 'x', ENV: 'preview' } as unknown as Env)).toThrow(/DB/);
  });

  it('defaults reads to the first-unconstrained anchor and proxies getBookmark()', () => {
    const { env, withSession } = envWithSession(stubSession('bk-out'));
    const ctx = getDb(env);
    expect(withSession).toHaveBeenCalledWith('first-unconstrained');
    expect(ctx.getBookmark()).toBe('bk-out');
    // The cast holds: Drizzle still builds a usable relational-query client.
    expect(typeof ctx.db.query).toBe('object');
  });

  it('anchors first-primary for write paths', () => {
    const { env, withSession } = envWithSession(stubSession(null));
    getDb(env, { constraint: 'first-primary' });
    expect(withSession).toHaveBeenCalledWith('first-primary');
  });

  it('resumes the inbound bookmark, which takes precedence over the constraint', () => {
    const { env, withSession } = envWithSession(stubSession(null));
    getDb(env, { bookmark: 'bk-99', constraint: 'first-primary' });
    expect(withSession).toHaveBeenCalledWith('bk-99');
  });

  it('falls back to the plain binding (getBookmark null) when withSession is absent', () => {
    const env = {
      DATABASE_URL: 'prisma://test',
      ENV: 'preview',
      DB: { prepare: vi.fn(), batch: vi.fn() },
    } as unknown as Env;
    const ctx = getDb(env, { constraint: 'first-primary', bookmark: 'bk-1' });
    expect(ctx.getBookmark()).toBeNull();
    expect(typeof ctx.db.query).toBe('object');
  });
});
