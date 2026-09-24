/**
 * The racing factory must intercept exactly one batch per request and never leak
 * its wrapper into the shared test client (AECI-1111). The old in-place pattern
 * (`ctx.db.batch = …` on the shared `t.db`) fails every assertion below: request
 * two ran the injection twice, and a plain `t.factory` request ran it once.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { vendors } from '../db/schema';
import type { Env } from '../env';
import { makeTestDb, type TestDb } from './d1';
import { TEST_ENV } from './helpers';
import { racingFactory, wrappedFactory } from './racing-factory';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

const env = TEST_ENV as Env;
const insertVendor = (db: TestDb['db'], n: number) =>
  db.batch([
    db.insert(vendors).values({
      id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
      slug: `v${n}`,
      companyName: `V${n}`,
    }),
  ]);

describe('racingFactory', () => {
  it('runs the injection once per request, however many requests it serves', async () => {
    const seen: number[] = [];
    const racing = racingFactory(t.factory, (attempt) => {
      seen.push(attempt);
    });
    for (let n = 1; n <= 3; n += 1) await insertVendor(racing(env).db, n);
    // One interception per batch. A stacked wrapper would record [1, 2, 3, 4, 5, 6].
    expect(seen).toEqual([1, 2, 3]);
    expect(await t.db.select().from(vendors)).toHaveLength(3);
  });

  it('leaves the shared client untouched, so a plain request sees no injection', async () => {
    const shared = t.db.batch;
    let injections = 0;
    const racing = racingFactory(t.factory, () => {
      injections += 1;
    });
    await insertVendor(racing(env).db, 1);
    // Compared as booleans: a failed identity check on a Drizzle client makes
    // vitest pretty-print the whole client, which runs the worker out of memory.
    expect(t.db.batch === shared).toBe(true);
    await insertVendor(t.factory(env).db, 2);
    expect(injections).toBe(1);
  });

  it('hands each request its own db, with the real reads still reachable', async () => {
    const racing = racingFactory(t.factory, () => {});
    const a = racing(env).db;
    const b = racing(env).db;
    expect(a === b).toBe(false);
    expect(a === t.db).toBe(false);
    await insertVendor(a, 1);
    expect(await b.select().from(vendors)).toHaveLength(1);
  });

  it('awaits an async injection before the batch runs', async () => {
    const order: string[] = [];
    const racing = wrappedFactory(t.factory, async (_attempt, run) => {
      await Promise.resolve();
      order.push('before');
      const out = await run();
      order.push('after');
      return out;
    });
    await insertVendor(racing(env).db, 1);
    expect(order).toEqual(['before', 'after']);
  });

  it('passes the statements the handler sent to the wrapper', async () => {
    const sent: string[] = [];
    const racing = wrappedFactory(t.factory, (_attempt, run, stmts) => {
      for (const s of stmts as unknown as Array<{ toSQL(): { sql: string } }>) {
        sent.push(s.toSQL().sql);
      }
      return run();
    });
    await insertVendor(racing(env).db, 1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatch(/^insert into "vendors"/);
  });
});
