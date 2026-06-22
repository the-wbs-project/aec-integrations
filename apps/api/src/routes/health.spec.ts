/**
 * GET /api/health on the Drizzle/D1 path (ADR 0016 / AECI-253), against the
 * in-memory D1 harness.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTestDb, type TestDb } from '../test/d1';
import { buildAppWithHandler, fakeExecutionContext, TEST_ENV } from '../test/helpers';
import { createHealthHandler } from './health';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => {
  try {
    t.dispose();
  } catch {
    /* already disposed by a test */
  }
});

const app = () =>
  buildAppWithHandler({
    method: 'get',
    path: '/api/health',
    handler: createHealthHandler(t.factory),
  });

describe('GET /api/health', () => {
  it('returns ok when the DB answers SELECT 1', async () => {
    const res = await app().request('/api/health', {}, TEST_ENV, fakeExecutionContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
  });

  it('returns 500 db:error when the query throws', async () => {
    t.dispose(); // close the connection → the SELECT 1 throws
    const res = await app().request('/api/health', {}, TEST_ENV, fakeExecutionContext());
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; db: string };
    expect(body.ok).toBe(false);
    expect(body.db).toBe('error');
  });
});
