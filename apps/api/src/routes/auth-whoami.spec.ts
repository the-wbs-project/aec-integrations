/**
 * Unit coverage for the THROWAWAY(AECI-193) `/api/auth/whoami` handler in
 * isolation: given the `user` Variable that `requireUserAuth()` sets, it echoes
 * `{ userId, email }` as JSON with the non-cacheable default. The
 * middleware→handler integration is covered in `lib/user-auth.spec.ts`.
 */

import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { Env } from '../env';
import type { UserAuthVariables } from '../lib/user-auth';
import { createAuthWhoamiHandler } from './auth-whoami';

function appWithUser(user: UserAuthVariables['user']) {
  const app = new Hono<{ Bindings: Env; Variables: UserAuthVariables }>();
  app.use('/api/auth/whoami', async (c, next) => {
    c.set('user', user);
    await next();
  });
  app.get('/api/auth/whoami', createAuthWhoamiHandler());
  return app;
}

describe('createAuthWhoamiHandler', () => {
  it('returns the resolved user with a non-cacheable header', async () => {
    const res = await appWithUser({ userId: 'u-1', email: 'u@example.com' }).request(
      '/api/auth/whoami',
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await res.json()).toEqual({ userId: 'u-1', email: 'u@example.com' });
  });

  it('omits email when undefined', async () => {
    const res = await appWithUser({ userId: 'u-2' }).request('/api/auth/whoami');
    expect(await res.json()).toEqual({ userId: 'u-2' });
  });
});
