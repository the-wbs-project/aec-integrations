/**
 * The §7 term-expiry sweep (AECI-613 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §7), re-pointed
 * to `licenses` by AECI-1356 (E1.7, `docs/VENDOR_SIGNUP_PROCESS.md` §3 step 8).
 *
 * A license carries a term (`ends_at`). As it approaches, this job **warns** the
 * vendor's seats and the operator, and stamps `licenses.expiry_notice_sent_at` so a
 * term earns one notice rather than one per night. Run by the daily 11:00 UTC cron
 * (`ENTITLEMENT_EXPIRY_CRON`), queue-less and inline. Since E6 (AECI-1404, AECI-1406) the
 * lapse runs first as a pre-step and the notice carries the price, count, products and
 * terms change; this sweep itself still only warns.
 *
 * ── ONE NOTICE PER ACCOUNT PER TERM ─────────────────────────────────────────────
 *
 * A **term** is one billing account's live licenses that share one `ends_at`. The scan
 * groups by `(billing_account_id, ends_at)`, so an account with three licenses ending on
 * the same day gets ONE notice naming the count, not three. Licenses on one account with
 * different end dates are different terms and each earns its own notice: the email
 * names one date, and two dates are two decisions for the vendor. Today every
 * account's licenses share a term (the admin grant and term edit move them
 * together), so in practice this is one notice per account.
 *
 * ── THE NON-NEGOTIABLE (§7.3) ───────────────────────────────────────────────────
 *
 * **This job never ends a license, never moves an assignment, and never writes
 * `vendors.verified`.** It warns. The lapse is a separate pre-step of the same job
 * (`lib/license-lapse.ts`, AECI-1404) with its own batches, never this one. The only
 * columns this module mutates on `licenses` are `expiry_notice_sent_at` and the row's
 * own `updated_at` (`expiryNoticeStampStatements` in `lib/license.ts`); it emits no
 * statement against `vendors` at all. {@link expiryNoticeStatements} is exported as a
 * pure builder precisely so `entitlement-expiry.spec.ts` can assert that against the
 * generated SQL: no statement in the batch names `ended_at`, `assigned_product_id` or
 * `vendors`. The stamp's WHERE is guarded on `ends_at` as scanned, so a renewal
 * between the scan and the write keeps its cleared stamp.
 *
 * ── WHAT IS STRUCTURALLY INVISIBLE ──────────────────────────────────────────────
 *
 * The scan rides `licenses_ends_idx`, which is PARTIAL (`WHERE "ended_at" IS NULL AND
 * "ends_at" IS NOT NULL`). So a **monthly** license (`ends_at IS NULL`, which renews
 * until cancelled) and every ended license can never be selected. That is by
 * construction, not by a predicate someone must remember.
 *
 * ── THE IDEMPOTENCY FENCE ───────────────────────────────────────────────────────
 *
 * A term is due when ANY of its licenses has a null `expiry_notice_sent_at`, or a stamp
 * that predates `ends_at − EXPIRY_WARNING_DAYS` (it belongs to an EARLIER term). The
 * notice stamps EVERY license it covered. A renewal moves `ends_at` and clears the
 * stamp (`setLicensesTermStatements`), so the new term earns its own notice. One
 * consequence is deliberate: a license added to an already-warned term arrives
 * unstamped, so the term is warned again with the new count. The count is part of the
 * notice (§3 step 8), and a stale count is the worse failure.
 *
 * The comparison is done in TS rather than SQL: it is a column-to-column comparison
 * and therefore unindexable either way, and SQLite's `datetime()` renders
 * `YYYY-MM-DD HH:MM:SS`, which does NOT order lexically against the `…THH:MM:SS.sssZ`
 * form this schema stores. The SQL hands back, per term, the count of unstamped
 * licenses and the OLDEST stamp, which is all the fence needs: every license in a term
 * shares `ends_at`, so the term is due iff any is unstamped or the oldest stamp is stale.
 *
 * ── FAIL-OPEN, AND WHY TWO TEMPLATES ────────────────────────────────────────────
 *
 * The vendor half goes to every seat and the billing account's billing email,
 * each address once (decision 16, `lib/billing-recipients.ts`, AECI-1406). Seat
 * addresses need `fetchAuthUserEmails` and therefore `SUPABASE_SERVICE_ROLE_KEY` —
 * present on staging/demo/prod, absent locally. Without the key only the billing
 * email remains, and with no billing email either the vendor half degrades to
 * `skipped` while the operator copy always lands. The fence is stamped when **either** channel was `sent`: writing
 * it on attempt would silently consume the notice during a Resend outage, and
 * requiring BOTH would re-nag the operator every night on any tier without the
 * service-role key. Nothing here throws — `sendTransactionalEmail` never does, and
 * a batch failure is logged and skipped so one bad term cannot end the sweep.
 */

import { LEGAL_AGREEMENT_CURRENT_VERSIONS } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { compareText } from '@aeci/shared/text-sort';
import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm';

import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { loadBillingEmails, mergeRecipientAddresses } from './billing-recipients';
import {
  emitExpiryDueMetric,
  emitExpiryNoticeMetrics,
  type EntitlementExpiryMetricSink,
  type ExpiryNoticeOutcome,
} from './entitlement-expiry-metrics';
import { parseRecipients, type EmailContext, type EmailOutcome } from './email';
import { expiryNoticeStampStatements, LICENSE_ENTITY_TYPE } from './license';
import { forwardAuditBatch } from './moderation-forward';
import { fetchAuthUserEmails } from './supabase-admin';
import { loadVendorSeatRecipients, type FetchSeatEmails } from './vendor-seat-recipients';
import type { Db } from '../db/client';
import { billingAccounts, licenses, products, vendors } from '../db/schema';
import { logBatchToPosthog, logToPosthog, type PosthogLogEvent } from '../posthog';
import type { Env } from '../env';

const DAY_MS = 86_400_000;

/**
 * How far ahead a term is warned about. Also the width of the idempotency fence:
 * a stamp inside `[ends_at − EXPIRY_WARNING_DAYS, ends_at]` belongs to the
 * current term and suppresses; anything earlier belongs to a previous one.
 *
 * Re-exported from `@aeci/shared/entitlements` rather than declared here: the
 * vendor dashboard's plan panel leans in on the same horizon, and a cron that
 * warned earlier than the dashboard admits anything is wrong would email a paying
 * customer about a problem their own portal denies. One promise, one constant.
 */
export { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';
import {
  EXPIRY_WARNING_DAYS,
  licensePlanSnapshot,
  type LicensePlanRow,
} from '@aeci/shared/entitlements';

/** `audit_log.action` for a delivered warning (§7.3). Audited — rather than
 *  following the `stats_cache` no-audit precedent — because "we warned them on
 *  date X" is precisely the fact an offline-invoice dispute needs, and writing it
 *  keeps §26.1 unqualified. `entity_type`/`entity_id` are the account-keyed pair
 *  `lib/license.ts` established (`billing_account`, the account id), so this row
 *  joins the same `audit_log_entity_idx` trail as every license grant and term
 *  change. ONE row per notice; `metadata.license_ids` names the licenses it covered.
 *  Rows written before AECI-1356 carry `vendor_entitlement.expiry_warned`. */
export const EXPIRY_WARNED_ACTION = 'license.expiry_warned';

/** `metadata.source` on those rows. */
const EXPIRY_AUDIT_SOURCE = 'entitlement-expiry-cron';

/** Vendor ids per plan-snapshot read. D1 caps bound parameters per query. */
const PLAN_READ_CHUNK = 50;

/**
 * Most terms warned per run. A backstop against a first-adoption spike or a
 * mis-entered bulk term, not a design limit. The read that feeds it orders
 * never-warned terms FIRST (`loadExpiring`), so a term that got its notice is
 * stamped and drops to the back of the next run's window rather than
 * re-occupying it — the backlog drains across days instead of repeating, and a
 * genuinely-due term is never starved out of the window by the ever-growing set
 * of already-warned past-term live licenses. The sweep logs the dropped count
 * instead of truncating silently. Counted in terms (account and end date), not
 * licenses.
 */
export const EXPIRY_BATCH_CAP = 200;

// ─── Context + deps ──────────────────────────────────────────────────────────

/** Same structural context the email + Datadog seams take, so the cron can build
 *  one from a synthetic `Request` (`scheduled.ts`'s `cronRequest`). */
export type ExpiryContext = EmailContext;

/** The §7.2 vendor renewal prompt (`entitlement-expiring`). Declared here as a
 *  seam — the §1.3 route-seam pattern — and injected by `scheduled.ts`, so this
 *  module never reaches the Resend transport and the specs never stub a fetch.
 *  Since AECI-1406 it carries what `VENDOR_SIGNUP_PROCESS.md` §3 step 8 lists: the
 *  license count, the products, the sources (which decide renew or end) and whether
 *  a new Managed plan agreement version applies. */
export type SendEntitlementExpiringEmail = (
  c: ExpiryContext,
  opts: {
    to: string;
    vendorName: string;
    periodEndDay: string;
    daysRemaining: number;
    /** How many licenses end on this date. */
    licenseCount: number;
    /** The names of the products those licenses are on, in `compareText` order. */
    productNames: readonly string[];
    /** The licenses' distinct `source` values (`stripe`, `invoice`, `complimentary`). */
    sources: readonly string[];
    /** A license in the term accepted an older Managed plan agreement version. */
    termsChange: boolean;
  },
) => Promise<EmailOutcome>;

/** The §7.2 operator copy (`entitlement-expiring-admin`). Same seam. */
export type SendEntitlementExpiringAdminEmail = (
  c: ExpiryContext,
  opts: {
    to: string;
    vendorName: string;
    vendorSlug: string;
    periodEndDay: string;
    daysRemaining: number;
    licenseCount: number;
    source: string | null;
    reference: string | null;
    vendorNotice: EmailOutcome;
  },
) => Promise<EmailOutcome>;

/** Absent sender → nothing is sent and the run reports `skipped`, which leaves the
 *  fence unstamped and the notice due again tomorrow. Deliberately not a throw:
 *  an uninjected seam must degrade the way a missing API key does. */
const noopSendExpiryEmail: SendEntitlementExpiringEmail = async () => 'skipped';
const noopSendExpiryAdminEmail: SendEntitlementExpiringAdminEmail = async () => 'skipped';

export type { FetchSeatEmails };

export interface ExpiryDeps {
  /** Deterministic clock for the horizon + fence math. */
  now?: Date;
  /** Days of lookahead. Overridable so specs don't have to build 30-day fixtures. */
  warningDays?: number;
  /** Read/warn cap. Overridable so specs can exercise the cap + never-warned-first
   *  ordering without a 200-term fixture; defaults to {@link EXPIRY_BATCH_CAP}. */
  batchCap?: number;
  /** The privileged `auth.users` email seam. Injected so specs never touch it. */
  fetchSeatEmails?: FetchSeatEmails;
  sendVendorEmail?: SendEntitlementExpiringEmail;
  sendAdminEmail?: SendEntitlementExpiringAdminEmail;
  /** Metric sink. Absent → metrics are simply not emitted (local). */
  metrics?: EntitlementExpiryMetricSink;
}

export interface ExpiryResult {
  /** Terms inside the horizon before the fence — the `aeci.entitlement.expiry_due`
   *  gauge. A term is one account's live licenses on one `ends_at`. */
  due: number;
  /** Terms the fence suppressed (already warned for this term). */
  suppressed: number;
  /** Terms dropped by {@link EXPIRY_BATCH_CAP} this run. */
  capped: number;
  /** Terms whose stored `ends_at` could not be parsed, so nothing was sent. */
  malformed: number;
  /** Terms that got at least one delivered notice AND a stamped fence. */
  warned: number;
  /** Per-channel send outcomes. `suppressed` here is the tier delivery policy
   *  (AECI-1198), not the fence: an outside seat on a non-production tier. */
  vendor: Record<EmailOutcome, number>;
  admin: Record<EmailOutcome, number>;
  /** Fence/audit batches that failed to commit (emails already went out). */
  batchFailures: number;
}

/** One term inside the horizon: one billing account's live licenses on one `ends_at`. */
interface ExpiringTerm {
  billingAccountId: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  endsAt: string;
  /** Every license in the term, sorted by id. */
  licenseIds: string[];
  /** The distinct `source` values, sorted. */
  sources: string[];
  /** The distinct non-blank `reference` values, in `compareText` order. */
  references: string[];
  /** The names of the products the term's licenses are on, one per assigned license,
   *  in `compareText` order. An unassigned license contributes nothing. */
  productNames: string[];
  /** Whether any license accepted a Managed plan agreement version other than the
   *  current one. A null `terms_version` (a complimentary or invoice grant, where
   *  nothing was accepted) never counts (decision 9). */
  termsChange: boolean;
  /** Licenses in the term with no stamp at all. */
  unstamped: number;
  /** The oldest stamp in the term, or null when none is stamped. */
  oldestStamp: string | null;
}

/** The raw grouped row, before the JSON arrays are parsed. */
interface ExpiringTermRow {
  billingAccountId: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  endsAt: string;
  licenseIds: string;
  sources: string;
  references: string;
  productNames: string;
  termsMismatched: number;
  unstamped: number;
  oldestStamp: string | null;
}

// ─── The scan ────────────────────────────────────────────────────────────────

/** Binary order. Ids and source tokens are not display text (`ANGULAR_STYLE_GUIDE.md` §20a). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Parse a `json_group_array` result into its non-blank strings, distinct and sorted.
 *  Binary order by default; free text (a reference) passes `compareText`. */
function stringsOf(json: string, compare: (a: string, b: string) => number = byCodeUnit): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const values = parsed.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  return [...new Set(values)].sort(compare);
}

/** Like {@link stringsOf} but keeps duplicates: one name per assigned license. */
function productNamesOf(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .sort(compareText);
}

/**
 * Terms at or inside the horizon, **never-warned first, then oldest**.
 *
 * One grouped read: `licenses` filtered on exactly `licenses_ends_idx`'s predicate,
 * joined to the account and its vendor, grouped by `(billing_account_id, ends_at)`. The
 * vendor columns are in the GROUP BY for strictness only: an account belongs to one
 * vendor (`billing_accounts_vendor_key`). `json_group_array` carries the license ids,
 * sources and references out of the group; the fence inputs are an aggregate count of
 * unstamped licenses and the oldest stamp.
 *
 * `ends_at <= horizon` is a lexical string comparison, which is sound because
 * ISO-8601 is defined to sort lexically and every writer stamps `toISOString()`
 * (`toIsoTimestamp` in `lib/license.ts`). There is deliberately NO lower bound: a
 * live license already past its `ends_at` — a term the lapse did not end (the lapse failed
 * or hit its cap that day) —
 * is exactly what an operator most needs to see, and the fence still limits it to one
 * notice.
 *
 * ── WHY THE LEAD SORT KEY IS "ANY LICENSE UNSTAMPED" ─────────────────────────────
 * Those past-term live licenses accumulate — each term is already stamped, so the TS
 * fence suppresses it, but it stays selectable every night. Ordered by `ends_at` alone
 * they sort to the FRONT (oldest first), so once ≥`EXPIRY_BATCH_CAP` of them exist
 * they would fill the read window and starve a genuinely-due newer term out of the
 * scan entirely. Sorting terms with an unstamped license first defeats that: a due
 * term always holds one, because a renewal NULLs the stamp (`setLicensesTermStatements`)
 * and a new license starts unstamped. So due terms are read before the suppressed
 * backlog, and a warned term (now fully stamped) drops to the back of tomorrow's
 * window. The `ends_at` key still orders within each group.
 */
async function loadExpiring(db: Db, horizonIso: string, limit: number): Promise<ExpiringTerm[]> {
  const unstamped = sql<number>`sum(case when ${licenses.expiryNoticeSentAt} is null then 1 else 0 end)`;
  const currentTerms = LEGAL_AGREEMENT_CURRENT_VERSIONS.managed_plan;
  const termsMismatched = sql<number>`sum(case when ${licenses.termsVersion} is not null and ${licenses.termsVersion} <> ${currentTerms} then 1 else 0 end)`;
  const rows = (await db
    .select({
      billingAccountId: licenses.billingAccountId,
      vendorId: billingAccounts.vendorId,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      endsAt: licenses.endsAt,
      licenseIds: sql<string>`json_group_array(${licenses.id})`,
      sources: sql<string>`json_group_array(distinct ${licenses.source})`,
      references: sql<string>`json_group_array(distinct ${licenses.reference})`,
      // One entry per assigned license, NOT distinct: two products may share a name,
      // and the email compares this count with the license count. NULL for an
      // unassigned license; `productNamesOf` drops it.
      productNames: sql<string>`json_group_array(${products.name})`,
      termsMismatched: termsMismatched.mapWith(Number),
      unstamped: unstamped.mapWith(Number),
      oldestStamp: sql<string | null>`min(${licenses.expiryNoticeSentAt})`,
    })
    .from(licenses)
    .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
    .innerJoin(vendors, eq(vendors.id, billingAccounts.vendorId))
    // At most one product per license, so the join never multiplies a term's rows.
    .leftJoin(products, eq(products.id, licenses.assignedProductId))
    .where(
      and(
        // Exactly `licenses_ends_idx`'s predicate, so the planner can use it.
        isNull(licenses.endedAt),
        isNotNull(licenses.endsAt),
        lte(licenses.endsAt, horizonIso),
      ),
    )
    .groupBy(
      licenses.billingAccountId,
      licenses.endsAt,
      billingAccounts.vendorId,
      vendors.slug,
      vendors.companyName,
    )
    .orderBy(
      // A plain NULL count — no SQLite date parsing, so none of the `datetime()`
      // lexical-ordering traps the fence is written in TS to avoid.
      sql`case when ${unstamped} > 0 then 0 else 1 end`,
      asc(licenses.endsAt),
      asc(licenses.billingAccountId),
    )
    .limit(limit)) as ExpiringTermRow[];

  return rows.map((r) => ({
    billingAccountId: r.billingAccountId,
    vendorId: r.vendorId,
    vendorSlug: r.vendorSlug,
    vendorName: r.vendorName,
    endsAt: r.endsAt,
    licenseIds: stringsOf(r.licenseIds),
    sources: stringsOf(r.sources),
    references: stringsOf(r.references, compareText),
    productNames: productNamesOf(r.productNames),
    termsChange: Number(r.termsMismatched) > 0,
    unstamped: Number(r.unstamped),
    oldestStamp: r.oldestStamp,
  }));
}

/**
 * Every license of the given vendors, for the audit row's plan snapshot
 * (`licensePlanSnapshot`, which reads the vendor's WHOLE license set: a past-term
 * annual license beside a live monthly one is still an `active` plan). One read per
 * {@link PLAN_READ_CHUNK} vendors, so the snapshot costs a run one or a few reads, not
 * one per notice.
 */
async function loadPlanRows(
  db: Db,
  vendorIds: readonly string[],
): Promise<Map<string, LicensePlanRow[]>> {
  const unique = [...new Set(vendorIds)];
  const out = new Map<string, LicensePlanRow[]>();
  for (let i = 0; i < unique.length; i += PLAN_READ_CHUNK) {
    const rows = await db
      .select({
        vendorId: billingAccounts.vendorId,
        endsAt: licenses.endsAt,
        endedAt: licenses.endedAt,
        endReason: licenses.endReason,
      })
      .from(licenses)
      .innerJoin(billingAccounts, eq(billingAccounts.id, licenses.billingAccountId))
      .where(inArray(billingAccounts.vendorId, unique.slice(i, i + PLAN_READ_CHUNK)));
    for (const { vendorId, ...row } of rows) {
      const list = out.get(vendorId) ?? [];
      list.push(row);
      out.set(vendorId, list);
    }
  }
  return out;
}

/** Whole days from `now` to `ends_at`; negative once the term is past. Rounded
 *  UP so "18 hours left" reads as "tomorrow" rather than "today". */
export function daysUntil(nowMs: number, periodEndMs: number): number {
  return Math.ceil((periodEndMs - nowMs) / DAY_MS);
}

/**
 * Whether a stamp still owes a notice. `null` stamp → yes. A stamp at or after
 * `ends_at − window` belongs to the CURRENT term → no. Anything earlier belongs
 * to a previous term → yes.
 *
 * A present-but-unparseable stamp suppresses rather than notifies: it can only
 * come from hand-written SQL, and re-nagging nightly forever is a worse failure
 * than one missed warning.
 */
export function noticeIsDue(
  expiryNoticeSentAt: string | null,
  periodEndMs: number,
  warningDays: number,
): boolean {
  if (expiryNoticeSentAt === null) return true;
  const sentMs = Date.parse(expiryNoticeSentAt);
  if (!Number.isFinite(sentMs)) return false;
  return sentMs < periodEndMs - warningDays * DAY_MS;
}

/** Whether a TERM owes a notice: any license unstamped, or the oldest stamp stale.
 *  Every license in a term shares `ends_at`, so the oldest stamp decides the rest. */
function termIsDue(term: ExpiringTerm, endsAtMs: number, warningDays: number): boolean {
  if (term.unstamped > 0) return true;
  return noticeIsDue(term.oldestStamp, endsAtMs, warningDays);
}

// ─── The write ───────────────────────────────────────────────────────────────

export interface ExpiryNoticeParams {
  billingAccountId: string;
  vendorId: string;
  /** The licenses the notice covered. All of them are stamped. */
  licenseIds: readonly string[];
  /** The term, exactly as scanned. Guards the stamp. */
  endsAt: string;
  daysRemaining: number;
  /** ISO timestamp for the stamp — the sweep's `now`. */
  now: string;
  /** The vendor's WHOLE license set, for the audit row's plan snapshot. */
  vendorLicenses: readonly LicensePlanRow[];
  vendorNotice: EmailOutcome;
  adminNotice: EmailOutcome;
  /** How many addresses the vendor half went to: seats plus the billing email, deduped. */
  vendorRecipients: number;
  /** Whether the notice announced a new Managed plan agreement version (decision 9). */
  termsChange: boolean;
}

/**
 * The statements one delivered warning produces: the fence stamp on every license the
 * notice covered and ONE `audit_log` row for the notice, in ONE `db.batch` (§26.1 — D1
 * has no interactive transactions).
 *
 * Exported as a pure builder, executing nothing, so the §7.3 invariant test can
 * read the generated SQL directly. What that test asserts, and what this function
 * must never stop satisfying:
 *
 *   - every statement against `licenses` SETs only `expiry_notice_sent_at` and
 *     `updated_at`;
 *   - NO statement names `ended_at`, `assigned_product_id`, `vendors` or `verified`
 *     anywhere — not even as a guard.
 */
export function expiryNoticeStatements(
  db: Db,
  p: ExpiryNoticeParams,
): { stmts: BatchStmt[]; auditEntry: AuditLogEntry } {
  const licenseIds = [...new Set(p.licenseIds)].sort(byCodeUnit);
  const auditEntry: AuditLogEntry = {
    actorId: null,
    // The `audit_log_actor_type_check` value for a cron. `actor_id` stays null: it
    // is an FK to `profiles` and no profile did this.
    actorType: 'system',
    action: EXPIRY_WARNED_ACTION,
    entityType: LICENSE_ENTITY_TYPE,
    entityId: p.billingAccountId,
    vendorId: p.vendorId,
    // The plan as it stands: nothing in this batch changes it. A warning sent after
    // every live license's `ends_at` records `expired` (the 2026-10-05 clock rule).
    vendorPlan: licensePlanSnapshot(p.vendorLicenses, p.now),
    metadata: {
      source: EXPIRY_AUDIT_SOURCE,
      vendorId: p.vendorId,
      billing_account_id: p.billingAccountId,
      license_ids: licenseIds,
      license_count: licenseIds.length,
      ends_at: p.endsAt,
      days_remaining: p.daysRemaining,
      warning_days: EXPIRY_WARNING_DAYS,
      vendor_notice: p.vendorNotice,
      vendor_recipients: p.vendorRecipients,
      admin_notice: p.adminNotice,
      terms_change: p.termsChange,
      // Stated in the trail rather than left to be inferred: this row records a
      // WARNING. No license ended and `vendors.verified` did not move (§7.3).
      warning_only: true,
    },
  };

  const stmts: BatchStmt[] = [
    ...expiryNoticeStampStatements(db, { licenseIds, endsAt: p.endsAt, now: p.now }),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry };
}

// ─── Recipients ──────────────────────────────────────────────────────────────

/**
 * Email addresses per vendor for the seats to warn. The sweep adds the billing
 * email per term (`mergeRecipientAddresses`). Unbanned `vendor_admin`
 * profiles only, matching `lib/attestation-notify.ts`. The read is the shared
 * `loadVendorSeatRecipients` (AECI-1205), which the protest emails use too.
 *
 * Degrades to an empty map without `SUPABASE_SERVICE_ROLE_KEY`: `profiles` holds
 * no email column, addresses live in Supabase `auth.users`, and local dev / PR
 * previews legitimately lack the key.
 */
async function loadVendorSeatEmails(
  db: Db,
  env: Env,
  vendorIds: readonly string[],
  fetchSeatEmails: FetchSeatEmails,
): Promise<Map<string, string[]>> {
  const recipients = await loadVendorSeatRecipients(db, env, vendorIds, fetchSeatEmails);
  return new Map([...recipients].map(([vendorId, seats]) => [vendorId, seats.map((s) => s.email)]));
}

/**
 * Collapse the per-address outcomes for one channel into the one recorded.
 *
 * `sent` if ANY address was delivered — the notice reached the vendor, so the
 * fence is earned even if a second seat's address bounced. Otherwise `failed`
 * beats `duplicate` beats `suppressed` beats `skipped`: a failure is the more
 * actionable signal, and `suppressed` (AECI-1198, an outside address on a
 * non-production tier) says there WAS an address. `duplicate` (AECI-1202) means an
 * earlier send holds the ledger key, so this run delivered nothing but nothing
 * failed either. `unknown` (AECI-1197 review) means a send timed out or threw, so
 * it may or may not have gone. It is neither delivered nor failed: it ranks below
 * `failed` and does not stamp the fence. These sends take no dedupe key, so tomorrow's
 * run may warn again. A possible second warning beats a lost one here, because the
 * warning protects the vendor's paid term. `paused` (AECI-1224) means an operator
 * paused the template on this tier: only the admin notice is pausable, and it ranks
 * above `suppressed` because the pause is the more recent decision. None of `unknown`,
 * `duplicate`, `paused`, `suppressed` or `skipped` stamps the fence.
 */
function collapse(outcomes: readonly EmailOutcome[]): EmailOutcome {
  if (outcomes.includes('sent')) return 'sent';
  if (outcomes.includes('failed')) return 'failed';
  if (outcomes.includes('unknown')) return 'unknown';
  if (outcomes.includes('duplicate')) return 'duplicate';
  if (outcomes.includes('paused')) return 'paused';
  if (outcomes.includes('suppressed')) return 'suppressed';
  return 'skipped';
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/**
 * Run one expiry pass: scan, fence, warn, stamp.
 *
 * Returns counts for the caller to log; metrics go through the injected sink so
 * this module stays free of `ctx`/`env` plumbing. Never throws for an email or a
 * batch failure — only a genuinely unexpected D1 read failure propagates, which
 * is safe because the fence makes a re-run idempotent for everything already
 * delivered.
 */
export async function runEntitlementExpirySweep(
  c: ExpiryContext,
  db: Db,
  deps: ExpiryDeps = {},
): Promise<ExpiryResult> {
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const warningDays = deps.warningDays ?? EXPIRY_WARNING_DAYS;
  const cap = deps.batchCap ?? EXPIRY_BATCH_CAP;
  const fetchSeatEmails = deps.fetchSeatEmails ?? fetchAuthUserEmails;
  const sendVendorEmail = deps.sendVendorEmail ?? noopSendExpiryEmail;
  const sendAdminEmail = deps.sendAdminEmail ?? noopSendExpiryAdminEmail;

  const result: ExpiryResult = {
    due: 0,
    suppressed: 0,
    capped: 0,
    malformed: 0,
    warned: 0,
    vendor: { sent: 0, failed: 0, unknown: 0, skipped: 0, suppressed: 0, duplicate: 0, paused: 0 },
    admin: { sent: 0, failed: 0, unknown: 0, skipped: 0, suppressed: 0, duplicate: 0, paused: 0 },
    batchFailures: 0,
  };

  const horizonIso = new Date(nowMs + warningDays * DAY_MS).toISOString();
  // One over the cap, so "there was more" is detectable without a second query.
  const terms = await loadExpiring(db, horizonIso, cap + 1);

  const pending: Array<{ term: ExpiringTerm; daysRemaining: number }> = [];
  for (const term of terms) {
    const endsAtMs = Date.parse(term.endsAt);
    if (!Number.isFinite(endsAtMs)) {
      result.malformed++;
      continue;
    }
    result.due++;
    if (!termIsDue(term, endsAtMs, warningDays)) {
      result.suppressed++;
      continue;
    }
    pending.push({ term, daysRemaining: daysUntil(nowMs, endsAtMs) });
  }

  // The gauge is emitted on EVERY run, zero included — it is this job's only
  // liveness signal while most licenses are monthly or none are near their end.
  if (deps.metrics) emitExpiryDueMetric(deps.metrics, result.due);
  if (pending.length === 0) return result;

  const batch = pending.slice(0, cap);
  result.capped = pending.length - batch.length;
  if (result.capped > 0) {
    // Never truncate silently — an operator must be able to tell "nothing due"
    // from "we stopped early".
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `aeci.entitlement.expiry.capped dropped=${result.capped} cap=${cap}`,
      source: EXPIRY_AUDIT_SOURCE,
      dropped: result.capped,
    });
  }

  const vendorIds = batch.map((b) => b.term.vendorId);
  const adminRecipients = parseRecipients(c.env.SUPPORT_EMAIL);
  const seatEmails = await loadVendorSeatEmails(db, c.env, vendorIds, fetchSeatEmails);
  // Decision 16: renewal emails go to every seat AND the billing email. The billing
  // email needs no service-role key, so it still lands where the seat read degrades.
  const billingEmails = await loadBillingEmails(
    db,
    batch.map((b) => b.term.billingAccountId),
  );
  const planRows = await loadPlanRows(db, vendorIds);

  const outcomes: ExpiryNoticeOutcome[] = [];
  // Collected per term and sent ONCE after the loop (AECI-1112). One `logToPosthog`
  // per warned term put one `fetch` per vendor into `waitUntil`, alongside the
  // email sends, and a Worker invocation holds only about six open connections
  // (AECI-666). Nothing in the loop throws, so the flush below always runs.
  const forwarded: AuditLogEntry[] = [];
  const stampFailures: PosthogLogEvent[] = [];

  for (const { term, daysRemaining } of batch) {
    const periodEndDay = term.endsAt.slice(0, 10);
    const addresses = mergeRecipientAddresses(
      seatEmails.get(term.vendorId) ?? [],
      billingEmails.get(term.billingAccountId),
    );

    const vendorSends: EmailOutcome[] = [];
    for (const to of addresses) {
      vendorSends.push(
        await sendVendorEmail(c, {
          to,
          vendorName: term.vendorName,
          periodEndDay,
          daysRemaining,
          licenseCount: term.licenseIds.length,
          productNames: term.productNames,
          sources: term.sources,
          termsChange: term.termsChange,
        }),
      );
    }
    const vendorNotice = collapse(vendorSends);
    result.vendor[vendorNotice]++;
    outcomes.push({ channel: 'vendor', outcome: vendorNotice });

    const adminSends: EmailOutcome[] = [];
    for (const to of adminRecipients) {
      adminSends.push(
        await sendAdminEmail(c, {
          to,
          vendorName: term.vendorName,
          vendorSlug: term.vendorSlug,
          periodEndDay,
          daysRemaining,
          licenseCount: term.licenseIds.length,
          source: term.sources.length > 0 ? term.sources.join(', ') : null,
          reference: term.references.length > 0 ? term.references.join(', ') : null,
          vendorNotice,
        }),
      );
    }
    const adminNotice = collapse(adminSends);
    result.admin[adminNotice]++;
    outcomes.push({ channel: 'admin', outcome: adminNotice });

    // Stamp when EITHER channel landed (see the header): stamping on attempt would
    // consume the notice during a Resend outage, and requiring both would re-nag
    // nightly on any tier without `SUPABASE_SERVICE_ROLE_KEY`.
    if (vendorNotice !== 'sent' && adminNotice !== 'sent') continue;

    const { stmts, auditEntry } = expiryNoticeStatements(db, {
      billingAccountId: term.billingAccountId,
      vendorId: term.vendorId,
      licenseIds: term.licenseIds,
      endsAt: term.endsAt,
      daysRemaining,
      now: nowIso,
      vendorLicenses: planRows.get(term.vendorId) ?? [],
      vendorNotice,
      adminNotice,
      vendorRecipients: addresses.length,
      termsChange: term.termsChange,
    });

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      // The emails for THIS term are already out. Log and move on rather than
      // aborting: the cost is one duplicate warning in 24h, which is strictly
      // better than losing every remaining term's notice to one D1 hiccup.
      result.batchFailures++;
      stampFailures.push({
        level: 'error',
        message: 'aeci.entitlement.expiry.stamp_failed',
        source: EXPIRY_AUDIT_SOURCE,
        vendor_id: term.vendorId,
        billing_account_id: term.billingAccountId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    result.warned++;
    forwarded.push(auditEntry);
  }

  // Post-commit §26.5 forward: every stamped term's audit entry in ONE request.
  forwardAuditBatch(c, forwarded, [], EXPIRY_AUDIT_SOURCE);
  if (stampFailures.length > 0) {
    logBatchToPosthog(c.executionCtx, c.env, c.req.raw, stampFailures);
  }

  if (deps.metrics) emitExpiryNoticeMetrics(deps.metrics, outcomes);
  return result;
}
