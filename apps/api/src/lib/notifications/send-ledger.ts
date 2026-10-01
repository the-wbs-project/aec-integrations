/**
 * The notification send ledger (AECI-1202): one `notification_sends` row per send
 * attempt per recipient. `docs/DATABASE_SCHEMA.md` §9.9 is the governing doc.
 *
 * ─── At-most-once ─────────────────────────────────────────────────────────────
 *
 *   1. {@link reserveSend} inserts a `sending` row with
 *      `INSERT … ON CONFLICT(dedupe_key) DO NOTHING RETURNING id`.
 *   2. No row back means another send holds the key. The caller writes nothing to
 *      Resend, and a `duplicate` row (key NULL) records the refusal.
 *   3. The caller sends, then {@link finalizeSend} sets `sent` plus the Resend id,
 *      `failed`, or `unknown`.
 *   4. `failed` NULLs the key, so a later retry can claim it. It means Resend
 *      answered with a non-2xx status, so the mail did not go.
 *   5. `unknown` KEEPS the key. It means the call timed out or threw after the
 *      request may have reached Resend, so the mail may have gone. Releasing the key
 *      there would let a retry send it twice.
 *   6. A crash between reserve and finalize leaves a `sending` row that still holds
 *      the key. It blocks a resend. That is the at-most-once choice: a missed mail is
 *      recoverable by hand, a double mail is not.
 *   7. **Fails open.** Every function here catches its own DB error, logs a warning
 *      and returns as if there were no ledger. A ledger outage must never stop a mail.
 *
 * A send with no `dedupeKey` stores NULL, and SQLite treats NULLs as distinct under
 * the UNIQUE index, so it never conflicts.
 *
 * ─── Audit ────────────────────────────────────────────────────────────────────
 *
 * Log-class, exempt from the §26.1 audit-in-batch invariant under ADR 0022, like
 * `page_views` and `job_runs`. Each write is its own statement, outside any
 * `db.batch`, inside its own try/catch.
 */

import { eq } from 'drizzle-orm';

import { getDb, type Db } from '../../db/client';
import { notificationSends, type NotificationSendOutcome } from '../../db/schema';
import type { Env } from '../../env';

export type { NotificationSendOutcome };

/** The thing a send is about, when the sender names one. */
export interface LedgerEntity {
  type: string;
  id: string;
}

/** The columns every ledger row carries. */
export interface LedgerRowBase {
  notificationId: string;
  /** `recipientHash()` of the bare address. Empty string when there was no recipient. */
  recipientHash: string;
  /** `tierLabel(env)`. */
  tier: string;
  entity?: LedgerEntity;
}

export interface ReserveInput extends LedgerRowBase {
  dedupeKey?: string;
}

export interface ReserveResult {
  /** The reserved row, or null when the ledger was unavailable (fail-open). */
  rowId: number | null;
  /** True when another send already holds the dedupe key. Do not send. */
  duplicate: boolean;
}

type Logger = Pick<Console, 'warn'>;

/**
 * The ledger's Drizzle client, or null when the env has no `DB` binding (unit tests
 * that build a bare env, and any caller outside a Worker). Writes anchor on the
 * primary. Never throws.
 */
export function ledgerDb(env: { DB?: unknown }): Db | null {
  if (!env.DB) return null;
  try {
    return getDb(env as Env, { constraint: 'first-primary' }).db;
  } catch {
    return null;
  }
}

/**
 * Claim the dedupe key and insert a `sending` row. See the header for the protocol.
 * A DB error fails open: `{ rowId: null, duplicate: false }`, so the caller sends.
 */
export async function reserveSend(
  db: Db | null,
  input: ReserveInput,
  logger: Logger = console,
): Promise<ReserveResult> {
  if (!db) return { rowId: null, duplicate: false };
  const dedupeKey = input.dedupeKey ?? null;
  try {
    const [row] = await db
      .insert(notificationSends)
      .values({ ...columns(input), outcome: 'sending', dedupeKey })
      .onConflictDoNothing({ target: notificationSends.dedupeKey })
      .returning({ id: notificationSends.id });
    if (row) return { rowId: row.id, duplicate: false };
  } catch (error) {
    warn(logger, 'reserve', input.notificationId, error);
    return { rowId: null, duplicate: false };
  }

  // The key is held. Record the refusal with a NULL key, or this row would collide
  // with the holder. A failure here does not change the answer: still a duplicate.
  const rowId = await recordSend(db, { ...input, outcome: 'duplicate' }, logger);
  return { rowId, duplicate: true };
}

/**
 * Settle a reserved row. `failed` also NULLs the dedupe key, releasing it for a
 * retry. `sent` and `unknown` keep it held. A null `rowId` (the reserve failed open)
 * is a no-op. Never throws.
 */
export async function finalizeSend(
  db: Db | null,
  rowId: number | null,
  result: { outcome: 'sent' | 'failed' | 'unknown'; providerMessageId?: string | null },
  logger: Logger = console,
): Promise<void> {
  if (!db || rowId === null) return;
  try {
    await db
      .update(notificationSends)
      .set({
        outcome: result.outcome,
        providerMessageId: result.providerMessageId ?? null,
        ...(result.outcome === 'failed' ? { dedupeKey: null } : {}),
      })
      .where(eq(notificationSends.id, rowId));
  } catch (error) {
    warn(logger, 'finalize', String(rowId), error);
  }
}

/**
 * Write one settled row with no reservation: `skipped`, `suppressed`, `duplicate`,
 * or a `sent`/`failed`/`unknown` send that took no dedupe key (the digests, the operator copy).
 * Never stores a dedupe key. Returns the row id, or null on a DB error. Never throws.
 */
export async function recordSend(
  db: Db | null,
  input: LedgerRowBase & {
    outcome: Exclude<NotificationSendOutcome, 'sending'>;
    providerMessageId?: string | null;
  },
  logger: Logger = console,
): Promise<number | null> {
  if (!db) return null;
  try {
    const [row] = await db
      .insert(notificationSends)
      .values({
        ...columns(input),
        outcome: input.outcome,
        providerMessageId: input.providerMessageId ?? null,
        dedupeKey: null,
      })
      .returning({ id: notificationSends.id });
    return row?.id ?? null;
  } catch (error) {
    warn(logger, 'record', input.notificationId, error);
    return null;
  }
}

/**
 * Pull the Resend message id out of a 2xx response, reading the body to the end so
 * the connection is released (AECI-666). A body that is not `{ "id": string }` gives
 * null. Never throws: a send Resend accepted stays `sent` with no id.
 */
export async function readProviderMessageId(res: Response): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await res.text());
    if (parsed && typeof parsed === 'object' && 'id' in parsed) {
      const id = (parsed as { id: unknown }).id;
      return typeof id === 'string' && id.length > 0 ? id : null;
    }
    return null;
  } catch {
    return null;
  }
}

function columns(input: LedgerRowBase) {
  return {
    notificationId: input.notificationId,
    recipientHash: input.recipientHash,
    tier: input.tier,
    entityType: input.entity?.type ?? null,
    entityId: input.entity?.id ?? null,
  };
}

function warn(logger: Logger, step: string, subject: string, error: unknown): void {
  try {
    logger.warn(
      `notification ledger: ${step} failed for ${subject}, sending anyway — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  } catch {
    // Logging must never break a send.
  }
}
