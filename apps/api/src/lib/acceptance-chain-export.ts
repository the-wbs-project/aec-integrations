/**
 * The nightly acceptance chain export (AECI-1680, ADR 0057; `DATABASE_SCHEMA.md` §9.17).
 *
 * The `acceptance-chain` cron (`0 18 * * *`) enqueues one message on `RECONCILE_QUEUE`,
 * and the consumer runs {@link runAcceptanceChainExport}. The pure parts (fingerprints,
 * diff, file shape, verify) live in `./acceptance-chain`. This file is the I/O.
 *
 * ── WRITE ORDER (the `plan-snapshot-sweep` pattern) ──────────────────────────
 * 1. Read every `agreement_acceptances` and `license_grants` row (`SELECT *`).
 * 2. Diff their fingerprints against `acceptance_chain_rows`.
 * 3. Build the next file and `head` its key. An object already there was written by an
 *    earlier attempt whose D1 batch failed: the run ADOPTS it (records it in the ledger
 *    from the stored bytes) and writes nothing. `evidence/` is under a bucket lock, which
 *    refuses an overwrite, so a retry must never need one.
 * 4. `put` with the `sha256` option and `customMetadata`, then `head` and compare.
 * 5. One `db.batch`: the `acceptance_chain_exports` row FIRST, so a second run for the
 *    same `seq` trips the primary key and rolls the batch back, then the
 *    `acceptance_chain_rows` upserts.
 * 6. Ask DigiCert for an RFC 3161 timestamp of the file's SHA-256, and store the token
 *    only once the Worker has verified its signature and pinned issuer (`./rfc3161`).
 *    Then backfill up to {@link TSA_BACKFILL_LIMIT} earlier files whose timestamp is
 *    missing.
 *
 * A file is written every night, even with no entries, so the chain shows no silent
 * gap. A failed timestamp never fails the run (Chris's ruling 2A): the file stays,
 * `tsa_status` is `failed`, the caller logs `aeci.acceptance_chain.timestamp_failed`,
 * and a later run backfills it. A late token still proves the file existed at that time.
 *
 * Both tables are log-class under ADR 0022 and the writes are EX-002 bookkeeping
 * (`CODE_REVIEW_EXEMPTIONS.md`), so no `audit_log` row. `withJobRun` writes `job_runs`.
 */

import { and, desc, eq, lt, ne, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { acceptanceChainExports, acceptanceChainRows } from '../db/schema';
import {
  ACCEPTANCE_CHAIN_SCHEMA,
  CHAIN_TABLES,
  chainKey,
  diffRows,
  fingerprintRows,
  FINGERPRINT_VERSION,
  parseChainFile,
  serializeChainFile,
  stateSha256,
  tsrKey,
  type ChainEntry,
  type ChainFile,
  type ChainTable,
  type LiveRow,
  type PriorRow,
  type RawRow,
} from './acceptance-chain';
import type { BatchStmt, BatchTuple } from './audit';
import { sha256HexBytes } from './hash';
import { requestTimestamp, type TimeStampVerifier } from './rfc3161';

/** The run heartbeat, `outcome:ok|failed|skipped`, on every run. */
export const ACCEPTANCE_CHAIN_RUN_METRIC = 'aeci.acceptance_chain.run';

/** The PostHog log source. */
export const ACCEPTANCE_CHAIN_SOURCE = 'acceptance-chain-export';

/** The log line for a failed DigiCert request. */
export const ACCEPTANCE_CHAIN_TSA_FAILED = 'aeci.acceptance_chain.timestamp_failed';

/** Earlier files whose timestamp a run retries, newest first. */
export const TSA_BACKFILL_LIMIT = 7;

/** Rows per multi-row upsert: 5 bound values each, under D1's 100-parameter cap. */
const UPSERT_CHUNK = 15;

/** The R2 calls the export makes. `R2Bucket` satisfies it, and a spec passes a fake. */
export interface ChainBucket {
  put(
    key: string,
    value: ArrayBuffer,
    options: {
      httpMetadata: { contentType: string };
      customMetadata: Record<string, string>;
      sha256: string;
    },
  ): Promise<{ size: number } | null>;
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string> } | null>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

export interface TimestampFailure {
  seq: number;
  reason: string;
}

export interface AcceptanceChainResult {
  seq: number;
  /** Entries in the file: changed rows plus tombstones. */
  entries: number;
  /** Live rows across both tables. */
  rows: number;
  /** True when an earlier attempt's file was found and recorded instead of written. */
  adopted: boolean;
  /** The DigiCert outcome for this run's file. */
  tsa: 'granted' | 'failed';
  /** Earlier files that got their token this run. */
  backfilled: number;
  /** Every DigiCert failure this run, this file's and the backfill's. */
  tsaFailures: TimestampFailure[];
}

export interface AcceptanceChainOptions {
  now: Date;
  /** The DigiCert transport. A spec stubs it. */
  fetchImpl?: typeof fetch;
  /**
   * Spec seam ONLY. Replaces the token verifier so the export's flow specs can grant a
   * digest that the one recorded DigiCert reply does not name. The cron consumer never
   * passes it, so production always verifies with `parseTimeStampResponse`.
   */
  verifyTimestamp?: TimeStampVerifier;
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

async function readLive(db: Db): Promise<LiveRow[]> {
  const live: LiveRow[] = [];
  for (const table of CHAIN_TABLES) {
    // `SELECT *` by SQL name, so the Worker and the verify CLI fingerprint the same
    // shape. Both tables are small: a pilot has hundreds of rows, not millions.
    const rows = await db.all<RawRow>(sql.raw(`SELECT * FROM "${table}"`));
    live.push(...(await fingerprintRows(table, rows)));
  }
  return live;
}

async function readPrior(db: Db): Promise<PriorRow[]> {
  const rows = await db.select().from(acceptanceChainRows);
  return rows.map((r) => ({
    table: r.tableName as ChainTable,
    id: r.rowId,
    fingerprint: r.fingerprint,
    deleted: r.deleted,
  }));
}

/** The ledger statements for one file: the export row first, then the row upserts. */
function ledgerStatements(
  db: Db,
  file: ChainFile,
  key: string,
  sha256: string,
  exportedAt: string,
) {
  const statements: BatchStmt[] = [
    db.insert(acceptanceChainExports).values({
      seq: file.seq,
      day: file.day,
      objectKey: key,
      sha256,
      prevSha256: file.prev_sha256,
      stateSha256: file.state_sha256,
      entries: file.entries.length,
      tsaStatus: 'pending',
      tsaKey: null,
      exportedAt,
    }),
  ];
  for (let i = 0; i < file.entries.length; i += UPSERT_CHUNK) {
    const chunk = file.entries.slice(i, i + UPSERT_CHUNK);
    statements.push(
      db
        .insert(acceptanceChainRows)
        .values(
          chunk.map((e: ChainEntry) => ({
            tableName: e.table,
            rowId: e.id,
            fingerprint: e.fingerprint,
            seq: file.seq,
            deleted: e.op === 'delete',
          })),
        )
        .onConflictDoUpdate({
          target: [acceptanceChainRows.tableName, acceptanceChainRows.rowId],
          set: {
            fingerprint: sql`excluded.fingerprint`,
            seq: sql`excluded.seq`,
            deleted: sql`excluded.deleted`,
          },
        }),
    );
  }
  return statements as BatchTuple;
}

/** Write the file, or adopt the one an earlier attempt left. Returns its SHA-256. */
async function writeOrAdopt(
  bucket: ChainBucket,
  file: ChainFile,
): Promise<{ sha256: string; adopted: ChainFile | null }> {
  const key = chainKey(file.seq);
  if (await bucket.head(key)) {
    const stored = await bucket.get(key);
    if (!stored) throw new Error(`adopt_vanished key=${key}`);
    const bytes = new Uint8Array(await stored.arrayBuffer());
    const adopted = parseChainFile(bytes);
    // An object that does not continue our chain is not ours to adopt: stop for an
    // operator rather than record a fork.
    if (adopted.seq !== file.seq || adopted.prev_sha256 !== file.prev_sha256) {
      throw new Error(
        `adopt_conflict key=${key} seq=${adopted.seq} prev=${adopted.prev_sha256 ?? 'null'}`,
      );
    }
    return { sha256: await sha256HexBytes(bytes), adopted };
  }
  const bytes = serializeChainFile(file);
  const sha256 = await sha256HexBytes(bytes);
  const put = await bucket.put(key, toArrayBuffer(bytes), {
    httpMetadata: { contentType: 'application/json' },
    customMetadata: {
      schema: ACCEPTANCE_CHAIN_SCHEMA,
      seq: String(file.seq),
      sha256,
      prev_sha256: file.prev_sha256 ?? '',
    },
    sha256,
  });
  if (!put) throw new Error(`put_refused key=${key}`);
  const head = await bucket.head(key);
  if (!head || head.size !== bytes.byteLength || head.customMetadata?.sha256 !== sha256) {
    throw new Error(`head_mismatch key=${key}`);
  }
  return { sha256, adopted: null };
}

/** Get and store one DigiCert token. Never throws. */
async function timestampOne(
  db: Db,
  bucket: ChainBucket,
  seq: number,
  sha256: string,
  opts: AcceptanceChainOptions,
): Promise<TimestampFailure | null> {
  const key = tsrKey(seq);
  try {
    // A token already in R2 (an earlier run whose ledger update failed) is adopted.
    // Only a reply that `requestTimestamp` verified reaches the `put`: the bucket lock
    // makes a stored token permanent, so a rejected one must never be written.
    if (!(await bucket.head(key))) {
      const result = await requestTimestamp(sha256, {
        fetchImpl: opts.fetchImpl,
        verify: opts.verifyTimestamp,
      });
      if (!result.ok) {
        await db
          .update(acceptanceChainExports)
          .set({ tsaStatus: 'failed' })
          .where(eq(acceptanceChainExports.seq, seq));
        return { seq, reason: result.reason };
      }
      const put = await bucket.put(key, result.token, {
        httpMetadata: { contentType: 'application/timestamp-reply' },
        customMetadata: { seq: String(seq), sha256 },
        sha256: await sha256HexBytes(result.token),
      });
      if (!put) throw new Error(`put_refused key=${key}`);
    }
    await db
      .update(acceptanceChainExports)
      .set({ tsaStatus: 'granted', tsaKey: key })
      .where(eq(acceptanceChainExports.seq, seq));
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      await db
        .update(acceptanceChainExports)
        .set({ tsaStatus: 'failed' })
        .where(eq(acceptanceChainExports.seq, seq));
    } catch {
      // The row keeps its old status, and the next run's backfill retries it.
    }
    return { seq, reason };
  }
}

/** Retry the timestamp of up to {@link TSA_BACKFILL_LIMIT} earlier files, newest first.
 *  The hash comes from the stored bytes in R2, not from the ledger. */
async function backfill(
  db: Db,
  bucket: ChainBucket,
  beforeSeq: number,
  opts: AcceptanceChainOptions,
): Promise<{ backfilled: number; failures: TimestampFailure[] }> {
  const due = await db
    .select({ seq: acceptanceChainExports.seq })
    .from(acceptanceChainExports)
    .where(
      and(
        ne(acceptanceChainExports.tsaStatus, 'granted'),
        lt(acceptanceChainExports.seq, beforeSeq),
      ),
    )
    .orderBy(desc(acceptanceChainExports.seq))
    .limit(TSA_BACKFILL_LIMIT);
  let backfilled = 0;
  const failures: TimestampFailure[] = [];
  // One at a time: each holds one connection for at most the 10-second timeout.
  for (const { seq } of due) {
    const stored = await bucket.get(chainKey(seq));
    if (!stored) {
      failures.push({ seq, reason: 'file_missing' });
      continue;
    }
    const sha256 = await sha256HexBytes(new Uint8Array(await stored.arrayBuffer()));
    const failure = await timestampOne(db, bucket, seq, sha256, opts);
    if (failure) failures.push(failure);
    else backfilled += 1;
  }
  return { backfilled, failures };
}

/**
 * Run one export. Throws when D1 or R2 fails before the ledger is written, so the queue
 * retries. A DigiCert failure never throws.
 */
export async function runAcceptanceChainExport(
  db: Db,
  bucket: ChainBucket,
  opts: AcceptanceChainOptions,
): Promise<AcceptanceChainResult> {
  const live = await readLive(db);
  const prior = await readPrior(db);
  const [last] = await db
    .select()
    .from(acceptanceChainExports)
    .orderBy(desc(acceptanceChainExports.seq))
    .limit(1);

  const seq = (last?.seq ?? 0) + 1;
  const nowIso = opts.now.toISOString();
  const file: ChainFile = {
    schema: ACCEPTANCE_CHAIN_SCHEMA,
    seq,
    day: nowIso.slice(0, 10),
    created_at: nowIso,
    prev_sha256: last?.sha256 ?? null,
    fingerprint_version: FINGERPRINT_VERSION,
    entries: diffRows(live, prior),
    state_sha256: await stateSha256(live),
  };

  const { sha256, adopted } = await writeOrAdopt(bucket, file);
  const recorded = adopted ?? file;
  await db.batch(ledgerStatements(db, recorded, chainKey(seq), sha256, nowIso));

  const failure = await timestampOne(db, bucket, seq, sha256, opts);
  const { backfilled, failures } = await backfill(db, bucket, seq, opts);

  return {
    seq,
    entries: recorded.entries.length,
    rows: live.length,
    adopted: adopted !== null,
    tsa: failure ? 'failed' : 'granted',
    backfilled,
    tsaFailures: failure ? [failure, ...failures] : failures,
  };
}
