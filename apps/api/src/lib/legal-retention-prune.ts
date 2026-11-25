/**
 * The legal retention prune (AECI-1638, counsel Q23a and Q27c, ADR 0058). The Privacy
 * Policy's "Retention" section makes three promises this module keeps:
 *
 *   - **Audit record:** kept for four years after the action. A hold on one company pauses
 *     the deletion only for that company's records; a global hold pauses it for every
 *     record (ruling 55, AECI-1970, counsel Q66). The audit record of an agreement
 *     acceptance, a Terms of Service acceptance, an account deletion or a company deletion
 *     is kept for as long as the acceptance record it belongs to. The workflow tables,
 *     which record who moved a request and when, are part of that record (ruling 51,
 *     AECI-1913).
 *   - **Agreement acceptance records:** kept while the company has a vendor account and
 *     for six years after it ends, or for five years after a granted subscription ends, if
 *     later, or longer while a legal hold requires it. A claim declined: six years after
 *     that day. A listing request form acceptance, or one whose claim
 *     record is gone: six years after it was given. A deleted company's acceptances: six
 *     years after the company was deleted (AECI-1914, counsel Q67).
 *   - **Terms of Service acceptance records:** kept for as long as the account exists and
 *     for six years after it ends, even after the account is deleted (AECI-1718).
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
 * 2026-11-17, narrowed by ruling 55 of 2026-11-19, AECI-1970):
 *
 *   - **A global hold** stops the run. It deletes nothing and reports `skipped`.
 *   - **A vendor hold** keeps that vendor's acceptance and grant rows, and every audit row
 *     that belongs to that vendor ({@link auditRowOfVendor}). Every other audit row, other
 *     companies' and readers', goes on schedule. Other vendors are pruned as usual.
 *   - **A hold placed after planning** aborts the batch: the first sentinel fires on any
 *     open hold the plan did not read.
 *
 * ─── The four-year audit part ────────────────────────────────────────────────
 *
 * `audit_log` rows with `created_at` before the cutoff go, except the exempt actions of
 * ruling 2 (`AUDIT_LOG_PRUNE_EXEMPT_ACTIONS` / `_PREFIXES` in `@aeci/shared`):
 * `retention.pruned` (the acceptance chain verify reads every one with no date bound, ADR
 * 0057), `litigation_hold.*`, `agreement.*` and `terms.*`. Two more are exempt on a
 * condition, because each dates the six years of the rows that name it: a `vendor.deleted`
 * row while its vendor row is gone and an acceptance or grant still names that vendor
 * (AECI-1914), and an `account.deleted` row while a `terms_acceptances` row still names that
 * profile (AECI-1718). The cutoff is {@link AUDIT_LOG_RETENTION_DAYS} days before today's UTC midnight.
 * A row that belongs to a company under an open vendor hold is kept ({@link auditRowOfVendor}).
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
 * ─── The workflow part (AECI-1913, ruling 51) ───────────────────────────────
 *
 * Four years after the action, the audit cutoff, under the same holds:
 *
 *   - **A `workflow_transitions` row** goes once its `created_at` is past the cutoff. Each
 *     transition is one action, so it goes while its instance lives on.
 *   - **A `workflow_instances` row** goes once its latest action (the latest of
 *     `initiated_at`, `completed_at` and its newest transition) is past the cutoff,
 *     completed or not: a `reviewer_ban` instance is reused for every ban and unban and
 *     never completes, and every writer re-creates a missing instance (the Linear webhook
 *     through the request's own `linear_issue_id`). The instance of a request still `open`
 *     or `in_review` is kept while it names no actor, because the reconciliation sweep
 *     needs it. A contest or protest instance is not kept: every contest writer
 *     re-creates it (`./workflow-restore`). The FK cascade
 *     removes its transitions, and `integration_field_challenges.workflow_id` and
 *     `.protest_workflow_id` go to NULL, counted as `contestLinksCleared`.
 *   - **A vendor hold** keeps the held company's instances, and their transitions, by the
 *     ties of {@link workflowRowOfVendor}.
 *
 * No acceptance record names a workflow row, so none is kept longer. Not chained, so the
 * run record carries counts, no ids.
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
 * Every acceptance row must have a date its period runs from (Chris's rulings 48 and 50,
 * AECI-1914). A row goes once it was accepted at least
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
 * too): their predicate reads whether the rows they date still exist.
 *
 * ─── The Terms acceptance part (AECI-1718) ───────────────────────────────────
 *
 * A `terms_acceptances` row goes once it was accepted six calendar years ago, no global hold
 * is open, its profile row is gone, and the latest `account.deleted` audit row for that
 * profile is at least six years old ({@link termsAcceptancePrunePredicate}). Chris's ruling 1
 * of 2026-11-19: that audit row dates the end of the account. `DELETE /api/account` writes it
 * in the batch that deletes the profile, so no column on the acceptance is needed. Ruling 2:
 * a row whose profile is gone with no `account.deleted` row is kept, and the
 * `acceptance_without_retention_date` data-quality check counts it. Its companions go in the
 * same batch, after the Terms delete:
 *
 *   - `terms.accepted` is filed under its acceptance (`entity_id`).
 *   - `terms.evidence_removed` lists its acceptances in `metadata.acceptance_ids`. It goes
 *     once none is left, in `(created_at, id)` chunks, like `agreement.evidence_removed`.
 *   - `account.deleted` is filed under the profile (`entity_id`). It goes once no Terms row
 *     names that profile, checked for the profiles this run prunes.
 *
 * **Released holds.** A `litigation_holds` row and its `litigation_hold.*` audit rows go
 * four years after `released_at` (the audit cutoff), never while the hold is open. The row's
 * `reason` is free text that can name a person. An open hold on the same company keeps a
 * released vendor hold, and any open hold keeps a released global hold, whose matter may
 * concern anyone (AECI-1970). The table is not chained, so the run record carries its count,
 * no ids.
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
import {
  agreementAcceptances,
  auditLog,
  licenseGrants,
  integrationFieldChallenges,
  litigationHolds,
  termsAcceptances,
  workflowInstances,
  workflowTransitions,
} from '../db/schema';
import {
  AGREEMENT_EVIDENCE_REMOVED_ACTION,
  TERMS_EVIDENCE_REMOVED_ACTION,
} from './acceptance-evidence-removal';
import { AGREEMENT_ACCEPTANCE_ENTITY_TYPE, AGREEMENT_LINKED_ACTION } from './agreement-acceptances';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { TERMS_ACCEPTANCE_ENTITY_TYPE } from './reader-legal-acceptance';
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
  'terms_acceptances',
  'workflow_instances',
  'workflow_transitions',
] as const;
export type LegalPrunableTable = (typeof LEGAL_PRUNABLE)[number];

/** The `audit_log` action `lib/retract-vendor.ts` writes when it deletes a vendor row. Its
 *  `entity_id` is the vendor id and its `created_at` dates the deletion. */
export const VENDOR_DELETED_ACTION = 'vendor.deleted';

/** The `audit_log` action `DELETE /api/account` (`routes/account.ts`) writes in the batch
 *  that deletes the profile. Its `entity_id` is the profile id and its `created_at` dates the
 *  end of the account, so it dates the six years a Terms acceptance is kept (AECI-1718). */
export const ACCOUNT_DELETED_ACTION = 'account.deleted';

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
  /** True only on a `skipped` run, when an open global hold paused the whole table. A vendor
   *  hold no longer pauses a table: it keeps that company's rows (ruling 55, AECI-1970). */
  paused?: boolean;
  /** `audit_log` only: the `agreement.*` rows deleted because their acceptances are gone
   *  (`agreement.accepted`, `agreement.linked`, `agreement.evidence_removed`), the
   *  `vendor.deleted` rows of gone vendors whose last acceptance or grant went, the `terms.*`
   *  rows of deleted Terms acceptances (`terms.accepted`, `terms.evidence_removed`), and the
   *  `account.deleted` rows of profiles whose last Terms acceptance went. Counted in
   *  `rowsDeleted` too. */
  companionRowsDeleted?: number;
  /** `audit_log` only: the `litigation_hold.*` rows of holds released four years ago.
   *  Counted in `rowsDeleted` too. */
  holdAuditRowsDeleted?: number;
  /** `workflow_instances` only: the field contests whose `workflow_id` or
   *  `protest_workflow_id` named a deleted instance, set to NULL by the FK (AECI-1913). A
   *  count of contest rows, not of instances. */
  contestLinksCleared?: number;
  /** `workflow_transitions` only: the transitions removed by the cascade from a deleted
   *  instance. Counted in `rowsDeleted` too. */
  cascadeRowsDeleted?: number;
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

/** The cutoff each table is pruned against. */
function cutoffOf(table: LegalPrunableTable, cutoffs: ReturnType<typeof legalCutoffs>): string {
  switch (table) {
    case 'agreement_acceptances':
    case 'terms_acceptances':
      return cutoffs.acceptance;
    case 'license_grants':
      return cutoffs.grant;
    default:
      return cutoffs.audit;
  }
}

/**
 * Every table at zero, in {@link LEGAL_PRUNABLE} order: the report of a run that deleted
 * nothing. `paused` marks the four-year tables a global hold stopped. One list, so a
 * skipped run never drops a table from the zero-filled metric series.
 */
function zeroTables(cutoffs: ReturnType<typeof legalCutoffs>, paused = false): LegalPrunedTable[] {
  const pausable = new Set<LegalPrunableTable>([
    'audit_log',
    'litigation_holds',
    'workflow_instances',
    'workflow_transitions',
  ]);
  return LEGAL_PRUNABLE.map((table) => ({
    table,
    cutoff: cutoffOf(table, cutoffs),
    rowsDeleted: 0,
    truncated: false,
    ...(paused && pausable.has(table) ? { paused: true } : {}),
  }));
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
 * an ordinary four-year row.
 *
 * An `account.deleted` row is exempt while any `terms_acceptances` row names its profile
 * (AECI-1718): it dates the six years those rows are kept. The legal prune deletes it in the
 * batch that removes the last of them. A deleted account that never accepted a Terms version
 * leaves an ordinary four-year row. Correlated EXISTS only, no bind.
 *
 * No open global hold, and no open vendor hold whose company the row belongs to
 * ({@link auditRowOfVendor}, ruling 55, AECI-1970).
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
    sql`(${auditLog.action} <> ${ACCOUNT_DELETED_ACTION}
      OR NOT EXISTS (SELECT 1 FROM "terms_acceptances" "ap_t" WHERE "ap_t"."profile_id" = "audit_log"."entity_id"))`,
    // Ruling 55 (AECI-1970): a global hold keeps every row (the run stops on one before
    // planning, and the guarded DELETE repeats it), a vendor hold keeps only its company's.
    NO_GLOBAL_HOLD,
    sql`NOT ${AUDIT_ROW_UNDER_VENDOR_HOLD}`,
  ) as SQL;
}

// The company ties shared by `audit_log` ({@link auditRowOfVendor}) and the workflow tables
// ({@link workflowRowOfVendor}). Each takes the company's id as an SQL expression.

/** The ids of the company's products (`product_vendors`), as a subquery. */
const productsOf = (vendorId: SQL) =>
  sql`SELECT "ov_pv"."product_id" FROM "product_vendors" "ov_pv" WHERE "ov_pv"."vendor_id" = ${vendorId}`;

/** An integration the company built, or with its product at either end or as `powered_by`. */
const integrationOfVendor = (vendorId: SQL, integrationId: SQL) => sql`EXISTS (
      SELECT 1 FROM "integrations" "ov_i"
      WHERE "ov_i"."id" = ${integrationId}
        AND ("ov_i"."built_by_vendor_id" = ${vendorId}
          OR "ov_i"."source_product_id" IN (${productsOf(vendorId)})
          OR "ov_i"."target_product_id" IN (${productsOf(vendorId)})
          OR "ov_i"."powered_by_product_id" IN (${productsOf(vendorId)}))
    )`;

/** A connector-evidenced pair (Addendum B): the company built it, or owns either end or the
 *  connector. */
const evidencedPairOfVendor = (vendorId: SQL, pairId: SQL) => sql`EXISTS (
      SELECT 1 FROM "connector_evidenced_pairs" "ov_e"
      WHERE "ov_e"."id" = ${pairId}
        AND ("ov_e"."built_by_vendor_id" = ${vendorId}
          OR "ov_e"."connector_product_id" IN (${productsOf(vendorId)})
          OR "ov_e"."product_a_id" IN (${productsOf(vendorId)})
          OR "ov_e"."product_b_id" IN (${productsOf(vendorId)}))
    )`;

/** A connector catalog belongs to the company that owns its connector product. */
const catalogOfVendor = (vendorId: SQL, catalogId: SQL) => sql`EXISTS (
      SELECT 1 FROM "connector_catalogs" "ov_k"
      WHERE "ov_k"."id" = ${catalogId}
        AND "ov_k"."connector_product_id" IN (${productsOf(vendorId)})
    )`;

/** A reached connector pair (Addendum C): its catalog is the company's, or either stub is
 *  mapped to one of the company's products. */
const connectorPairOfVendor = (vendorId: SQL, pairId: SQL) => sql`EXISTS (
      SELECT 1 FROM "connector_pairs" "ov_cp"
      WHERE "ov_cp"."id" = ${pairId}
        AND (${catalogOfVendor(vendorId, sql`"ov_cp"."catalog_id"`)}
          OR EXISTS (
            SELECT 1 FROM "connector_stub_mappings" "ov_m"
            WHERE "ov_m"."stub_id" IN ("ov_cp"."stub_a_id", "ov_cp"."stub_b_id")
              AND "ov_m"."product_id" IN (${productsOf(vendorId)})
          ))
    )`;

/** A claim, by whichever of its three anchors is set. */
const claimOfVendor = (vendorId: SQL, claimId: SQL) => sql`EXISTS (
      SELECT 1 FROM "claims" "ov_c" WHERE "ov_c"."id" = ${claimId}
        AND (${integrationOfVendor(vendorId, sql`"ov_c"."integration_id"`)}
          OR ${evidencedPairOfVendor(vendorId, sql`"ov_c"."connector_evidenced_pair_id"`)}
          OR ${connectorPairOfVendor(vendorId, sql`"ov_c"."connector_pair_id"`)})
    )`;

/** A `vendor_requests` row whose request targets the company, or one of its products (the
 *  legacy product-target shape). */
const vendorRequestOfVendor = (vendorId: SQL, requestId: SQL) => sql`EXISTS (
          SELECT 1 FROM "vendor_requests" "ov_q" WHERE "ov_q"."id" = ${requestId}
            AND (("ov_q"."target_type" = 'vendor' AND "ov_q"."target_id" = ${vendorId})
              OR ("ov_q"."target_type" = 'product' AND "ov_q"."target_id" IN (${productsOf(vendorId)}))))`;

/** A review of one of the company's products. */
const reviewOfVendor = (vendorId: SQL, reviewId: SQL) => sql`EXISTS (
          SELECT 1 FROM "reviews" "ov_r" WHERE "ov_r"."id" = ${reviewId}
            AND "ov_r"."product_id" IN (${productsOf(vendorId)}))`;

/** A profile that is one of the company's current seats (`profiles.vendor_id`). */
const seatsOf = (vendorId: SQL) =>
  sql`SELECT "ov_p"."id" FROM "profiles" "ov_p" WHERE "ov_p"."vendor_id" = ${vendorId}`;

/**
 * True when the `audit_log` row of the enclosing statement belongs to the company `vendorId`
 * names (an SQL expression). Ruling 55 (AECI-1970, counsel Q66): a vendor hold pauses the
 * four-year deletion only for that company's records. The enclosing statement must read
 * `audit_log` unaliased.
 *
 * A row belongs to the company when any of these ties holds. Each is a key the row itself
 * carries, read against the current state of the tables it names:
 *
 *   1. **The `vendor_id` column** names it (every row about a vendor since migration `0063`,
 *      AECI-1192: the acting vendor, the vendor holding the entity, a notice's recipient).
 *   2. **It is filed under the company**: `entity_type` `vendor` or `vendor_entitlement`,
 *      whose `entity_id` is the vendor id.
 *   3. **Its legacy metadata names it**: `metadata.vendor_id` or `metadata.vendorId`, the
 *      only vendor key on rows written before `0063` (no backfill, ruling 2026-10-04).
 *   4. **It is about one of the company's products or relationships** (`product_vendors`):
 *      the `product_id` column, a `product` row, a `review` of that product, an
 *      `integration` the company built or with its product at either end or as `powered_by`,
 *      a `connector_evidenced_pair` it built or with its product at either end or as the
 *      connector, a `connector_pair` whose catalog is its connector's or whose stub maps to
 *      its product, a `connector_catalog` of its connector, and a `claim` or `attestation`
 *      on any of those three anchors. Promote writes and product retractions name no vendor,
 *      so this is how they are reached.
 *   5. **It is about a claim on the company**: a `vendor_request` row whose request targets
 *      the company, or one of its products (the legacy product-target shape).
 *   6. **One of the company's current seats wrote it** (`profiles.vendor_id`), whatever it
 *      is about.
 *
 * A row none of these reach is not the company's, and goes on schedule. The gap is a row
 * whose only link was an entity already deleted, written before `0063` with no vendor key,
 * or by a former seat before `0063`. The runbook (`docs/runbooks/legal.md`) says to place a
 * global hold when the matter needs those, or when its scope is not yet known.
 *
 * The JSON test is behind `CASE WHEN json_valid(…)`: a malformed value is never parsed, so
 * it can neither match nor raise the "malformed JSON" error the race sentinel uses. No bind
 * except the fixed action literals, so the bind count does not grow with the hold count.
 */
export function auditRowOfVendor(vendorId: SQL): SQL {
  return sql`(
    "audit_log"."vendor_id" = ${vendorId}
    OR ("audit_log"."entity_type" IN ('vendor', 'vendor_entitlement') AND "audit_log"."entity_id" = ${vendorId})
    OR (CASE WHEN json_valid("audit_log"."metadata") THEN
          json_extract("audit_log"."metadata", '$.vendor_id') = ${vendorId}
          OR json_extract("audit_log"."metadata", '$.vendorId') = ${vendorId}
        ELSE 0 END)
    OR "audit_log"."product_id" IN (${productsOf(vendorId)})
    OR ("audit_log"."entity_type" = 'product' AND "audit_log"."entity_id" IN (${productsOf(vendorId)}))
    OR ("audit_log"."entity_type" = 'integration' AND ${integrationOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR ("audit_log"."entity_type" = 'connector_evidenced_pair' AND ${evidencedPairOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR ("audit_log"."entity_type" = 'connector_pair' AND ${connectorPairOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR ("audit_log"."entity_type" = 'connector_catalog' AND ${catalogOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR ("audit_log"."entity_type" = 'claim' AND ${claimOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR ("audit_log"."entity_type" = 'attestation' AND EXISTS (
          SELECT 1 FROM "attestations" "ov_at"
          WHERE "ov_at"."id" = "audit_log"."entity_id"
            AND ${claimOfVendor(vendorId, sql`"ov_at"."claim_id"`)}))
    OR ("audit_log"."entity_type" = 'review' AND ${reviewOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR ("audit_log"."entity_type" = 'vendor_request' AND ${vendorRequestOfVendor(vendorId, sql`"audit_log"."entity_id"`)})
    OR "audit_log"."actor_id" IN (${seatsOf(vendorId)})
  )`;
}

/** True when an open vendor hold covers the `audit_log` row of the enclosing statement. */
const AUDIT_ROW_UNDER_VENDOR_HOLD = sql`EXISTS (
  SELECT 1 FROM "litigation_holds" "lh_vh"
  WHERE "lh_vh"."released_at" IS NULL
    AND "lh_vh"."scope" = 'vendor'
    AND "lh_vh"."vendor_id" IS NOT NULL
    AND ${auditRowOfVendor(sql`"lh_vh"."vendor_id"`)}
)`;

/**
 * True when the `workflow_instances` row of the enclosing statement belongs to the company
 * `vendorId` names (an SQL expression), for a vendor hold (AECI-1913, ruling 51). The
 * enclosing statement must read `workflow_instances` unaliased. `entity_id` carries no FK,
 * so each type is read against the table it names (`DATABASE_SCHEMA.md` §8.2):
 *
 *   1. **A claim or correction on the company**: `vendor_claim` or `correction_request`
 *      whose `entity_id` is a `vendor_requests` row targeting the company or its product.
 *   2. **A field contest about the company**: `correction_request` whose `entity_id` is an
 *      `integration_field_challenges` row the company submitted or owns, or whose
 *      integration or evidenced pair is the company's.
 *   3. **Moderation of a review of its product**: `review_moderation` on such a review.
 *   4. **A ban of one of its current seats**: `reviewer_ban` on a profile of the company.
 *   5. **What its current seats did**: `initiated_by`, or the `actor_id` of any of the
 *      instance's transitions, is one of the company's current seats.
 *
 * These are the categories the Privacy Policy's hold sentence lists, and the same ties
 * {@link auditRowOfVendor} reads. A transition belongs to the company when its instance
 * does, so a held instance keeps all of its transitions. No bind except fixed literals.
 */
export function workflowRowOfVendor(vendorId: SQL): SQL {
  const entity = sql`"workflow_instances"."entity_id"`;
  return sql`(
    ("workflow_instances"."workflow_type" IN ('vendor_claim', 'correction_request')
      AND ${vendorRequestOfVendor(vendorId, entity)})
    OR ("workflow_instances"."workflow_type" = 'correction_request' AND EXISTS (
          SELECT 1 FROM "integration_field_challenges" "wv_fc"
          WHERE "wv_fc"."id" = ${entity}
            AND ("wv_fc"."submitter_vendor_id" = ${vendorId}
              OR "wv_fc"."owner_vendor_id" = ${vendorId}
              OR ${integrationOfVendor(vendorId, sql`"wv_fc"."integration_id"`)}
              OR ${evidencedPairOfVendor(vendorId, sql`"wv_fc"."evidenced_pair_id"`)})))
    OR ("workflow_instances"."workflow_type" = 'review_moderation'
      AND ${reviewOfVendor(vendorId, entity)})
    OR ("workflow_instances"."workflow_type" = 'reviewer_ban' AND ${entity} IN (${seatsOf(vendorId)}))
    OR "workflow_instances"."initiated_by" IN (${seatsOf(vendorId)})
    OR EXISTS (
      SELECT 1 FROM "workflow_transitions" "wv_t"
      WHERE "wv_t"."workflow_id" = "workflow_instances"."id"
        AND "wv_t"."actor_id" IN (${seatsOf(vendorId)}))
  )`;
}

/** True when an open vendor hold covers the `workflow_instances` row of the enclosing
 *  statement. */
const WORKFLOW_UNDER_VENDOR_HOLD = sql`EXISTS (
  SELECT 1 FROM "litigation_holds" "lh_wh"
  WHERE "lh_wh"."released_at" IS NULL
    AND "lh_wh"."scope" = 'vendor'
    AND "lh_wh"."vendor_id" IS NOT NULL
    AND ${workflowRowOfVendor(sql`"lh_wh"."vendor_id"`)}
)`;

/**
 * The latest action on the `workflow_instances` row of the enclosing statement: the latest
 * of `initiated_at`, `completed_at` and its newest transition's `created_at`. ISO-8601
 * text, so `max` orders it as time; `''` stands in for a missing value.
 */
const WORKFLOW_LAST_ACTION = sql`max(
  "workflow_instances"."initiated_at",
  COALESCE("workflow_instances"."completed_at", ''),
  COALESCE((SELECT max("wl_t"."created_at") FROM "workflow_transitions" "wl_t"
    WHERE "wl_t"."workflow_id" = "workflow_instances"."id"), '')
)`;

/**
 * True when the `workflow_instances` row of the enclosing statement is the workflow of a
 * request that is still `open` or `in_review`. Such an instance is kept, however old its
 * last action: the request reconciliation sweep (`lib/reconciliation-sweep.ts`) retries a
 * stuck open request only through its instance, and the Linear link-back writes the issue
 * id onto it. Its transitions still go by their own date. Only an instance with no
 * `initiated_by` is kept: a request instance never carries one (the submit is anonymous,
 * `routes/requests.ts`), so what stays names no one, and its `initiated_at` is the
 * request's own `created_at`, which the live request row holds anyway. An instance that
 * did name an actor is pruned on schedule like any other.
 */
const WORKFLOW_OF_OPEN_REQUEST = sql`(
  "workflow_instances"."workflow_type" IN ('vendor_claim', 'correction_request')
  AND "workflow_instances"."initiated_by" IS NULL
  AND EXISTS (
    SELECT 1 FROM "vendor_requests" "wo_q"
    WHERE "wo_q"."id" = "workflow_instances"."entity_id"
      AND "wo_q"."status" IN ('open', 'in_review')
  )
)`;

/**
 * One `workflow_instances` row is due (AECI-1913, ruling 51): its latest action
 * ({@link WORKFLOW_LAST_ACTION}) is before the four-year cutoff, no global hold is open, and
 * no open vendor hold covers it, and it is not the workflow of an open request
 * ({@link WORKFLOW_OF_OPEN_REQUEST}). Completed or not: a `reviewer_ban` instance is reused
 * for every ban and unban and never completes. Every writer re-creates a missing instance,
 * the Linear webhook through the request's own `linear_issue_id` and every contest writer
 * through `./workflow-restore`.
 * Deleting it cascades its transitions (all past the cutoff too) and sets the contest
 * links (`integration_field_challenges.workflow_id`, `.protest_workflow_id`) to NULL. The
 * enclosing statement must read `workflow_instances` unaliased.
 */
export function workflowInstancePrunePredicate(cutoff: string): SQL {
  return sql`(
    ${WORKFLOW_LAST_ACTION} < ${cutoff}
    AND ${NO_GLOBAL_HOLD}
    AND NOT ${WORKFLOW_UNDER_VENDOR_HOLD}
    AND NOT ${WORKFLOW_OF_OPEN_REQUEST}
  )`;
}

/**
 * One `workflow_transitions` row is due (AECI-1913, ruling 51): it was written before the
 * four-year cutoff, no global hold is open, and no open vendor hold covers its instance.
 * Each transition is one action, so an old one goes while its instance lives on. The
 * enclosing statement must read `workflow_transitions` unaliased.
 */
export function workflowTransitionPrunePredicate(cutoff: string): SQL {
  return sql`(
    "workflow_transitions"."created_at" < ${cutoff}
    AND ${NO_GLOBAL_HOLD}
    AND NOT EXISTS (
      SELECT 1 FROM "workflow_instances"
      WHERE "workflow_instances"."id" = "workflow_transitions"."workflow_id"
        AND ${WORKFLOW_UNDER_VENDOR_HOLD}
    )
  )`;
}

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

/**
 * True when the profile id `profileId` (an SQL expression) has no `profiles` row and the
 * latest `account.deleted` audit row for it is older than `cutoff` (Chris's ruling 1 of
 * 2026-11-19, AECI-1718). That row is written in the batch that deletes the profile, so it
 * dates the end of the account. With no `account.deleted` row the `max` is NULL, so it never
 * matches: the row is kept and the `acceptance_without_retention_date` data-quality check
 * counts it (ruling 2). A profile that exists again (the shared staging login signing in
 * after a deletion) keeps its rows. A reader account has no vendor, so only a global hold
 * keeps it, and the run stops on one.
 */
function accountGoneBefore(profileId: SQL, cutoff: string): SQL {
  return sql`(
    NOT EXISTS (SELECT 1 FROM "profiles" "ag_p" WHERE "ag_p"."id" = ${profileId})
    AND (
      SELECT max("ag_a"."created_at") FROM "audit_log" "ag_a"
      WHERE "ag_a"."entity_type" = 'profile'
        AND "ag_a"."entity_id" = ${profileId}
        AND "ag_a"."action" = ${ACCOUNT_DELETED_ACTION}
    ) < ${cutoff}
  )`;
}

/**
 * One `terms_acceptances` row is due (AECI-1718): accepted before the acceptance cutoff, no
 * open global hold, and its account ended before the cutoff ({@link accountGoneBefore}). The
 * Privacy Policy keeps it "for as long as your account exists and for six years after it
 * ends". The bind count is fixed.
 */
export function termsAcceptancePrunePredicate(cutoffs: { acceptance: string }): SQL {
  return sql`(
    "terms_acceptances"."accepted_at" < ${cutoffs.acceptance}
    AND ${NO_GLOBAL_HOLD}
    AND ${accountGoneBefore(sql`"terms_acceptances"."profile_id"`, cutoffs.acceptance)}
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

/** The two acceptance tables whose ids an `*.evidence_removed` audit row lists. */
type AcceptanceTable = 'agreement_acceptances' | 'terms_acceptances';

/**
 * True when every acceptance id listed at `path` of the JSON column `column` is gone from
 * `table`. `planned` are the ids this run's batch deletes before the
 * statement runs: a planning read passes them so it sees the state the delete will see. The
 * batch statement itself passes none, because by then they are gone.
 *
 * Both writers store the column as JSON text (`auditInsert` through Drizzle's json mode,
 * `auditInsertWhere` through `JSON.stringify`), so one shape exists. A value that is not
 * valid JSON, has no array at `path`, or an empty one, is never matched: it is kept. The
 * nested `CASE` keeps `json_type` and `json_each` off a malformed value, whose error would
 * abort the batch. The id list is read from the row, so the bind count never grows.
 */
function acceptanceIdsAllGone(
  column: SQL,
  path: string,
  planned: readonly string[],
  table: AcceptanceTable = 'agreement_acceptances',
): SQL {
  // `table` is one of two fixed names, never input, so `sql.raw` binds nothing unsafe.
  const source = sql.raw(`"${table}"`);
  const stillKept =
    planned.length > 0
      ? sql`"aa_keep"."id" NOT IN (SELECT value FROM json_each(${JSON.stringify(planned)}))`
      : sql`1`;
  return sql`(CASE WHEN json_valid(${column}) THEN
      CASE WHEN json_type(${column}, ${path}) = 'array' AND json_array_length(${column}, ${path}) > 0
      THEN NOT EXISTS (
        SELECT 1 FROM json_each(${column}, ${path}) "aa_j"
        WHERE "aa_j"."value" IN (SELECT "aa_keep"."id" FROM ${source} "aa_keep" WHERE ${stillKept})
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

/** `terms.evidence_removed` rows older than the acceptance cutoff whose Terms acceptances are
 *  all gone. They carry no vendor or entity id, so the age bounds the scan. */
function termsEvidenceWhere(cutoff: string, planned: readonly string[]): SQL {
  return and(
    eq(auditLog.action, TERMS_EVIDENCE_REMOVED_ACTION),
    lt(auditLog.createdAt, cutoff),
    acceptanceIdsAllGone(
      sql`${auditLog.metadata}`,
      '$.acceptance_ids',
      planned,
      'terms_acceptances',
    ),
  ) as SQL;
}

/**
 * `account.deleted` rows of the profiles whose Terms acceptances this run prunes
 * (`profileIds`), older than the acceptance cutoff, once no `terms_acceptances` row names
 * that profile and no `profiles` row exists for it. `planned` are the Terms ids the batch
 * deletes first: a planning read passes them, the batch statement passes none.
 */
function accountDeletedWhere(
  profileIds: readonly string[],
  cutoff: string,
  planned: readonly string[],
): SQL {
  const kept =
    planned.length > 0
      ? sql`AND "ad_t"."id" NOT IN (SELECT value FROM json_each(${JSON.stringify(planned)}))`
      : sql``;
  return and(
    eq(auditLog.action, ACCOUNT_DELETED_ACTION),
    eq(auditLog.entityType, 'profile'),
    inJsonList(sql`${auditLog.entityId}`, profileIds),
    lt(auditLog.createdAt, cutoff),
    sql`NOT EXISTS (SELECT 1 FROM "profiles" "ad_p" WHERE "ad_p"."id" = "audit_log"."entity_id")`,
    sql`NOT EXISTS (SELECT 1 FROM "terms_acceptances" "ad_t" WHERE "ad_t"."profile_id" = "audit_log"."entity_id" ${kept})`,
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

  const holds = await db
    .select({
      id: litigationHolds.id,
      scope: litigationHolds.scope,
      vendorId: litigationHolds.vendorId,
    })
    .from(litigationHolds)
    .where(isNull(litigationHolds.releasedAt));
  const vendorHolds = holds.filter((h) => h.scope === 'vendor').length;

  if (holds.some((h) => h.scope === 'global')) {
    return {
      status: 'skipped',
      reason: 'litigation_hold',
      tables: zeroTables(cutoffs, true),
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

  // ── Terms acceptances (AECI-1718) ────────────────────────────────────────
  // `terms.accepted` is filed under its acceptance. `terms.evidence_removed` lists acceptance
  // ids in `metadata.acceptance_ids` and goes once none is left. `account.deleted` goes once
  // no Terms row names its profile. Each is counted against the state the batch will leave.
  const termsWhere = termsAcceptancePrunePredicate(cutoffs);
  const terms = await capIds(
    db
      .select({ id: termsAcceptances.id })
      .from(termsAcceptances)
      .where(termsWhere)
      .orderBy(asc(termsAcceptances.acceptedAt), asc(termsAcceptances.id))
      .limit(LEGAL_RETENTION_IDS_PER_TABLE + 1),
  );
  const termsIdCol = sql`"terms_acceptances"."id"`;
  const prunedProfileIds =
    terms.ids.length > 0
      ? (
          await db
            .selectDistinct({ profileId: termsAcceptances.profileId })
            .from(termsAcceptances)
            .where(inJsonList(termsIdCol, terms.ids))
        ).map((r) => r.profileId)
      : [];
  const termsAcceptedWhere = and(
    sql`${auditLog.entityType} = ${TERMS_ACCEPTANCE_ENTITY_TYPE}`,
    sql`${auditLog.action} LIKE ${likePrefix('terms.')} ESCAPE '\\'`,
    inJsonList(sql`${auditLog.entityId}`, terms.ids),
  ) as SQL;
  const termsAccepted = terms.ids.length > 0 ? await countAudit(termsAcceptedWhere) : 0;
  const termsEvidence = await planKeyChunks(
    db,
    termsEvidenceWhere(cutoffs.acceptance, terms.ids),
    termsEvidenceWhere(cutoffs.acceptance, []),
  );
  const accountDeleted =
    prunedProfileIds.length > 0
      ? await countAudit(accountDeletedWhere(prunedProfileIds, cutoffs.acceptance, terms.ids))
      : 0;

  const companions =
    accepted +
    linked +
    evidence.rowsDeleted +
    vendorDeleted +
    termsAccepted +
    termsEvidence.rowsDeleted +
    accountDeleted;

  // ── The four-year audit part, and holds released four years ago ──────────
  // Ruling 55 (AECI-1970): an open vendor hold no longer pauses this part. The predicate
  // keeps the rows of each held company ({@link auditRowOfVendor}) and deletes the rest.
  const audit: AuditPlan = await planAuditChunks(db, cutoffs.audit);
  // A released vendor hold is kept while an open hold covers the same company, and a
  // released global hold while any hold is open: its matter may concern anyone.
  const releasedHoldWhere = and(
    isNotNull(litigationHolds.releasedAt),
    lt(litigationHolds.releasedAt, cutoffs.audit),
    sql`NOT EXISTS (
      SELECT 1 FROM "litigation_holds" "lh_open"
      WHERE "lh_open"."released_at" IS NULL
        AND ("lh_open"."scope" = 'global'
          OR "litigation_holds"."scope" = 'global'
          OR "lh_open"."vendor_id" = "litigation_holds"."vendor_id")
    )`,
  ) as SQL;
  const releasedHolds = await capIds(
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

  // ── The workflow tables, four years after the action (AECI-1913) ─────────
  // An instance whose latest action is past the cutoff goes whole: the FK cascade removes
  // its transitions and sets its contest links to NULL. A transition past the cutoff on an
  // instance that stays goes on its own. Both are counted here against the batch's state.
  const instanceWhere = workflowInstancePrunePredicate(cutoffs.audit);
  const transitionWhere = workflowTransitionPrunePredicate(cutoffs.audit);
  const instances = await capIds(
    db
      .select({ id: workflowInstances.id })
      .from(workflowInstances)
      .where(instanceWhere)
      .orderBy(asc(workflowInstances.initiatedAt), asc(workflowInstances.id))
      .limit(LEGAL_RETENTION_IDS_PER_TABLE + 1),
  );
  const instanceIdCol = sql`"workflow_instances"."id"`;
  const transitionIdCol = sql`"workflow_transitions"."id"`;
  const cascadeWhere = inJsonList(sql`"workflow_transitions"."workflow_id"`, instances.ids);
  const countRows = async (
    table: typeof workflowTransitions | typeof integrationFieldChallenges,
    where: SQL,
  ) => {
    const [row] = await db
      .select({ n: sql<number>`count(*)` })
      .from(table)
      .where(where);
    return Number(row?.n ?? 0);
  };
  const cascaded =
    instances.ids.length > 0 ? await countRows(workflowTransitions, cascadeWhere) : 0;
  const contestLinkWhere = sql`(${inJsonList(sql`"integration_field_challenges"."workflow_id"`, instances.ids)}
    OR ${inJsonList(sql`"integration_field_challenges"."protest_workflow_id"`, instances.ids)})`;
  const contestLinks =
    instances.ids.length > 0 ? await countRows(integrationFieldChallenges, contestLinkWhere) : 0;
  const transitions = await capIds(
    db
      .select({ id: workflowTransitions.id })
      .from(workflowTransitions)
      .where(and(transitionWhere, instances.ids.length > 0 ? sql`NOT ${cascadeWhere}` : undefined))
      .orderBy(asc(workflowTransitions.createdAt), asc(workflowTransitions.id))
      .limit(LEGAL_RETENTION_IDS_PER_TABLE + 1),
  );

  const tables: LegalPrunedTable[] = [
    {
      table: 'audit_log',
      cutoff: cutoffs.audit,
      rowsDeleted: audit.rowsDeleted + companions + holdAudit,
      truncated: audit.truncated || evidence.truncated || termsEvidence.truncated,
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
    },
    {
      table: 'terms_acceptances',
      cutoff: cutoffs.acceptance,
      rowsDeleted: terms.ids.length,
      truncated: terms.truncated,
    },
    {
      table: 'workflow_instances',
      cutoff: cutoffs.audit,
      rowsDeleted: instances.ids.length,
      truncated: instances.truncated,
      ...(contestLinks > 0 ? { contestLinksCleared: contestLinks } : {}),
    },
    {
      table: 'workflow_transitions',
      cutoff: cutoffs.audit,
      rowsDeleted: transitions.ids.length + cascaded,
      truncated: transitions.truncated,
      ...(cascaded > 0 ? { cascadeRowsDeleted: cascaded } : {}),
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
  // A hold placed after the read aborts the batch, whatever its scope: the plan was read
  // without it, so a row it covers may be in a chunk. The replan reads it. Every predicate
  // also checks the holds itself, so this is the explicit form of the same rule.
  statements.push(
    abortWhen(
      db,
      sql`EXISTS (SELECT 1 FROM "litigation_holds" "lh_new" WHERE "lh_new"."released_at" IS NULL AND "lh_new"."id" NOT IN (SELECT value FROM json_each(${JSON.stringify(holds.map((h) => h.id))})))`,
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
  // Terms acceptances (AECI-1718), the same pattern: sentinels, the `terms.accepted`
  // companions, the rows, then the JSON-listed and `account.deleted` companions, whose
  // predicates read whether the rows they date still exist. All before the four-year sentinel:
  // once a profile's last Terms row is gone, its `account.deleted` row is no longer exempt
  // from the four-year predicate, so it must be gone before that predicate is counted again.
  if (terms.ids.length > 0) {
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "terms_acceptances" WHERE ${inJsonList(termsIdCol, terms.ids)} AND ${termsWhere}) <> ${terms.ids.length}`,
      ),
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "audit_log" WHERE ${termsAcceptedWhere}) <> ${termsAccepted}`,
      ),
    );
    if (termsAccepted > 0) statements.push(db.delete(auditLog).where(termsAcceptedWhere));
    statements.push(
      db.delete(termsAcceptances).where(and(inJsonList(termsIdCol, terms.ids), termsWhere)),
    );
  }
  if (termsEvidence.rowsDeleted > 0 && termsEvidence.last) {
    const upTo = sql`(${auditLog.createdAt}, ${auditLog.id}) <= (${termsEvidence.last.createdAt}, ${termsEvidence.last.id})`;
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "audit_log" WHERE ${and(termsEvidenceWhere(cutoffs.acceptance, []), upTo)}) <> ${termsEvidence.rowsDeleted}`,
      ),
      ...termsEvidence.statements,
    );
  }
  if (accountDeleted > 0) {
    const where = accountDeletedWhere(prunedProfileIds, cutoffs.acceptance, []);
    statements.push(
      abortWhen(db, sql`(SELECT count(*) FROM "audit_log" WHERE ${where}) <> ${accountDeleted}`),
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
  // The workflow tables (AECI-1913). Sentinels first: every planned row must still be due,
  // and the planned instances must still have exactly the transitions counted for the
  // cascade, or the audit row would name deletes that did not happen. The direct transition
  // delete runs BEFORE the instance delete: its ids exclude the planned instances, so the
  // cascade then removes exactly the counted rows. Neither touches `audit_log`, so the
  // four-year count below is unaffected.
  if (instances.ids.length > 0) {
    const instanceRowsWhere = and(inJsonList(instanceIdCol, instances.ids), instanceWhere) as SQL;
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "workflow_instances" WHERE ${instanceRowsWhere}) <> ${instances.ids.length}`,
      ),
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "workflow_transitions" WHERE ${cascadeWhere}) <> ${cascaded}`,
      ),
    );
  }
  if (transitions.ids.length > 0) {
    const transitionRowsWhere = and(
      inJsonList(transitionIdCol, transitions.ids),
      transitionWhere,
    ) as SQL;
    statements.push(
      abortWhen(
        db,
        sql`(SELECT count(*) FROM "workflow_transitions" WHERE ${transitionRowsWhere}) <> ${transitions.ids.length}`,
      ),
      db.delete(workflowTransitions).where(transitionRowsWhere),
    );
  }
  if (instances.ids.length > 0) {
    statements.push(
      db
        .delete(workflowInstances)
        .where(and(inJsonList(instanceIdCol, instances.ids), instanceWhere)),
    );
  }
  if (audit.rowsDeleted > 0 && audit.last) {
    // The four-year chunks start at the first matching key and cover every key up to
    // `last`, so the rows matching the predicate up to it must be exactly the planned count.
    // A concurrent run that deleted them first makes the count fall short: abort. Nothing
    // earlier in the batch deletes a row this predicate matched at the start of the batch
    // (every `agreement.*`, `terms.*` and `litigation_hold.*` action is exempt from it, and
    // so are a `vendor.deleted` row an acceptance or grant still names and an
    // `account.deleted` row a Terms acceptance still names). The only rows the earlier
    // deletes can bring into it are `vendor.deleted` rows whose last acceptance or grant
    // they removed and `account.deleted` rows whose last Terms acceptance they removed, and
    // the two deletes above have already removed them. So the
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
      // The open vendor holds whose companies' rows this run kept (ruling 55). A count, no
      // vendor id and no reason.
      ...(vendorHolds > 0 ? { vendorHolds } : {}),
      tables: tables
        .filter((t) => t.rowsDeleted > 0)
        .map((t) => ({
          table: t.table,
          cutoff: t.cutoff,
          rowsDeleted: t.rowsDeleted,
          ...(t.companionRowsDeleted ? { companionRowsDeleted: t.companionRowsDeleted } : {}),
          ...(t.holdAuditRowsDeleted ? { holdAuditRowsDeleted: t.holdAuditRowsDeleted } : {}),
          ...(t.contestLinksCleared ? { contestLinksCleared: t.contestLinksCleared } : {}),
          ...(t.cascadeRowsDeleted ? { cascadeRowsDeleted: t.cascadeRowsDeleted } : {}),
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
    return {
      status: 'skipped',
      reason: 'concurrent_run',
      tables: zeroTables(legalCutoffs(now)),
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
 * the liveness heartbeat. `audit:scoped` marks a run that kept the rows of a company under an
 * open vendor hold and deleted the rest (ruling 55, AECI-1970).
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
  sink.count(
    LEGAL_RETENTION_RUN_METRIC,
    1,
    result.status === 'skipped'
      ? [...base, 'outcome:skipped', `reason:${result.reason}`]
      : [
          ...base,
          'outcome:ok',
          result.vendorHolds > 0 ? 'audit:scoped' : 'audit:run',
          ...(result.replanned ? ['replanned:true'] : []),
        ],
  );
  sink.distribution(LEGAL_RETENTION_DURATION_METRIC, durationMs, base);
}
