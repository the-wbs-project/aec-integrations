/**
 * The legal retention prune (AECI-1638, counsel Q23a and Q27c, ADR 0058). The Privacy
 * Policy's "Retention" section makes two promises this module keeps:
 *
 *   - **Audit record:** kept for four years after the action. The deletion pauses while we
 *     are under a legal duty to preserve records. The audit record of an agreement
 *     acceptance, a Terms of Service acceptance, an account deletion or a company deletion
 *     is kept for as long as the acceptance record it belongs to.
 *   - **Agreement acceptance records:** kept while the company has a vendor account and
 *     for six years after it ends, or for five years after a granted subscription ends, if
 *     later, or longer while a legal hold requires it. A claim never approved: six years
 *     after the claim is closed. A record with no such date: six years after the latest
 *     date we hold for it (AECI-1914).
 *
 * A queued job (`legal_retention`, enqueued from the 03:00 tick, consumed on
 * `RECONCILE_QUEUE`) runs {@link runLegalRetentionPrune} once a night. It is a separate
 * module from the 400-day `./retention-prune` on purpose: that file's §7.4 gates, its
 * `PRUNABLE` list and its queue-less posture do not change, and it still never touches
 * `audit_log` or the acceptance tables. This module is the one vehicle for both.
 *
 * ─── The hold gate comes first ───────────────────────────────────────────────
 *
 * Open `litigation_holds` rows are read before anything is planned (Chris's ruling 3 of
 * 2026-11-17):
 *
 *   - **A global hold** stops the run. It deletes nothing and reports `skipped`.
 *   - **Any open hold**, global or vendor, pauses the whole four-year `audit_log` part.
 *   - **A vendor hold** keeps that vendor's acceptance and grant rows. Other vendors are
 *     pruned as usual.
 *
 * ─── The four-year audit part ────────────────────────────────────────────────
 *
 * `audit_log` rows with `created_at` before the cutoff go, except the exempt actions of
 * ruling 2 (`AUDIT_LOG_PRUNE_EXEMPT_ACTIONS` / `_PREFIXES` in `@aeci/shared`):
 * `retention.pruned` (the acceptance chain verify reads every one with no date bound, ADR
 * 0057), `litigation_hold.*`, `agreement.*`, `terms.*` and `account.deleted`. One more is
 * exempt on a condition (AECI-1914): a `vendor.deleted` row while its vendor row is gone and
 * an acceptance or grant still names that vendor, because it dates their six years. The
 * cutoff is {@link AUDIT_LOG_RETENTION_DAYS} days before today's UTC midnight.
 *
 * The primary key is a UUID, not monotonic, so the chunks page the `(created_at, id)` row
 * value off `audit_log_created_at_idx`. Each chunk reads up to `PRUNE_CHUNK_ROWS` keys in
 * that order, then deletes `WHERE <predicate> AND (created_at, id) > (cursor) AND
 * (created_at, id) <= (last key read)`. **The predicate is the authority and the cursor
 * only paginates**, the rule `./retention-prune` states for `planChunks`. The count comes
 * from the keys read, because D1 reports no usable `meta.changes` for a batched write. The
 * bound-parameter count is the same whatever the chunk size. No `DELETE … LIMIT`, and no
 * `IN (…)` list sized by the chunk: the header of `./retention-prune` says why.
 *
 * ─── The acceptance part ─────────────────────────────────────────────────────
 *
 * Chris's ruling 1 of 2026-11-17 defines the end of a vendor account. It has ended when
 * `vendors.claim_ended_at` is set and the vendor holds no live license
 * (`licenses.ended_at IS NULL` on any license of its billing account). The end instant is
 * the later of `claim_ended_at` and the latest `licenses.ended_at`. A reclaim clears
 * `claim_ended_at` and a new license is live, so either restarts the clock. The `licenses`
 * table decides this, not the `plan_ended_at` mirror.
 *
 * Every acceptance row must have a date its period runs from (Chris's ruling 48 and its
 * extension, AECI-1914). A row goes once it was accepted at least
 * {@link ACCEPTANCE_RETENTION_YEARS_AFTER_ACCOUNT_END} calendar years ago, no global hold is
 * open, and one of four arms holds ({@link acceptancePrunePredicate}):
 *
 *   - **A, the vendor exists.** Its vendor's account ended at least six years ago and, if
 *     it names a grant, that grant ended at least {@link GRANT_RETENTION_YEARS_AFTER_END}
 *     calendar years ago. A legacy checkout row that stored only its billing account takes
 *     that account's vendor.
 *   - **B, a claim never approved.** No vendor, billing account or grant, and its claim
 *     (`vendor_request_id`) was rejected at least six years ago (`resolved_at`). A claim
 *     that is open, in review or approved keeps the row. An approval links a vendor
 *     (`linkClaimAcceptanceStatements`), so a NULL-vendor row of an approved claim is a
 *     linking defect: the `acceptance_without_retention_date` data-quality check counts it.
 *   - **C, no date but the acceptance.** No vendor, billing account, grant or claim: a
 *     listing-request acceptance (AECI-1366, a closed set since AECI-1705), or one whose
 *     claim row was deleted.
 *   - **D, the vendor row is gone.** The latest `vendor.deleted` audit row for its
 *     `vendor_id` (`lib/retract-vendor.ts`) is at least six years old, and the grant rule
 *     of arm A holds. With no `vendor.deleted` row it is kept, and the data-quality check
 *     above counts it.
 *
 *   - **A grant's end** is the latest `ended_at` of its licenses when it has any, none of
 *     them live. With no license, it is `decided_at` of a `withdrawn` or `expired` grant
 *     (ruling 17). A `pending_acceptance` grant, or an `accepted` grant with no license, has
 *     not ended. A grant row that is gone counts as ended: only this prune deletes one, and
 *     only past its end, so its acceptance must not be kept forever by its absence.
 *   - **A grant row** goes when it ended five years ago and its vendor's account ended six
 *     years ago (arm A) or its vendor row was deleted six years ago (arm D).
 *   - **A vendor hold** keeps the rows of that vendor: arm A and D by `vendor_id`, arm B by
 *     the company the claim targeted. Arm C has no vendor, so only a global hold keeps it.
 *
 * Calendar years, not days: a day count would fall a day short across a leap year. At most
 * {@link LEGAL_RETENTION_IDS_PER_TABLE} ids per table per run, so the audit row stays small.
 * More is reported as `truncated`, and the next night continues.
 *
 * The ids go into each statement as ONE JSON array bound to `json_each(?)` (the
 * `lib/admin-classification.ts` precedent), never an `IN (?, ?, …)` list. Every DELETE
 * repeats the eligibility predicate, so the predicate stays the authority.
 *
 * **Same-batch companions (Chris's ruling of 2026-11-17).** The Privacy Policy keeps four
 * kinds of audit record past four years, each for as long as the acceptance record it
 * belongs to: the agreement acceptance, the Terms acceptance, the account deletion, and the
 * deletion of a company (AECI-1914). The `agreement.*` and `vendor.deleted` rows go with
 * their acceptances, in the batch that deletes them:
 *
 *   - `agreement.accepted` is filed under its acceptance (`entity_id`).
 *   - `agreement.linked` lists the claim's acceptances in `after_state.acceptance_ids` and
 *     holds the approver and the linked profile id. It goes once none of those ids is left,
 *     checked for the vendors this run prunes.
 *   - `agreement.evidence_removed` lists them in `metadata.acceptance_ids` and has no
 *     vendor. It goes once none is left, checked for rows older than the acceptance cutoff,
 *     in `(created_at, id)` chunks under the same caps as the four-year part.
 *   - `vendor.deleted` is filed under the vendor (`entity_id`). It goes once no acceptance
 *     and no grant names that vendor, checked for the arm-D vendors this run prunes.
 *
 * The JSON test is a `json_each` over the row's own column, so the bind count stays fixed. A
 * malformed value, or one with no non-empty array, is never matched. These three deletes
 * run AFTER the acceptance delete in the batch (`vendor.deleted` after the grant delete
 * too): their predicate reads whether the rows they date still exist. `terms.*` and
 * `account.deleted` wait for the Terms-acceptance prune.
 *
 * **Released holds.** A `litigation_holds` row and its `litigation_hold.*` audit rows go
 * four years after `released_at` (the audit cutoff), never while the hold is open. The row's
 * `reason` is free text that can name a person. Any open hold pauses this cleanup, like the
 * four-year part. The table is not chained, so the run record carries its count, no ids.
 *
 * **`retention.pruned` rows are never deleted.** They hold ids and counts only, and the
 * acceptance chain verify reads all of them.
 *
 * ─── One batch, one audit row ────────────────────────────────────────────────
 *
 * Every delete of a run and its one `retention.pruned` row commit in ONE `db.batch`, the
 * only atomic unit D1 has (ADR 0016, ADR 0022). The row's `metadata.tables[]` carries
 * `{ table, cutoff, rowsDeleted }`, plus `ids` for `agreement_acceptances` and
 * `license_grants`: the shape `pruneAuditIds` in `./acceptance-chain` reads, so the
 * verify accepts each tombstone the chain export writes for them (ADR 0057). A run that
 * deletes nothing writes no row.
 *
 * The batch opens with sentinels that abort it when the state moved after planning: a hold
 * placed, a vendor reclaimed, a license started. A D1 batch is one serialized transaction,
 * so a sentinel that passes holds for every statement after it. An abort throws, the job
 * reports `failed`, and the queue retries with a fresh plan. Nothing was deleted.
 */

import {
  ACCEPTANCE_RETENTION_YEARS_AFTER_ACCOUNT_END,
  AUDIT_LOG_PRUNE_EXEMPT_ACTIONS,
  AUDIT_LOG_PRUNE_EXEMPT_PREFIXES,
  AUDIT_LOG_RETENTION_DAYS,
  GRANT_RETENTION_YEARS_AFTER_END,
} from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, isNotNull, isNull, lt, notInArray, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import { agreementAcceptances, auditLog, licenseGrants, litigationHolds } from '../db/schema';
import { AGREEMENT_EVIDENCE_REMOVED_ACTION } from './acceptance-evidence-removal';
import { AGREEMENT_ACCEPTANCE_ENTITY_TYPE, AGREEMENT_LINKED_ACTION } from './agreement-acceptances';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { cutoffFor, MAX_CHUNKS_PER_TABLE, PRUNE_CHUNK_ROWS } from './retention-prune';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Ids per table per run, so the `retention.pruned` metadata stays a few KB. */
export const LEGAL_RETENTION_IDS_PER_TABLE = 200;

/** The tables this module may delete from, in the order it reports them. */
export const LEGAL_PRUNABLE = [
  'audit_log',
  'agreement_acceptances',
  'license_grants',
  'litigation_holds',
] as const;
export type LegalPrunableTable = (typeof LEGAL_PRUNABLE)[number];

/** The `audit_log` action `lib/retract-vendor.ts` writes when it deletes a vendor row. Its
 *  `entity_id` is the vendor id and its `created_at` dates the deletion. */
export const VENDOR_DELETED_ACTION = 'vendor.deleted';

/** The sentinel's abort token. SQLite has no `RAISE()` outside triggers, so malformed JSON
 *  is the in-statement abort, as in `lib/notifications/switches.ts`. */
export const LEGAL_RETENTION_RACE_TOKEN = 'legal-retention-changed';

/** The `metadata.source` of this module's `retention.pruned` rows (the 400-day prune's
 *  rows carry none), and the job's log source. */
export const LEGAL_RETENTION_SOURCE = 'legal-retention-prune';

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface LegalPrunedTable {
  table: LegalPrunableTable;
  /** Exclusive ISO instant, a UTC midnight. */
  cutoff: string;
  rowsDeleted: number;
  /** True when a cap stopped the run short. The next run continues. */
  truncated: boolean;
  /** `audit_log` only: true when an open hold paused the four-year part. */
  paused?: boolean;
  /** `audit_log` only: the `agreement.*` rows deleted because their acceptances are gone
   *  (`agreement.accepted`, `agreement.linked`, `agreement.evidence_removed`), and the
   *  `vendor.deleted` rows of gone vendors whose last acceptance or grant went. Counted in
   *  `rowsDeleted` too. */
  companionRowsDeleted?: number;
  /** `audit_log` only: the `litigation_hold.*` rows of holds released four years ago.
   *  Counted in `rowsDeleted` too. */
  holdAuditRowsDeleted?: number;
}

export type LegalRetentionPruneResult =
  | {
      status: 'pruned';
      tables: LegalPrunedTable[];
      rowsDeleted: number;
      /** Open vendor holds this run respected. */
      vendorHolds: number;
      /** The one summary row written in the same batch, for the §26.5 forward. Absent
       *  when `rowsDeleted` is 0. */
      auditEntry?: AuditLogEntry;
      /** True when a first plan lost a race and this result is the replan's. */
      replanned?: boolean;
    }
  | {
      status: 'skipped';
      /** `litigation_hold`: a global hold is open. `concurrent_run`: the plan lost a race
       *  twice in a row, so this run deleted nothing (see {@link runLegalRetentionPruneWithReplan}). */
      reason: 'litigation_hold' | 'concurrent_run';
      tables: LegalPrunedTable[];
      rowsDeleted: 0;
      vendorHolds: number;
    };

// ---------------------------------------------------------------------------
// Cutoffs
// ---------------------------------------------------------------------------

/**
 * `day` (`YYYY-MM-DD`) moved by whole calendar years. A Feb 29 that lands in a common year
 * becomes Feb 28, the earlier day, so a cutoff never moves later than the promise allows.
 */
export function shiftYears(day: string, years: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const year = y + years;
  const lastOfMonth = new Date(Date.UTC(year, m, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(year).padStart(4, '0')}-${pad(m)}-${pad(Math.min(d, lastOfMonth))}`;
}

/** The three exclusive cutoffs for a run at `now`, each a UTC midnight. */
export function legalCutoffs(now: Date): {
  audit: string;
  acceptance: string;
  grant: string;
} {
  const today = now.toISOString().slice(0, 10);
  const midnight = (day: string) => `${day}T00:00:00.000Z`;
  return {
    audit: cutoffFor(now, AUDIT_LOG_RETENTION_DAYS).iso,
    acceptance: midnight(shiftYears(today, -ACCEPTANCE_RETENTION_YEARS_AFTER_ACCOUNT_END)),
    grant: midnight(shiftYears(today, -GRANT_RETENTION_YEARS_AFTER_END)),
  };
}

// ---------------------------------------------------------------------------
// Predicates. Raw SQL with fixed table aliases, so a correlated subquery can never
// resolve a column against the wrong table. Every value is bound.
// ---------------------------------------------------------------------------

/** `LIKE` treats `_` as a wildcard, so the prefixes are escaped with `\`. */
function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * The four-year audit predicate: old enough and not exempt. A `vendor.deleted` row is
 * exempt while its vendor row is gone and any acceptance or grant still names that vendor
 * (AECI-1914): it dates the six years those rows are kept (arm D). The legal prune deletes
 * it in the batch that removes the last of them. A vendor row that exists again (the same
 * id promoted back) dates its rows by its account end, so the old `vendor.deleted` row is
 * an ordinary four-year row. Correlated EXISTS only, no bind.
 */
export function auditPrunePredicate(cutoff: string): SQL {
  return and(
    lt(auditLog.createdAt, cutoff),
    notInArray(auditLog.action, [...AUDIT_LOG_PRUNE_EXEMPT_ACTIONS]),
    ...AUDIT_LOG_PRUNE_EXEMPT_PREFIXES.map(
      (prefix) => sql`${auditLog.action} NOT LIKE ${likePrefix(prefix)} ESCAPE '\\'`,
    ),
    sql`(${auditLog.action} <> ${VENDOR_DELETED_ACTION}
      OR EXISTS (SELECT 1 FROM "vendors" "ap_v" WHERE "ap_v"."id" = "audit_log"."entity_id")
      OR (
      NOT EXISTS (SELECT 1 FROM "agreement_acceptances" "ap_a" WHERE "ap_a"."vendor_id" = "audit_log"."entity_id")
      AND NOT EXISTS (SELECT 1 FROM "license_grants" "ap_g" WHERE "ap_g"."vendor_id" = "audit_log"."entity_id")
    ))`,
  ) as SQL;
}

/** Any open hold, global or vendor. */
const ANY_OPEN_HOLD = sql`EXISTS (SELECT 1 FROM "litigation_holds" "lh_any" WHERE "lh_any"."released_at" IS NULL)`;

/**
 * True when the vendor named by `vendorId` (an SQL expression) has an ended account, ended
 * before `cutoff`, and no open hold covers it. Ruling 1: `claim_ended_at` set, no live
 * license, end = later of `claim_ended_at` and the latest license end. A vendor row that is
 * gone matches nothing.
 */
function vendorAccountEndedBefore(vendorId: SQL, cutoff: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM "vendors" "lr_v"
    WHERE "lr_v"."id" = ${vendorId}
      AND "lr_v"."claim_ended_at" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "licenses" "lr_l"
        JOIN "billing_accounts" "lr_b" ON "lr_b"."id" = "lr_l"."billing_account_id"
        WHERE "lr_b"."vendor_id" = "lr_v"."id" AND "lr_l"."ended_at" IS NULL
      )
      AND max(
        "lr_v"."claim_ended_at",
        COALESCE((
          SELECT max("lr_l2"."ended_at") FROM "licenses" "lr_l2"
          JOIN "billing_accounts" "lr_b2" ON "lr_b2"."id" = "lr_l2"."billing_account_id"
          WHERE "lr_b2"."vendor_id" = "lr_v"."id"
        ), '')
      ) < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "litigation_holds" "lr_h"
        WHERE "lr_h"."released_at" IS NULL
          AND ("lr_h"."scope" = 'global' OR "lr_h"."vendor_id" = "lr_v"."id")
      )
  )`;
}

/**
 * True when the grant named by `grantId` ended before `cutoff`. With licenses: none live,
 * and the latest `ended_at` before the cutoff. With none: a `withdrawn` or `expired` grant
 * decided before the cutoff, or a grant row that is gone (see the header).
 */
function grantEndedBefore(grantId: SQL, cutoff: string): SQL {
  return sql`(
    CASE WHEN EXISTS (SELECT 1 FROM "licenses" "lg_l" WHERE "lg_l"."license_grant_id" = ${grantId})
    THEN NOT EXISTS (
        SELECT 1 FROM "licenses" "lg_l2"
        WHERE "lg_l2"."license_grant_id" = ${grantId} AND "lg_l2"."ended_at" IS NULL
      )
      AND (SELECT max("lg_l3"."ended_at") FROM "licenses" "lg_l3"
           WHERE "lg_l3"."license_grant_id" = ${grantId}) < ${cutoff}
    ELSE NOT EXISTS (SELECT 1 FROM "license_grants" "lg_g" WHERE "lg_g"."id" = ${grantId})
      OR EXISTS (
        SELECT 1 FROM "license_grants" "lg_g2"
        WHERE "lg_g2"."id" = ${grantId}
          AND "lg_g2"."status" IN ('withdrawn', 'expired')
          AND "lg_g2"."decided_at" IS NOT NULL
          AND "lg_g2"."decided_at" < ${cutoff}
      )
    END
  )`;
}

/** No open global hold. The run stops on one before planning; every arm repeats it so a
 *  guarded DELETE or a sentinel never matches under one. */
const NO_GLOBAL_HOLD = sql`NOT EXISTS (SELECT 1 FROM "litigation_holds" "lh_ng" WHERE "lh_ng"."released_at" IS NULL AND "lh_ng"."scope" = 'global')`;

/**
 * True when the vendor id `vendorId` (an SQL expression) has no `vendors` row, the latest
 * `vendor.deleted` audit row for it is older than `cutoff`, and no open hold covers it.
 * With no `vendor.deleted` row the `max` is NULL, so it never matches: the row is kept and
 * the `acceptance_without_retention_date` data-quality check counts it.
 */
function vendorGoneBefore(vendorId: SQL, cutoff: string): SQL {
  return sql`(
    NOT EXISTS (SELECT 1 FROM "vendors" "vg_v" WHERE "vg_v"."id" = ${vendorId})
    AND (
      SELECT max("vg_a"."created_at") FROM "audit_log" "vg_a"
      WHERE "vg_a"."entity_type" = 'vendor'
        AND "vg_a"."entity_id" = ${vendorId}
        AND "vg_a"."action" = ${VENDOR_DELETED_ACTION}
    ) < ${cutoff}
    AND NOT EXISTS (
      SELECT 1 FROM "litigation_holds" "vg_h"
      WHERE "vg_h"."released_at" IS NULL
        AND ("vg_h"."scope" = 'global' OR "vg_h"."vendor_id" = ${vendorId})
    )
  )`;
}

/**
 * True when the claim `requestId` names was rejected, and closed before `cutoff`, and no
 * open vendor hold covers the company it targeted (ruling 48). The target is the vendor
 * itself, or, on a legacy claim stored with `target_type = 'product'`, any vendor joined to
 * that product. An `open`, `in_review` or `resolved` claim never matches.
 */
function claimRejectedBefore(requestId: SQL, cutoff: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM "vendor_requests" "cr_r"
    WHERE "cr_r"."id" = ${requestId}
      AND "cr_r"."kind" = 'claim'
      AND "cr_r"."status" = 'rejected'
      AND "cr_r"."resolved_at" IS NOT NULL
      AND "cr_r"."resolved_at" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM "litigation_holds" "cr_h"
        WHERE "cr_h"."released_at" IS NULL
          AND "cr_h"."vendor_id" IS NOT NULL
          AND (
            ("cr_r"."target_type" = 'vendor' AND "cr_r"."target_id" = "cr_h"."vendor_id")
            OR ("cr_r"."target_type" = 'product' AND EXISTS (
              SELECT 1 FROM "product_vendors" "cr_pv"
              WHERE "cr_pv"."product_id" = "cr_r"."target_id"
                AND "cr_pv"."vendor_id" = "cr_h"."vendor_id"
            ))
          )
      )
  )`;
}

/**
 * The vendor an acceptance belongs to: its own `vendor_id`, or, on a legacy checkout row
 * that stored only the billing account, that account's vendor (`billing_accounts.vendor_id`
 * is NOT NULL). The `acceptancesOfVendor` rule of `./agreement-acceptances`.
 */
const ACCEPTANCE_VENDOR = sql`COALESCE("agreement_acceptances"."vendor_id", (SELECT "ae_b"."vendor_id" FROM "billing_accounts" "ae_b" WHERE "ae_b"."id" = "agreement_acceptances"."billing_account_id"))`;

/**
 * One `agreement_acceptances` row is due (rulings 1 and 48, AECI-1914). Accepted before the
 * acceptance cutoff, no open global hold, and one of four arms:
 *
 *   - **A, the vendor exists:** its vendor (see {@link ACCEPTANCE_VENDOR}) has an account
 *     that ended before the cutoff, and its grant, if any, ended before the grant cutoff.
 *   - **B, a claim never approved:** no vendor, billing account or grant, and the claim it
 *     was given on was rejected before the cutoff. A vendor hold on the claim's company
 *     keeps it.
 *   - **C, no date but the acceptance:** no vendor, billing account, grant or claim. A
 *     listing-request acceptance, or one whose claim row was deleted.
 *   - **D, the vendor row is gone:** the vendor was deleted before the cutoff, by its
 *     latest `vendor.deleted` audit row, and its grant, if any, ended before the grant
 *     cutoff. A vendor hold on that id keeps it.
 *
 * The arms are one OR, never a UNION: D1 caps a compound SELECT at five terms. The bind
 * count is fixed.
 */
export function acceptancePrunePredicate(cutoffs: { acceptance: string; grant: string }): SQL {
  const vendorId = sql`"agreement_acceptances"."vendor_id"`;
  const grantId = sql`"agreement_acceptances"."license_grant_id"`;
  const requestId = sql`"agreement_acceptances"."vendor_request_id"`;
  const unlinked = sql`${vendorId} IS NULL
    AND "agreement_acceptances"."billing_account_id" IS NULL
    AND ${grantId} IS NULL`;
  const grantDone = sql`(${grantId} IS NULL OR ${grantEndedBefore(grantId, cutoffs.grant)})`;
  return sql`(
    "agreement_acceptances"."accepted_at" < ${cutoffs.acceptance}
    AND ${NO_GLOBAL_HOLD}
    AND (
      (${vendorAccountEndedBefore(ACCEPTANCE_VENDOR, cutoffs.acceptance)} AND ${grantDone})
      OR (${unlinked} AND ${requestId} IS NOT NULL
        AND ${claimRejectedBefore(requestId, cutoffs.acceptance)})
      OR (${unlinked} AND ${requestId} IS NULL)
      OR (${vendorId} IS NOT NULL
        AND ${vendorGoneBefore(vendorId, cutoffs.acceptance)} AND ${grantDone})
    )
  )`;
}

/** One `license_grants` row is due: its vendor's account ended six years ago (arm A), or
 *  its vendor row was deleted six years ago (arm D), and the grant ended five years ago. */
export function grantPrunePredicate(cutoffs: { acceptance: string; grant: string }): SQL {
  const vendorId = sql`"license_grants"."vendor_id"`;
  return sql`(
    ${NO_GLOBAL_HOLD}
    AND (
      ${vendorAccountEndedBefore(vendorId, cutoffs.acceptance)}
      OR ${vendorGoneBefore(vendorId, cutoffs.acceptance)}
    )
    AND ${grantEndedBefore(sql`"license_grants"."id"`, cutoffs.grant)}
  )`;
}

/** `<column> IN (SELECT value FROM json_each(?))`: one bind, whatever the list length. */
function inJsonList(column: SQL, ids: readonly string[]): SQL {
  return sql`${column} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
}

/** A sentinel that aborts the batch when `condition` is true at commit time. */
function abortWhen(db: Db, condition: SQL): BatchStmt {
  return db
    .select({ guard: sql`CASE WHEN ${condition} THEN json(${LEGAL_RETENTION_RACE_TOKEN}) END` })
    .from(sql`(SELECT 1)`);
}

/** True when a batch failed because one of this module's sentinels fired. */
export function isLegalRetentionRaceError(error: unknown): boolean {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    parts.push(String((current as { message?: unknown }).message ?? current));
    current = (current as { cause?: unknown }).cause;
  }
  return /malformed JSON/i.test(parts.join(' | '));
}

/**
 * True when every acceptance id listed at `path` of the JSON column `column` is gone from
 * `agreement_acceptances`. `planned` are the ids this run's batch deletes before the
 * statement runs: a planning read passes them so it sees the state the delete will see. The
 * batch statement itself passes none, because by then they are gone.
 *
 * Both writers store the column as JSON text (`auditInsert` through Drizzle's json mode,
 * `auditInsertWhere` through `JSON.stringify`), so one shape exists. A value that is not
 * valid JSON, has no array at `path`, or an empty one, is never matched: it is kept. The
 * nested `CASE` keeps `json_type` and `json_each` off a malformed value, whose error would
 * abort the batch. The id list is read from the row, so the bind count never grows.
 */
function acceptanceIdsAllGone(column: SQL, path: string, planned: readonly string[]): SQL {
  const stillKept =
    planned.length > 0
      ? sql`"aa_keep"."id" NOT IN (SELECT value FROM json_each(${JSON.stringify(planned)}))`
      : sql`1`;
  return sql`(CASE WHEN json_valid(${column}) THEN
      CASE WHEN json_type(${column}, ${path}) = 'array' AND json_array_length(${column}, ${path}) > 0
      THEN NOT EXISTS (
        SELECT 1 FROM json_each(${column}, ${path}) "aa_j"
        WHERE "aa_j"."value" IN (SELECT "aa_keep"."id" FROM "agreement_acceptances" "aa_keep" WHERE ${stillKept})
      )
      ELSE 0 END
    ELSE 0 END)`;
}

/** `agreement.linked` rows of the vendors pruned this run whose acceptances are all gone. */
function linkedWhere(vendorIds: readonly string[], planned: readonly string[]): SQL {
  return and(
    eq(auditLog.action, AGREEMENT_LINKED_ACTION),
    inJsonList(sql`${auditLog.vendorId}`, vendorIds),
    acceptanceIdsAllGone(sql`${auditLog.afterState}`, '$.acceptance_ids', planned),
  ) as SQL;
}

/** `agreement.evidence_removed` rows older than the acceptance cutoff whose acceptances are
 *  all gone. They carry no vendor id, so the age bounds the scan. */
function evidenceWhere(cutoff: string, planned: readonly string[]): SQL {
  return and(
    eq(auditLog.action, AGREEMENT_EVIDENCE_REMOVED_ACTION),
    lt(auditLog.createdAt, cutoff),
    acceptanceIdsAllGone(sql`${auditLog.metadata}`, '$.acceptance_ids', planned),
  ) as SQL;
}

/**
 * `vendor.deleted` rows of the arm-D vendors pruned this run (`vendorIds`), older than the
 * acceptance cutoff, once no acceptance and no grant names that vendor. `plannedAcceptances`
 * and `plannedGrants` are the ids the batch deletes first: a planning read passes them, the
 * batch statement passes none. Two JSON binds per list, whatever their length.
 */
function vendorDeletedWhere(
  vendorIds: readonly string[],
  cutoff: string,
  plannedAcceptances: readonly string[],
  plannedGrants: readonly string[],
): SQL {
  const keptAcceptance =
    plannedAcceptances.length > 0
      ? sql`AND "vd_a"."id" NOT IN (SELECT value FROM json_each(${JSON.stringify(plannedAcceptances)}))`
      : sql``;
  const keptGrant =
    plannedGrants.length > 0
      ? sql`AND "vd_g"."id" NOT IN (SELECT value FROM json_each(${JSON.stringify(plannedGrants)}))`
      : sql``;
  return and(
    eq(auditLog.action, VENDOR_DELETED_ACTION),
    eq(auditLog.entityType, 'vendor'),
    inJsonList(sql`${auditLog.entityId}`, vendorIds),
    lt(auditLog.createdAt, cutoff),
    sql`NOT EXISTS (SELECT 1 FROM "agreement_acceptances" "vd_a" WHERE "vd_a"."vendor_id" = "audit_log"."entity_id" ${keptAcceptance})`,
    sql`NOT EXISTS (SELECT 1 FROM "license_grants" "vd_g" WHERE "vd_g"."vendor_id" = "audit_log"."entity_id" ${keptGrant})`,
  ) as SQL;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

interface AuditPlan {
  statements: BatchStmt[];
  rowsDeleted: number;
  truncated: boolean;
  /** The last `(created_at, id)` key the chunks cover, when any. */
  last?: { createdAt: string; id: string };
}

/** The four-year chunks, read without executing a delete. */
async function planAuditChunks(db: Db, cutoff: string): Promise<AuditPlan> {
  return planKeyChunks(db, auditPrunePredicate(cutoff), auditPrunePredicate(cutoff));
}

/**
 * `audit_log` chunks paged on the `(created_at, id)` row value. `readWhere` selects the
 * keys before the batch runs. `deleteWhere` is the authority each DELETE repeats. They
 * differ only for a predicate that depends on an earlier statement of the same batch.
 */
async function planKeyChunks(db: Db, readWhere: SQL, deleteWhere: SQL): Promise<AuditPlan> {
  const statements: BatchStmt[] = [];
  const predicate = deleteWhere;
  const key = sql`(${auditLog.createdAt}, ${auditLog.id})`;
  let cursor: { createdAt: string; id: string } | null = null;
  let rowsDeleted = 0;

  for (let chunk = 0; chunk < MAX_CHUNKS_PER_TABLE; chunk += 1) {
    const after: SQL | undefined = cursor
      ? sql`${key} > (${cursor.createdAt}, ${cursor.id})`
      : undefined;
    const keys = await db
      .select({ createdAt: auditLog.createdAt, id: auditLog.id })
      .from(auditLog)
      .where(and(readWhere, after))
      .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
      .limit(PRUNE_CHUNK_ROWS);
    if (keys.length === 0)
      return { statements, rowsDeleted, truncated: false, last: cursor ?? undefined };

    const last = keys[keys.length - 1] as { createdAt: string; id: string };
    // The predicate is repeated on purpose: the key range is pagination, the predicate is
    // the authority.
    statements.push(
      db
        .delete(auditLog)
        .where(and(predicate, after, sql`${key} <= (${last.createdAt}, ${last.id})`)),
    );
    rowsDeleted += keys.length;
    cursor = last;
    if (keys.length < PRUNE_CHUNK_ROWS) return { statements, rowsDeleted, truncated: false, last };
  }
  return { statements, rowsDeleted, truncated: true, last: cursor ?? undefined };
}

/** Up to {@link LEGAL_RETENTION_IDS_PER_TABLE} ids matching `where`, and whether more remain. */
async function capIds(
  rows: Promise<{ id: string }[]>,
): Promise<{ ids: string[]; truncated: boolean }> {
  const read = (await rows).map((r) => r.id);
  return {
    ids: read.slice(0, LEGAL_RETENTION_IDS_PER_TABLE),
    truncated: read.length > LEGAL_RETENTION_IDS_PER_TABLE,
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Prune what the two retention promises allow, or nothing while a global hold is open.
 *
 * Never throws for an operational reason: a hold is reported as `skipped` or as a paused
 * table. A D1 failure, or a sentinel that fired because the state moved, DOES throw. The
 * batch is atomic, so nothing was deleted, and the queue retries the run.
 */
export async function runLegalRetentionPrune(
  db: Db,
  now: Date,
): Promise<LegalRetentionPruneResult> {
  const cutoffs = legalCutoffs(now);
  const zero = (table: LegalPrunableTable, cutoff: string): LegalPrunedTable => ({
    table,
    cutoff,
    rowsDeleted: 0,
    truncated: false,
  });

  const holds = await db
    .select({ scope: litigationHolds.scope, vendorId: litigationHolds.vendorId })
    .from(litigationHolds)
    .where(isNull(litigationHolds.releasedAt));
  const vendorHolds = holds.filter((h) => h.scope === 'vendor').length;

  if (holds.some((h) => h.scope === 'global')) {
    return {
      status: 'skipped',
      reason: 'litigation_hold',
      tables: [
        { ...zero('audit_log', cutoffs.audit), paused: true },
        zero('agreement_acceptances', cutoffs.acceptance),
        zero('license_grants', cutoffs.grant),
        { ...zero('litigation_holds', cutoffs.audit), paused: true },
      ],
      rowsDeleted: 0,
      vendorHolds,
    };
  }

  // ── Acceptances and grants ───────────────────────────────────────────────
  const acceptanceWhere = acceptancePrunePredicate(cutoffs);
  const grantWhere = grantPrunePredicate(cutoffs);
  const acceptances = await capIds(
    db
      .select({ id: agreementAcceptances.id })
      .from(agreementAcceptances)
      .where(acceptanceWhere)
      .orderBy(asc(agreementAcceptances.acceptedAt), asc(agreementAcceptances.id))
      .limit(LEGAL_RETENTION_IDS_PER_TABLE + 1),
  );
  const grants = await capIds(
    db
      .select({ id: licenseGrants.id })
      .from(licenseGrants)
      .where(grantWhere)
      .orderBy(asc(licenseGrants.createdAt), asc(licenseGrants.id))
      .limit(LEGAL_RETENTION_IDS_PER_TABLE + 1),
  );
  const idCol = sql`"agreement_acceptances"."id"`;
  const grantIdCol = sql`"license_grants"."id"`;
  // The vendor of each pruned acceptance, its billing account's on a legacy checkout row.
  const prunedVendorIds =
    acceptances.ids.length > 0
      ? (
          await db
            .selectDistinct({ vendorId: sql<string | null>`${ACCEPTANCE_VENDOR}` })
            .from(agreementAcceptances)
            .where(inJsonList(idCol, acceptances.ids))
        ).flatMap((r) => (r.vendorId ? [r.vendorId] : []))
      : [];
  // The arm-D vendors: named by a pruned acceptance or grant, with no `vendors` row.
  const goneVendor = (column: SQL) =>
    sql`${column} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "vendors" "gv_v" WHERE "gv_v"."id" = ${column})`;
  const goneVendorIds = [
    ...new Set(
      [
        ...(acceptances.ids.length > 0
          ? await db
              .selectDistinct({ vendorId: agreementAcceptances.vendorId })
              .from(agreementAcceptances)
              .where(
                and(
                  inJsonList(idCol, acceptances.ids),
                  goneVendor(sql`"agreement_acceptances"."vendor_id"`),
                ),
              )
          : []),
        ...(grants.ids.length > 0
          ? await db
              .selectDistinct({ vendorId: licenseGrants.vendorId })
              .from(licenseGrants)
              .where(
                and(
                  inJsonList(grantIdCol, grants.ids),
                  goneVendor(sql`"license_grants"."vendor_id"`),
                ),
              )
          : []),
      ].flatMap((r) => (r.vendorId ? [r.vendorId] : [])),
    ),
  ];

  // ── The `agreement.*` rows that go with their acceptances ────────────────
  // `agreement.accepted` is filed under its acceptance. `agreement.linked` and
  // `agreement.evidence_removed` list acceptance ids in their JSON, and go once none of
  // those ids is left. Each is counted here against the state the batch will leave.
  const acceptedWhere = and(
    sql`${auditLog.entityType} = ${AGREEMENT_ACCEPTANCE_ENTITY_TYPE}`,
    sql`${auditLog.action} LIKE ${likePrefix('agreement.')} ESCAPE '\\'`,
    inJsonList(sql`${auditLog.entityId}`, acceptances.ids),
  ) as SQL;
  const countAudit = async (where: SQL) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(auditLog)
      .where(where);
    return Number(row?.n ?? 0);
  };
  const accepted = acceptances.ids.length > 0 ? await countAudit(acceptedWhere) : 0;
  const linked =
    prunedVendorIds.length > 0
      ? await countAudit(linkedWhere(prunedVendorIds, acceptances.ids))
      : 0;
  const evidence = await planKeyChunks(
    db,
    evidenceWhere(cutoffs.acceptance, acceptances.ids),
    evidenceWhere(cutoffs.acceptance, []),
  );
  const vendorDeleted =
    goneVendorIds.length > 0
      ? await countAudit(
          vendorDeletedWhere(goneVendorIds, cutoffs.acceptance, acceptances.ids, grants.ids),
        )
      : 0;
  const companions = accepted + linked + evidence.rowsDeleted + vendorDeleted;

  // ── The four-year audit part, and holds released four years ago ──────────
  const auditPaused = holds.length > 0;
  const audit: AuditPlan = auditPaused
    ? { statements: [], rowsDeleted: 0, truncated: false }
    : await planAuditChunks(db, cutoffs.audit);
  const releasedHoldWhere = and(
    isNotNull(litigationHolds.releasedAt),
    lt(litigationHolds.releasedAt, cutoffs.audit),
  ) as SQL;
  const releasedHolds = auditPaused
    ? { ids: [] as string[], truncated: false }
    : await capIds(
        db
          .select({ id: litigationHolds.id })
          .from(litigationHolds)
          .where(releasedHoldWhere)
          .orderBy(asc(litigationHolds.releasedAt), asc(litigationHolds.id))
          .limit(LEGAL_RETENTION_IDS_PER_TABLE + 1),
      );
  const holdAuditWhere = and(
    eq(auditLog.entityType, 'litigation_hold'),
    sql`${auditLog.action} LIKE ${likePrefix('litigation_hold.')} ESCAPE '\\'`,
    inJsonList(sql`${auditLog.entityId}`, releasedHolds.ids),
  ) as SQL;
  const holdAudit = releasedHolds.ids.length > 0 ? await countAudit(holdAuditWhere) : 0;

  const tables: LegalPrunedTable[] = [
    {
      table: 'audit_log',
      cutoff: cutoffs.audit,
      rowsDeleted: audit.rowsDeleted + companions + holdAudit,
      truncated: audit.truncated || evidence.truncated,
      ...(auditPaused ? { paused: true } : {}),
      ...(companions > 0 ? { companionRowsDeleted: companions } : {}),
      ...(holdAudit > 0 ? { holdAuditRowsDeleted: holdAudit } : {}),
    },
    {
      table: 'agreement_acceptances',
      cutoff: cutoffs.acceptance,
      rowsDeleted: acceptances.ids.length,
      truncated: acceptances.truncated,
    },
    {
      table: 'license_grants',
      cutoff: cutoffs.grant,
      rowsDeleted: grants.ids.length,
      truncated: grants.truncated,
    },
    {
      table: 'litigation_holds',
      cutoff: cutoffs.audit,
      rowsDeleted: releasedHolds.ids.length,
      truncated: releasedHolds.truncated,
      ...(auditPaused ? { paused: true } : {}),
    },
  ];
  const rowsDeleted = tables.reduce((sum, t) => sum + t.rowsDeleted, 0);
  if (rowsDeleted === 0) return { status: 'pruned', tables, rowsDeleted: 0, vendorHolds };

  // ── The batch ────────────────────────────────────────────────────────────
  // STATEMENT ORDER IS LOAD-BEARING. A D1 batch runs its statements in order inside one
  // transaction. The sentinels come first, so a moved state aborts before any delete. The
  // `agreement.linked` and `agreement.evidence_removed` deletes come AFTER the acceptance
  // delete, because their predicate asks whether the acceptances they list still exist:
  // run before it, they would match nothing this run removes, and the audit row would
  // count deletes that did not happen (their own sentinels sit right before them for the
  // same reason). The `vendor.deleted` delete comes AFTER the acceptance and grant deletes
  // for the same reason, and BEFORE the four-year sentinel and chunks: once the last row
  // naming a gone vendor is deleted, its `vendor.deleted` row is no longer exempt from the
  // four-year predicate, so it must be gone before that predicate is counted again. The
  // `retention.pruned` insert comes last.
  const statements: BatchStmt[] = [];
  // A hold placed after the read: a global one stops everything, and any one stops the
  // four-year part and the released-hold cleanup. The acceptance predicate checks vendor
  // holds itself.
  statements.push(
    abortWhen(
      db,
      audit.rowsDeleted > 0 || releasedHolds.ids.length > 0
        ? ANY_OPEN_HOLD
        : sql`EXISTS (SELECT 1 FROM "litigation_holds" "lh_g" WHERE "lh_g"."released_at" IS NULL AND "lh_g"."scope" = 'global')`,
    ),
  );
  if (acceptances.ids.length > 0) {
    // Every planned acceptance must still be eligible, and its companions unchanged in
    // number, or the audit row would name deletes that did not happen.
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "agreement_acceptances" WHERE ${inJsonList(idCol, acceptances.ids)} AND ${acceptanceWhere}) <> ${acceptances.ids.length}`,
      ),
      abortWhen(db, sql`(SELECT count(*) FROM "audit_log" WHERE ${acceptedWhere}) <> ${accepted}`),
    );
  }
  if (grants.ids.length > 0) {
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "license_grants" WHERE ${inJsonList(grantIdCol, grants.ids)} AND ${grantWhere}) <> ${grants.ids.length}`,
      ),
    );
  }
  if (accepted > 0) statements.push(db.delete(auditLog).where(acceptedWhere));
  if (acceptances.ids.length > 0) {
    statements.push(
      db
        .delete(agreementAcceptances)
        .where(and(inJsonList(idCol, acceptances.ids), acceptanceWhere)),
    );
  }
  // After the acceptance delete (see above).
  if (linked > 0) {
    const where = linkedWhere(prunedVendorIds, []);
    statements.push(
      abortWhen(db, sql`(SELECT count(*) FROM "audit_log" WHERE ${where}) <> ${linked}`),
      db.delete(auditLog).where(where),
    );
  }
  if (evidence.rowsDeleted > 0 && evidence.last) {
    // The chunks cover every key up to `last`, so the count up to it must match.
    const upTo = sql`(${auditLog.createdAt}, ${auditLog.id}) <= (${evidence.last.createdAt}, ${evidence.last.id})`;
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "audit_log" WHERE ${and(evidenceWhere(cutoffs.acceptance, []), upTo)}) <> ${evidence.rowsDeleted}`,
      ),
      ...evidence.statements,
    );
  }
  if (grants.ids.length > 0) {
    statements.push(
      db.delete(licenseGrants).where(and(inJsonList(grantIdCol, grants.ids), grantWhere)),
    );
  }
  // After the acceptance and grant deletes, before the four-year part (see above).
  if (vendorDeleted > 0) {
    const where = vendorDeletedWhere(goneVendorIds, cutoffs.acceptance, [], []);
    statements.push(
      abortWhen(db, sql`(SELECT count(*) FROM "audit_log" WHERE ${where}) <> ${vendorDeleted}`),
      db.delete(auditLog).where(where),
    );
  }
  if (releasedHolds.ids.length > 0) {
    const holdIdCol = sql`"litigation_holds"."id"`;
    const holdRowsWhere = and(inJsonList(holdIdCol, releasedHolds.ids), releasedHoldWhere);
    // The planned holds and their audit rows must still be there, or a concurrent run got
    // them first and this run's audit row would claim deletes it did not make.
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "litigation_holds" WHERE ${holdRowsWhere}) <> ${releasedHolds.ids.length}`,
      ),
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "audit_log" WHERE ${holdAuditWhere}) <> ${holdAudit}`,
      ),
    );
    if (holdAudit > 0) statements.push(db.delete(auditLog).where(holdAuditWhere));
    statements.push(db.delete(litigationHolds).where(holdRowsWhere));
  }
  if (audit.rowsDeleted > 0 && audit.last) {
    // The four-year chunks start at the first matching key and cover every key up to
    // `last`, so the rows matching the predicate up to it must be exactly the planned count.
    // A concurrent run that deleted them first makes the count fall short: abort. Nothing
    // earlier in the batch deletes a row this predicate matched at the start of the batch
    // (every `agreement.*` and `litigation_hold.*` action is exempt from it, and so is a
    // `vendor.deleted` row an acceptance or grant still names). The only rows the earlier
    // deletes can bring into it are `vendor.deleted` rows whose last acceptance or grant
    // they removed, and the `vendor.deleted` delete above has already removed them. So the
    // count is the same here as at the start of the batch. Four binds plus the
    // predicate's, whatever the chunk count.
    const upTo = sql`(${auditLog.createdAt}, ${auditLog.id}) <= (${audit.last.createdAt}, ${audit.last.id})`;
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "audit_log" WHERE ${and(auditPrunePredicate(cutoffs.audit), upTo)}) <> ${audit.rowsDeleted}`,
      ),
    );
  }
  statements.push(...audit.statements);

  // ONE row for the run, in the SAME batch as every delete. `ids` in the shape
  // `pruneAuditIds` (`./acceptance-chain`) reads, for the two chained tables only.
  const idsFor: Partial<Record<LegalPrunableTable, string[]>> = {
    agreement_acceptances: acceptances.ids,
    license_grants: grants.ids,
  };
  const auditEntry: AuditLogEntry = {
    actorType: 'system',
    action: 'retention.pruned',
    entityType: 'retention',
    metadata: {
      source: LEGAL_RETENTION_SOURCE,
      rowsDeleted,
      tables: tables
        .filter((t) => t.rowsDeleted > 0)
        .map((t) => ({
          table: t.table,
          cutoff: t.cutoff,
          rowsDeleted: t.rowsDeleted,
          ...(t.companionRowsDeleted ? { companionRowsDeleted: t.companionRowsDeleted } : {}),
          ...(t.holdAuditRowsDeleted ? { holdAuditRowsDeleted: t.holdAuditRowsDeleted } : {}),
          ...(idsFor[t.table] ? { ids: idsFor[t.table] } : {}),
        })),
    },
  };
  statements.push(auditInsert(db, auditEntry));

  await db.batch(statements as BatchTuple);

  return { status: 'pruned', tables, rowsDeleted, vendorHolds, auditEntry };
}

/**
 * {@link runLegalRetentionPrune}, replanned once when its batch lost a race.
 *
 * A sentinel abort means the state moved between the plan and the commit: a concurrent run
 * of this job deleted the rows first (the queued run and an inline fallback after an
 * accepted but failed `queue.send`), or a hold, a reclaim or a license landed. Nothing was
 * deleted. One replan, at once, reads the state as it is now: after a concurrent run it
 * finds nothing left and writes no audit row, and after any other change it plans around it.
 * A second abort in a row is reported as `skipped: 'concurrent_run'`, not thrown, so a run
 * that only lost a race never fails its `job_runs` row or sends the failure email. The next
 * night plans from scratch. Any other error is thrown, as before.
 */
export async function runLegalRetentionPruneWithReplan(
  db: Db,
  now: Date,
): Promise<LegalRetentionPruneResult> {
  try {
    return await runLegalRetentionPrune(db, now);
  } catch (error) {
    if (!isLegalRetentionRaceError(error)) throw error;
  }
  try {
    const result = await runLegalRetentionPrune(db, now);
    return result.status === 'pruned' ? { ...result, replanned: true } : result;
  } catch (error) {
    if (!isLegalRetentionRaceError(error)) throw error;
    const cutoffs = legalCutoffs(now);
    return {
      status: 'skipped',
      reason: 'concurrent_run',
      tables: [
        { table: 'audit_log', cutoff: cutoffs.audit, rowsDeleted: 0, truncated: false },
        {
          table: 'agreement_acceptances',
          cutoff: cutoffs.acceptance,
          rowsDeleted: 0,
          truncated: false,
        },
        { table: 'license_grants', cutoff: cutoffs.grant, rowsDeleted: 0, truncated: false },
        { table: 'litigation_holds', cutoff: cutoffs.audit, rowsDeleted: 0, truncated: false },
      ],
      rowsDeleted: 0,
      vendorHolds: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// Observability (docs/OBSERVABILITY.md)
// ---------------------------------------------------------------------------

export type LegalRetentionMetricSink = {
  count(metric: string, value: number, tags: string[]): void;
  distribution(metric: string, value: number, tags: string[]): void;
};

export const LEGAL_RETENTION_RUN_METRIC = 'aeci.legal_retention.prune';
export const LEGAL_RETENTION_ROWS_METRIC = 'aeci.legal_retention.rows_deleted';
export const LEGAL_RETENTION_DURATION_METRIC = 'aeci.legal_retention.prune.duration_ms';
export const LEGAL_RETENTION_TRUNCATED_METRIC = 'aeci.legal_retention.prune.truncated';

/**
 * The metrics of one completed run. `rows_deleted` goes out for every table on every run,
 * zeros included, so a threshold monitor has a continuous series. The run count doubles as
 * the liveness heartbeat. `audit:paused` marks a run an open vendor hold kept off
 * `audit_log`.
 */
export function emitLegalRetentionPruneMetrics(
  sink: LegalRetentionMetricSink,
  result: LegalRetentionPruneResult,
  durationMs: number,
  trigger = 'cron',
): void {
  const base = [`trigger:${trigger}`];
  for (const t of result.tables) {
    sink.count(LEGAL_RETENTION_ROWS_METRIC, t.rowsDeleted, [...base, `table:${t.table}`]);
    if (t.truncated) {
      sink.count(LEGAL_RETENTION_TRUNCATED_METRIC, 1, [...base, `table:${t.table}`]);
    }
  }
  const paused = result.tables.some((t) => t.table === 'audit_log' && t.paused);
  sink.count(
    LEGAL_RETENTION_RUN_METRIC,
    1,
    result.status === 'skipped'
      ? [...base, 'outcome:skipped', `reason:${result.reason}`]
      : [
          ...base,
          'outcome:ok',
          paused ? 'audit:paused' : 'audit:run',
          ...(result.replanned ? ['replanned:true'] : []),
        ],
  );
  sink.distribution(LEGAL_RETENTION_DURATION_METRIC, durationMs, base);
}
