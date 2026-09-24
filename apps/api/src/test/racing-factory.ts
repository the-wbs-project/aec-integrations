/**
 * Race-window factories for route and promote specs (AECI-1111).
 *
 * A "racing factory" is a `DbFactory` whose `db.batch` runs something first, the
 * way a concurrent request would land between a handler's read and its batch.
 *
 * The wrapper MUST go on a fresh object per factory call. The in-memory harness's
 * `t.factory` hands every call the SAME `db`, so assigning `ctx.db.batch = …` there
 * patches the shared test client: the wrapper outlives the request, a second
 * request through the racing factory stacks a second wrapper on top of the first,
 * and even a plain `t.factory` request afterwards runs the race injection. That
 * produces phantom failures (false UNIQUE errors, a second "concurrent" write)
 * that have nothing to do with the code under test.
 *
 * These helpers return a NEW db object per call, prototype-linked to the shared
 * one, so the wrapper is visible to exactly one request and never leaks.
 */

import type { DbFactory } from '../lib/handler-utils';

type Batch = (stmts: never) => Promise<unknown>;

/**
 * A factory whose `db.batch` runs `wrap` around the real batch. `attempt` counts
 * batch calls across every request this factory serves, starting at 1, so a
 * one-shot race is `attempt === 1` and a retry loop can be driven per attempt.
 * `stmts` is what the handler sent, for specs that inspect the SQL.
 */
export function wrappedFactory(
  base: DbFactory,
  wrap: (attempt: number, run: () => Promise<unknown>, stmts: never) => Promise<unknown>,
): DbFactory {
  let attempt = 0;
  return (env, opts) => {
    const ctx = base(env, opts);
    const real = (ctx.db.batch as unknown as Batch).bind(ctx.db);
    const db = Object.create(ctx.db) as typeof ctx.db;
    (db as unknown as { batch: Batch }).batch = (stmts: never) => {
      attempt += 1;
      return wrap(attempt, () => real(stmts), stmts);
    };
    return { ...ctx, db };
  };
}

/** A factory whose `db.batch` runs `before` first, then the real batch. */
export function racingFactory(
  base: DbFactory,
  before: (attempt: number) => void | Promise<void>,
): DbFactory {
  return wrappedFactory(base, async (attempt, run) => {
    await before(attempt);
    return run();
  });
}
