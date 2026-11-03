// D1 query timing logs. `getDb` wraps every Sessions API session in this, so each
// statement logs a start line and a finish line to Workers Logs. A start with no
// finish, or a long gap between the two, shows a request waiting on D1 even when
// SQL itself was fast. The 2026-11-03 stall (API requests hung for 85-102 s, then
// all released within 300 ms) left no record of what they were waiting on.
//
// Bound values are never logged, only the statement text. Drizzle parameterizes its
// queries, and the text is cut to MAX_SQL_CHARS.
//
// `openCalls` is isolate-wide on purpose: `metricsMiddleware` reads it from a timer,
// with no handle on the request's `DbContext`. It holds no request data beyond the
// statement text. A cancelled request can leave a call that never settles, so a
// snapshot drops entries older than STALE_CALL_MS and `begin` caps the set.

const MAX_SQL_CHARS = 160;
const MAX_OPEN_CALLS = 256;
const STALE_CALL_MS = 5 * 60_000;

type D1Operation = 'first' | 'run' | 'all' | 'raw' | 'batch';

interface OpenCall {
  id: number;
  op: D1Operation;
  sql: string;
  startedAt: number;
}

const openCalls = new Set<OpenCall>();
let nextCallId = 0;

/** Each wrapper's real D1 statement, which native `batch()` needs, and its text. */
const wrappedStatements = new WeakMap<
  D1PreparedStatement,
  { native: D1PreparedStatement; sql: string }
>();

export interface OpenD1Calls {
  /** D1 calls still waiting in this isolate, across every request it is serving. */
  count: number;
  oldest: { op: D1Operation; sql: string; waitingMs: number } | null;
}

export function snapshotOpenD1Calls(now = Date.now()): OpenD1Calls {
  let oldest: OpenCall | null = null;
  for (const call of openCalls) {
    if (now - call.startedAt > STALE_CALL_MS) {
      openCalls.delete(call);
    } else if (!oldest || call.startedAt < oldest.startedAt) {
      oldest = call;
    }
  }
  return {
    count: openCalls.size,
    oldest: oldest ? { op: oldest.op, sql: oldest.sql, waitingMs: now - oldest.startedAt } : null,
  };
}

function begin(op: D1Operation, sql: string, batchSize?: number): OpenCall {
  const startedAt = Date.now();
  const call: OpenCall = { id: ++nextCallId, op, sql: sql.slice(0, MAX_SQL_CHARS), startedAt };
  if (openCalls.size >= MAX_OPEN_CALLS) {
    const first = openCalls.values().next().value;
    if (first) openCalls.delete(first);
  }
  openCalls.add(call);
  console.log({
    message: `Starting D1 Query - ${new Date(startedAt).toISOString()}`,
    query_id: call.id,
    op,
    sql: call.sql,
    ...(batchSize === undefined ? {} : { batch_size: batchSize }),
  });
  return call;
}

/** `run` and `all` return a result with `meta`, `batch` an array of them, `first` and `raw` none. */
function metaFields(result: unknown): Record<string, unknown> {
  const first = Array.isArray(result) ? (result as unknown[])[0] : result;
  const meta = (first as { meta?: D1Meta } | null | undefined)?.meta;
  if (!meta || typeof meta !== 'object') return {};
  return {
    sql_duration_ms: meta.duration,
    served_by_region: meta.served_by_region,
    served_by_primary: meta.served_by_primary,
  };
}

function finish(call: OpenCall, outcome: 'ok' | 'error', result?: unknown): void {
  openCalls.delete(call);
  const finishedAt = Date.now();
  console.log({
    message: `Finished D1 Query ${new Date(finishedAt).toISOString()}`,
    query_id: call.id,
    op: call.op,
    sql: call.sql,
    outcome,
    duration_ms: finishedAt - call.startedAt,
    ...metaFields(result),
  });
}

async function timed<T>(call: OpenCall, run: () => Promise<T>): Promise<T> {
  try {
    const result = await run();
    finish(call, 'ok', result);
    return result;
  } catch (error) {
    finish(call, 'error');
    throw error;
  }
}

function wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
  const wrapped = {
    bind: (...values: unknown[]) => wrapStatement(statement.bind(...values), sql),
    first: (...args: [string?]) =>
      timed(begin('first', sql), () => statement.first(...(args as [string]))),
    run: () => timed(begin('run', sql), () => statement.run()),
    all: () => timed(begin('all', sql), () => statement.all()),
    raw: (...args: [{ columnNames: true }?]) =>
      timed(begin('raw', sql), () => statement.raw(...(args as [{ columnNames: true }]))),
  } as unknown as D1PreparedStatement;
  wrappedStatements.set(wrapped, { native: statement, sql });
  return wrapped;
}

/** Drizzle reaches only `.prepare()` and `.batch()`, see the header of `client.ts`. */
export function withD1QueryLog(
  session: D1DatabaseSession,
): Pick<D1DatabaseSession, 'prepare' | 'batch'> {
  return {
    prepare: (sql) => wrapStatement(session.prepare(sql), sql),
    batch: <T = unknown>(statements: D1PreparedStatement[]) => {
      const firstSql = statements[0] ? (wrappedStatements.get(statements[0])?.sql ?? '') : '';
      return timed(begin('batch', firstSql, statements.length), () =>
        session.batch<T>(statements.map((s) => wrappedStatements.get(s)?.native ?? s)),
      );
    },
  };
}
