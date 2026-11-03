import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { snapshotOpenD1Calls, withD1QueryLog } from './d1-query-log';

function nativeStatement(result: unknown) {
  const statement = {
    bind: vi.fn(() => statement),
    first: vi.fn(() => Promise.resolve(result)),
    run: vi.fn(() => Promise.resolve(result)),
    all: vi.fn(() => Promise.resolve(result)),
    raw: vi.fn(() => Promise.resolve(result)),
  };
  return statement;
}

function sessionFor(statement: ReturnType<typeof nativeStatement>, batchResult: unknown = []) {
  return {
    prepare: vi.fn(() => statement),
    batch: vi.fn(() => Promise.resolve(batchResult)),
    getBookmark: vi.fn(() => null),
  } as unknown as D1DatabaseSession;
}

describe('withD1QueryLog', () => {
  let log: ReturnType<typeof vi.spyOn>;

  const messages = () => log.mock.calls.map((c) => (c[0] as { message: string }).message);
  const finishLine = () =>
    log.mock.calls.map((c) => c[0] as Record<string, unknown>).find((l) => 'outcome' in l);

  beforeEach(() => {
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('logs a start and a finish line, with the D1 meta, and returns the result', async () => {
    const result = {
      results: [],
      meta: { duration: 1.5, served_by_region: 'ENAM', served_by_primary: false },
    };
    const statement = nativeStatement(result);
    const session = withD1QueryLog(sessionFor(statement));

    await expect(session.prepare('select 1').bind('a').all()).resolves.toBe(result);

    expect(statement.bind).toHaveBeenCalledWith('a');
    expect(messages()[0]).toMatch(/^Starting D1 Query - \d{4}-/);
    expect(messages()[1]).toMatch(/^Finished D1 Query \d{4}-/);
    expect(finishLine()).toMatchObject({
      op: 'all',
      sql: 'select 1',
      outcome: 'ok',
      sql_duration_ms: 1.5,
      served_by_region: 'ENAM',
      served_by_primary: false,
    });
  });

  it('never logs bound values', async () => {
    const session = withD1QueryLog(sessionFor(nativeStatement(null)));

    await session.prepare('select ?').bind('secret-value').first();

    expect(JSON.stringify(log.mock.calls)).not.toContain('secret-value');
  });

  it('passes the native statements to batch, not the wrappers', async () => {
    const statement = nativeStatement(null);
    const raw = sessionFor(statement, [{ meta: { duration: 2 } }]);
    const session = withD1QueryLog(raw);

    await session.batch([session.prepare('insert a'), session.prepare('insert b')]);

    expect(raw.batch).toHaveBeenCalledWith([statement, statement]);
    expect(log.mock.calls[0]?.[0]).toMatchObject({ op: 'batch', sql: 'insert a', batch_size: 2 });
    expect(finishLine()).toMatchObject({ outcome: 'ok', sql_duration_ms: 2 });
  });

  it('logs the failure and rethrows it', async () => {
    const statement = nativeStatement(null);
    statement.run.mockRejectedValue(new Error('D1_ERROR'));
    const session = withD1QueryLog(sessionFor(statement));

    await expect(session.prepare('insert a').run()).rejects.toThrow('D1_ERROR');

    expect(finishLine()).toMatchObject({ outcome: 'error' });
    expect(snapshotOpenD1Calls().count).toBe(0);
  });

  it('reports a call still open, then forgets it once it is stale', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const statement = nativeStatement(null);
    statement.all.mockReturnValue(new Promise(() => undefined));
    const session = withD1QueryLog(sessionFor(statement));

    void session.prepare('select hung').all();

    expect(snapshotOpenD1Calls(1_009_000)).toEqual({
      count: 1,
      oldest: { op: 'all', sql: 'select hung', waitingMs: 9_000 },
    });
    expect(snapshotOpenD1Calls(1_000_000 + 5 * 60_000 + 1)).toEqual({ count: 0, oldest: null });
  });
});
