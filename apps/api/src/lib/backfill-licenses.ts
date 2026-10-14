/**
 * backfill-licenses — the testable core of the E1.5 license back-fill ops CLI
 * (`apps/api/scripts/backfill-licenses.ts`, AECI-1354; `docs/VENDOR_SIGNUP_PROCESS.md`
 * §5 E1, `docs/STAGE_2_PAID_TIERS_SPEC.md` §2.4).
 *
 * WHY IT EXISTS. Migration 0073 created `billing_accounts` and `licenses` empty. New
 * claim approvals and entitlement writes keep them in step (E1.2, E1.4), but every
 * vendor seated or granted before that has no account and no licenses. The E1.6
 * switch-over reads licenses, so each deployed tier needs them first. The local seeds
 * already carry them (`catalog.sql`, `phase2-fixtures.sql`); deployed tiers get them
 * from here. One-off data back-fills are scripts, not migrations (`docs/migrations.md`).
 *
 * WHO IT REACHES. Every vendor with a `vendor_admin` seat, a `vendor_entitlements` row,
 * or `verified = 1`. The last group is read only so the report can show its drift.
 *
 * WHAT IT WRITES, per vendor, in ONE `wrangler d1 execute` (one atomic batch):
 *   1. the billing account, when the vendor has none (name = company name);
 *   2. the licenses that mirror its entitlement row, mapped by
 *      `licenseTermsForEntitlement` (the 2026-10-14 rule, shared with E1.4's
 *      dual-write so the two cannot map one row two ways):
 *        - `active`  → N LIVE licenses, N = owned products (`product_vendors`, the set
 *                      `ownedProductIds` scopes by), min 1. Each owned product gets
 *                      one, in product-id order; with no products the one license is
 *                      unassigned. A product another vendor's live license already
 *                      holds stays unassigned, as in the dual-write, because the
 *                      partial unique index would otherwise fail the batch.
 *        - `expired` → N ENDED licenses, `end_reason = 'lapsed'`.
 *        - `revoked` → N ENDED licenses, `end_reason = 'revoked'`.
 *        - `pending` → nothing. A pending row never granted anything, so there is no
 *                      license history to keep. Activation's dual-write grants later.
 *      Ended licenses keep their products as history (decision 14), stamped
 *      `ended_at` = the row's `ended_at` (else `period_end`, else `updated_at`). They
 *      keep the plan snapshot continuous: after E1.6 `licensePlanSnapshot` reads a
 *      revoked vendor as `revoked`, not `none`, exactly as `vendorPlanSnapshot` reads
 *      the entitlement today. They are invisible to both drift checks, which look at
 *      LIVE licenses only. This is also how the seeds map the revoked `bluebeam` row.
 *   3. one `billing_account.backfilled` audit row (`entity_type = 'billing_account'`,
 *      `entity_id` = the account, `vendor_id` filled), whose `after_state` lists every
 *      license written. `vendor_tier` / `vendor_entitlement_status` are the
 *      entitlement's `vendorPlanSnapshot`, the readers' truth until E1.6.
 *
 * THEN, for EVERY vendor (already licensed or not), the stamp reconcile
 * ({@link buildStampReconcileStatements}): per vendor, one UPDATE that copies the
 * entitlement's `expiry_notice_sent_at` onto live licenses of the same term that lack
 * it, and one `license.expiry_stamp_reconciled` audit row in the same execute. It
 * covers the window between the back-fill and the AECI-1356 sweep deploy. Re-running
 * the back-fill after that deploy is what closes the window.
 *
 * WHAT IT NEVER DOES. It never writes `vendors.verified`, and so emits no mirror
 * reconcile. For a vendor whose mirror already agrees with its entitlement, the
 * mapping gives a live license exactly when `verified = 1`, so `license_mirror_drift`
 * reads 0 without touching the bit. A vendor whose mirror DISAGREES with its
 * entitlement (`entitlement_mirror_drift`, either direction) is REFUSED and reported,
 * not repaired: writing licenses for it would either carry the drift into the new
 * table or need a `verified` write, which only the sole-writer modules may make
 * (§2.1). That is the `backfill-entitlements` posture.
 *
 * IDEMPOTENT, three ways:
 *   - the read skips every vendor that already carries a license (any status);
 *   - ids are UUIDv5 over a fixed namespace, so a re-plan mints the same ids;
 *   - every INSERT carries a `WHERE NOT EXISTS` re-guard, so a write that raced the
 *     read, or a re-run of a half-landed tier, writes nothing twice. The audit row is
 *     guarded on its own id AND on a row of this plan existing, so it never records a
 *     write that did not happen.
 *
 * Raw SQL, not Drizzle, because a Node process reaches a deployed D1 only through
 * `wrangler d1 execute` (`apps/api/scripts/README.md`). Like `retract-product.ts`, the
 * CLI writes its audit rows itself. They are not forwarded to PostHog Logs: there is
 * no Worker `ctx` to forward from.
 */

import { vendorPlanSnapshot, type VendorPlanSnapshot } from '@aeci/shared/entitlements';

import { licenseTermsForEntitlement, toIsoTimestamp, type LicenseTerms } from './license';
import { escapeSqlLiteral } from './retract-product';

/** The audit action, one row per vendor written. Registered in
 *  `@aeci/shared/audit-vendor-actions`. */
export const BILLING_ACCOUNT_BACKFILLED_ACTION = 'billing_account.backfilled';

export const BACKFILL_LICENSES_ISSUE = 'AECI-1354';
export const BACKFILL_LICENSES_TOOL_PATH = 'apps/api/scripts/backfill-licenses.ts';
/** `metadata.source` on the stamp-reconcile audit rows (ruling 2026-10-14). */
export const BACKFILL_LICENSES_SOURCE = 'ops:backfill-licenses';

// ─── UUIDv5 ──────────────────────────────────────────────────────────────────

/** RFC 9562 URL namespace. */
export const URL_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/**
 * The namespace every back-fill id is minted under:
 * `uuidv5('https://aecintegrations.com/ops/backfill-licenses', URL_NAMESPACE)`.
 * Pinned as a literal (the spec re-derives it) so a refactor cannot re-mint every id,
 * which would make a re-run on a half-landed tier write a second set.
 */
export const BACKFILL_LICENSES_NAMESPACE = '3855f71d-31af-5d3c-8974-694590175906';

/**
 * RFC 9562 §5.5 UUIDv5 (SHA-1, name-based), on Web Crypto so it runs in Node and in a
 * Worker alike. The construction `seed/trades.sql` documents and `d1.spec.ts` pins.
 */
export async function uuidv5(name: string, namespace: string): Promise<string> {
  const hex = namespace.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new RangeError(`not a UUID: ${namespace}`);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(16 + nameBytes.length);
  for (let i = 0; i < 16; i++) input[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  input.set(nameBytes, 16);
  const b = new Uint8Array(await crypto.subtle.digest('SHA-1', input)).slice(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // version 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const out = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-${out.slice(12, 16)}-${out.slice(16, 20)}-${out.slice(20)}`;
}

/** The deterministic ids, one function each so the spec can pin the names. */
export const backfillIds = {
  account: (vendorId: string) => uuidv5(`billing_account:${vendorId}`, BACKFILL_LICENSES_NAMESPACE),
  license: (vendorId: string, entitlementId: string, index: number) =>
    uuidv5(`license:${vendorId}:${entitlementId}:${index}`, BACKFILL_LICENSES_NAMESPACE),
  audit: (vendorId: string) =>
    uuidv5(`audit:${BILLING_ACCOUNT_BACKFILLED_ACTION}:${vendorId}`, BACKFILL_LICENSES_NAMESPACE),
};

// ─── Reads ───────────────────────────────────────────────────────────────────

/** Vendors the back-fill looks at: a seat, an entitlement row, or `verified = 1`. */
const IN_SCOPE = [
  'v."verified" = 1',
  'OR EXISTS (SELECT 1 FROM "vendor_entitlements" e2 WHERE e2."vendor_id" = v."id")',
  'OR EXISTS (SELECT 1 FROM "profiles" p WHERE p."vendor_id" = v."id" AND p."role" = \'vendor_admin\')',
].join(' ');

/** Probe: does the target tier have migration 0073's tables? */
export const LICENSE_TABLES_SQL = `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" IN ('billing_accounts', 'licenses') ORDER BY "name";`;

/** One in-scope vendor, with its entitlement row (LEFT JOIN, unique per vendor). */
export interface BackfillVendorRow {
  id: string;
  slug: string;
  company_name: string;
  verified: number;
  seat_count: number;
  account_id: string | null;
  license_count: number;
  ent_id: string | null;
  ent_tier: string | null;
  ent_status: string | null;
  ent_period_start: string | null;
  ent_period_end: string | null;
  ent_invoice_ref: string | null;
  ent_amount: string | null;
  ent_granted_by: string | null;
  ent_granted_at: string | null;
  ent_ended_at: string | null;
  ent_updated_at: string | null;
  /** The old sweep's fence. Carried onto a live term's licenses (AECI-1356). */
  ent_expiry_notice_sent_at: string | null;
}

export function buildVendorsSql(): string {
  return [
    'SELECT v."id" AS "id", v."slug" AS "slug", v."company_name" AS "company_name", v."verified" AS "verified",',
    '  (SELECT COUNT(*) FROM "profiles" p WHERE p."vendor_id" = v."id" AND p."role" = \'vendor_admin\') AS "seat_count",',
    '  (SELECT b."id" FROM "billing_accounts" b WHERE b."vendor_id" = v."id" ORDER BY b."created_at", b."id" LIMIT 1) AS "account_id",',
    '  (SELECT COUNT(*) FROM "licenses" l JOIN "billing_accounts" b ON b."id" = l."billing_account_id" WHERE b."vendor_id" = v."id") AS "license_count",',
    '  e."id" AS "ent_id", e."tier" AS "ent_tier", e."status" AS "ent_status",',
    '  e."period_start" AS "ent_period_start", e."period_end" AS "ent_period_end",',
    '  e."invoice_ref" AS "ent_invoice_ref", e."amount" AS "ent_amount", e."granted_by" AS "ent_granted_by",',
    '  e."granted_at" AS "ent_granted_at", e."ended_at" AS "ent_ended_at", e."updated_at" AS "ent_updated_at",',
    '  e."expiry_notice_sent_at" AS "ent_expiry_notice_sent_at"',
    'FROM "vendors" v',
    'LEFT JOIN "vendor_entitlements" e ON e."vendor_id" = v."id"',
    `WHERE ${IN_SCOPE}`,
    // NOCASE so the report reads A to Z (AECI-825); `id` breaks ties.
    'ORDER BY v."company_name" COLLATE NOCASE, v."id";',
  ].join('\n');
}

/** One owned product of an in-scope vendor, and whether a live license holds it. */
export interface OwnedProductRow {
  vendor_id: string;
  product_id: string;
  licensed: number;
}

export function buildOwnedProductsSql(): string {
  return [
    'SELECT pv."vendor_id" AS "vendor_id", pv."product_id" AS "product_id",',
    '  EXISTS (SELECT 1 FROM "licenses" l WHERE l."assigned_product_id" = pv."product_id" AND l."ended_at" IS NULL) AS "licensed"',
    'FROM "product_vendors" pv',
    `WHERE pv."vendor_id" IN (SELECT v."id" FROM "vendors" v WHERE ${IN_SCOPE})`,
    'ORDER BY pv."vendor_id", pv."product_id";',
  ].join('\n');
}

/** A vendor whose `verified` disagrees with EXISTS(live license): the post-apply
 *  check, and the same predicate as the `license_mirror_drift` data-quality check. */
export interface LicenseDriftRow {
  id: string;
  slug: string;
  company_name: string;
  verified: number;
}

export function buildLicenseDriftSql(): string {
  return [
    'SELECT v."id" AS "id", v."slug" AS "slug", v."company_name" AS "company_name", v."verified" AS "verified"',
    'FROM "vendors" v',
    'WHERE v."verified" <> EXISTS (',
    '  SELECT 1 FROM "licenses" l JOIN "billing_accounts" b ON b."id" = l."billing_account_id"',
    '  WHERE b."vendor_id" = v."id" AND l."ended_at" IS NULL)',
    'ORDER BY v."company_name" COLLATE NOCASE, v."id";',
  ].join('\n');
}

// ─── Expiry-notice stamp reconcile (AECI-1356 cutover) ──────────────────────

/**
 * SQLite's canonical form of a timestamp, equal to `Date.prototype.toISOString()`.
 * `strftime` reads `YYYY-MM-DD`, a space or `T` separator, and a `Z` or `±HH:MM`
 * suffix, and returns NULL for anything else, so an unreadable value never matches.
 */
const isoOf = (expr: string) => `strftime('%Y-%m-%dT%H:%M:%fZ', ${expr})`;

/**
 * The live licenses whose fence lags their vendor's entitlement on the SAME term. Reads
 * the outer `"licenses"` row; the entitlement is reached through the license's billing
 * account. A license qualifies when it is live (`ended_at` NULL), has an end date, is
 * unstamped, and its vendor's entitlement row is `active`, stamped, and ends on the
 * license's `ends_at` (both normalised, so `2027-01-01` meets `2027-01-01T00:00:00.000Z`).
 */
const STAMP_LAG_FROM = [
  '"vendor_entitlements" e JOIN "billing_accounts" b ON b."vendor_id" = e."vendor_id"',
  'WHERE b."id" = "licenses"."billing_account_id"',
  '  AND e."status" = \'active\'',
  `  AND ${isoOf('e."expiry_notice_sent_at"')} IS NOT NULL`,
  `  AND ${isoOf('e."period_end"')} = ${isoOf('"licenses"."ends_at"')}`,
].join('\n');

const STAMP_LAG_WHERE = [
  '"licenses"."ended_at" IS NULL',
  '  AND "licenses"."ends_at" IS NOT NULL',
  '  AND "licenses"."expiry_notice_sent_at" IS NULL',
  `  AND EXISTS (SELECT 1 FROM ${STAMP_LAG_FROM})`,
].join('\n');

/** One live license the stamp reconcile would stamp, with its vendor and term. */
export interface StampLagRow {
  vendor_id: string;
  slug: string;
  company_name: string;
  license_id: string;
  ends_at: string;
  /** The entitlement's stamp, normalised: the value the reconcile copies. */
  stamp: string;
  /** The entitlement's tier and `period_end`, for the audit row's plan snapshot. */
  ent_tier: string;
  ent_period_end: string;
}

/**
 * The read behind the reconcile: every license the reconcile would stamp, with the
 * stamp it would copy. Run before (the dry-run count and the per-vendor plan) and
 * after (the proof: 0 rows) the write.
 */
export function buildStampLagSql(): string {
  return [
    'SELECT v."id" AS "vendor_id", v."slug" AS "slug", v."company_name" AS "company_name",',
    '  "licenses"."id" AS "license_id", "licenses"."ends_at" AS "ends_at",',
    `  (SELECT ${isoOf('e."expiry_notice_sent_at"')} FROM ${STAMP_LAG_FROM}) AS "stamp",`,
    '  (SELECT e."tier" FROM "vendor_entitlements" e WHERE e."vendor_id" = v."id") AS "ent_tier",',
    '  (SELECT e."period_end" FROM "vendor_entitlements" e WHERE e."vendor_id" = v."id") AS "ent_period_end"',
    'FROM "licenses"',
    'JOIN "billing_accounts" ba ON ba."id" = "licenses"."billing_account_id"',
    'JOIN "vendors" v ON v."id" = ba."vendor_id"',
    `WHERE ${STAMP_LAG_WHERE}`,
    'ORDER BY v."company_name" COLLATE NOCASE, v."id", "licenses"."id";',
  ].join('\n');
}

/** The audit action, one row per vendor whose licenses the reconcile stamps.
 *  Registered in `@aeci/shared/audit-vendor-actions`. */
export const LICENSE_EXPIRY_STAMP_RECONCILED_ACTION = 'license.expiry_stamp_reconciled';

/** One vendor's share of the reconcile. */
export interface VendorStampReconcile {
  vendorId: string;
  slug: string;
  name: string;
  /** The licenses the read found lagging, in id order. The write is scoped to them. */
  licenseIds: string[];
  endsAt: string;
  stamp: string;
  auditId: string;
  plan: VendorPlanSnapshot;
}

/**
 * Group the lag read by vendor. The audit id is UUIDv5 over the vendor, the stamp and
 * the license ids, so re-executing the same statements cannot write a second row, and
 * a later stamp on a later term (a new stamp) gets its own id.
 */
export async function planStampReconcile(
  rows: readonly StampLagRow[],
  opts: { now: string },
): Promise<VendorStampReconcile[]> {
  const now = toIsoTimestamp(opts.now);
  const by = new Map<string, StampLagRow[]>();
  for (const r of rows) {
    const list = by.get(r.vendor_id) ?? [];
    list.push(r);
    by.set(r.vendor_id, list);
  }
  const out: VendorStampReconcile[] = [];
  for (const [vendorId, list] of by) {
    const first = list[0]!;
    const licenseIds = list.map((r) => r.license_id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push({
      vendorId,
      slug: first.slug,
      name: first.company_name,
      licenseIds,
      endsAt: first.ends_at,
      stamp: first.stamp,
      auditId: await uuidv5(
        `audit:${LICENSE_EXPIRY_STAMP_RECONCILED_ACTION}:${vendorId}:${first.stamp}:${licenseIds.join(',')}`,
        BACKFILL_LICENSES_NAMESPACE,
      ),
      plan: vendorPlanSnapshot(
        { tier: first.ent_tier, status: 'active', periodEnd: first.ent_period_end },
        now,
      ),
    });
  }
  return out;
}

/**
 * The reconcile for ONE vendor: its audit row, then the UPDATE, as one execute.
 * Copies the entitlement's `expiry_notice_sent_at` onto the vendor's live licenses of
 * the same term that lack it. Runs for EVERY vendor, including those the plan skips as
 * already licensed.
 *
 * WHY. The plan copies the stamp only onto licenses it inserts. Between the back-fill
 * and the deploy of the license-based sweep (AECI-1356) the old sweep stamps only
 * `vendor_entitlements`, and E1.4's dual-write mints or re-terms licenses without the
 * stamp. Without this, the new sweep's first run would send a second "your plan ends"
 * notice for a term the old sweep already warned. Cutover order: back-fill, deploy
 * E1.6/E1.7, re-run the back-fill before the next 11:00 UTC expiry run.
 *
 * THE AUDIT ROW (ruling 2026-10-14): one `license.expiry_stamp_reconciled` row per
 * vendor, actor `system`, filed under the billing account. It is an INSERT … SELECT
 * placed BEFORE the UPDATE and guarded on the UPDATE's own WHERE, so it lands exactly
 * when the UPDATE will stamp something; after the UPDATE that WHERE matches nothing, so
 * the guard could not run second. `metadata.license_ids` is computed by the same
 * predicate inside the INSERT, so it names exactly the rows the UPDATE then stamps,
 * even if one was stamped between the read and the write. The two statements share one
 * execute and commit together. The deterministic id adds a second guard.
 *
 * The UPDATE names only `expiry_notice_sent_at` and `updated_at`, never `vendors`.
 * Idempotent: the WHERE requires an unstamped license, so a re-run stamps 0 rows and
 * writes no audit row.
 */
export function buildStampReconcileStatements(
  r: VendorStampReconcile,
  opts: { now: string; operator?: string | null },
): string[] {
  const now = lit(toIsoTimestamp(opts.now));
  const scope = `"licenses"."id" IN (${r.licenseIds.map((id) => lit(id)).join(', ')})\n  AND ${STAMP_LAG_WHERE}`;
  const metadata = [
    'json_object(',
    `  'source', ${lit(BACKFILL_LICENSES_SOURCE)},`,
    `  'issue', ${lit(BACKFILL_LICENSES_ISSUE)},`,
    `  'tool', ${lit(BACKFILL_LICENSES_TOOL_PATH)},`,
    `  'operator', ${lit(opts.operator ?? null)},`,
    `  'vendorId', ${lit(r.vendorId)},`,
    `  'ends_at', ${lit(r.endsAt)},`,
    `  'expiry_notice_sent_at', ${lit(r.stamp)},`,
    `  'license_ids', json((SELECT json_group_array("id") FROM (SELECT "licenses"."id" AS "id" FROM "licenses" WHERE ${scope} ORDER BY "licenses"."id"))))`,
  ].join('\n');
  return [
    [
      'INSERT INTO "audit_log" ("id","actor_id","actor_type","action","entity_type","entity_id","before_state","after_state","metadata","vendor_id","product_id","vendor_tier","vendor_entitlement_status","created_at")',
      `SELECT ${lit(r.auditId)}, NULL, 'system', ${lit(LICENSE_EXPIRY_STAMP_RECONCILED_ACTION)}, 'billing_account', ${accountOf(r.vendorId)}, NULL, NULL, ${metadata}, ${lit(r.vendorId)}, NULL, ${lit(r.plan.tier)}, ${lit(r.plan.status)}, ${now}`,
      `WHERE NOT EXISTS (SELECT 1 FROM "audit_log" WHERE "id" = ${lit(r.auditId)})`,
      `  AND EXISTS (SELECT 1 FROM "licenses" WHERE ${scope});`,
    ].join('\n'),
    [
      'UPDATE "licenses"',
      `SET "expiry_notice_sent_at" = (SELECT ${isoOf('e."expiry_notice_sent_at"')} FROM ${STAMP_LAG_FROM}),`,
      `    "updated_at" = ${now}`,
      `WHERE ${scope};`,
    ].join('\n'),
  ];
}

// ─── Plan ────────────────────────────────────────────────────────────────────

export type BackfillOutcome = 'write' | 'already-licensed' | 'nothing-to-write' | 'refused';

export interface PlannedLicense {
  id: string;
  source: LicenseTerms['source'];
  startsAt: string;
  endsAt: string | null;
  endedAt: string | null;
  endReason: 'lapsed' | 'revoked' | null;
  reference: string | null;
  assignedProductId: string | null;
  assignedAt: string | null;
  grantedBy: string | null;
  /** The entitlement's expiry-notice stamp, on a live license with an end date only.
   *  Without it the first license-based sweep would warn again a term the
   *  entitlement-based sweep already warned (AECI-1356). */
  expiryNoticeSentAt: string | null;
}

export interface VendorBackfillPlan {
  vendorId: string;
  slug: string;
  name: string;
  verified: boolean;
  seatCount: number;
  outcome: BackfillOutcome;
  /** Set when `outcome` is `refused`: which way the mirror disagrees. */
  refusal: string | null;
  /** The entitlement status, or `null` when the vendor has no row. */
  entitlementStatus: string | null;
  /** True when this plan inserts the account; its id is then `accountId`. */
  createAccount: boolean;
  /** The existing account's id, or the new one's. */
  accountId: string;
  licenses: PlannedLicense[];
  auditId: string;
  /** The entitlement row's plan, for the audit row's snapshot columns. */
  plan: VendorPlanSnapshot;
  ownedProductCount: number;
  /** Active row with `period_end` NULL: the live licenses carry `ends_at` NULL and
   *  need a date decision (ruling 2026-10-14). */
  perpetual: boolean;
  /** Owned products left unassigned because another vendor's live license holds them. */
  heldElsewhere: string[];
}

export interface BackfillPlan {
  vendors: VendorBackfillPlan[];
}

const END_REASON: Record<string, 'lapsed' | 'revoked'> = { expired: 'lapsed', revoked: 'revoked' };

/** Which way the §2.1 mirror disagrees with the entitlement row, or `null`. Same
 *  predicate as `entitlement_mirror_drift`. */
export function entitlementDrift(row: BackfillVendorRow): string | null {
  const active = row.ent_status === 'active';
  const verified = Number(row.verified) === 1;
  if (verified && !active) {
    return row.ent_id === null
      ? 'verified = 1 with no entitlement row'
      : `verified = 1 with entitlement '${row.ent_status ?? ''}'`;
  }
  if (!verified && active) return "verified = 0 with an 'active' entitlement";
  return null;
}

/**
 * Plan the back-fill from the two reads. Pure apart from id minting. `now` stamps
 * `created_at` / `updated_at` and the plan snapshot. Products a plan assigns are
 * remembered across vendors, so two co-owners in one run never both take a product.
 */
export async function planLicenseBackfill(
  vendors: readonly BackfillVendorRow[],
  owned: readonly OwnedProductRow[],
  opts: { now: string },
): Promise<BackfillPlan> {
  const now = toIsoTimestamp(opts.now);
  const ownedBy = new Map<string, OwnedProductRow[]>();
  for (const o of owned) {
    const list = ownedBy.get(o.vendor_id) ?? [];
    list.push(o);
    ownedBy.set(o.vendor_id, list);
  }
  const takenLive = new Set(owned.filter((o) => Number(o.licensed) === 1).map((o) => o.product_id));

  const out: VendorBackfillPlan[] = [];
  for (const row of vendors) {
    const products = [...(ownedBy.get(row.id) ?? [])].sort((a, b) =>
      a.product_id < b.product_id ? -1 : a.product_id > b.product_id ? 1 : 0,
    );
    const ent =
      row.ent_id !== null && row.ent_status !== null
        ? {
            tier: row.ent_tier ?? 'verified',
            status: row.ent_status,
            periodEnd: row.ent_period_end,
          }
        : null;
    const base = {
      vendorId: row.id,
      slug: row.slug,
      name: row.company_name,
      verified: Number(row.verified) === 1,
      seatCount: Number(row.seat_count),
      entitlementStatus: row.ent_status,
      auditId: await backfillIds.audit(row.id),
      plan: vendorPlanSnapshot(ent, now),
      ownedProductCount: products.length,
    };
    const skip = (outcome: BackfillOutcome, refusal: string | null = null): VendorBackfillPlan => ({
      ...base,
      outcome,
      refusal,
      createAccount: false,
      accountId: row.account_id ?? '',
      licenses: [],
      perpetual: false,
      heldElsewhere: [],
    });

    const drift = entitlementDrift(row);
    if (drift !== null) {
      out.push(skip('refused', drift));
      continue;
    }
    if (Number(row.license_count) > 0) {
      out.push(skip('already-licensed'));
      continue;
    }

    const createAccount = row.account_id === null;
    const accountId = row.account_id ?? (await backfillIds.account(row.id));
    const licenses: PlannedLicense[] = [];
    const heldElsewhere: string[] = [];
    let perpetual = false;

    const status = row.ent_status;
    if (
      row.ent_id !== null &&
      (status === 'active' || status === 'expired' || status === 'revoked')
    ) {
      const terms = licenseTermsForEntitlement({
        periodStart: row.ent_period_start,
        periodEnd: row.ent_period_end,
        invoiceRef: row.ent_invoice_ref,
        amount: row.ent_amount,
      });
      const grantedAt = row.ent_granted_at ? toIsoTimestamp(row.ent_granted_at) : now;
      const live = status === 'active';
      perpetual = live && terms.endsAt === null;
      const endedAt = live
        ? null
        : toIsoTimestamp(row.ent_ended_at ?? row.ent_period_end ?? row.ent_updated_at ?? now);

      // A live license may only take a product no live license holds. An ended one
      // keeps its product as history and collides with nothing.
      const assignable = live
        ? products.filter((p) => {
            if (takenLive.has(p.product_id)) {
              heldElsewhere.push(p.product_id);
              return false;
            }
            return true;
          })
        : products;
      const count = Math.max(1, products.length);
      for (let i = 0; i < count; i++) {
        const productId = assignable[i]?.product_id ?? null;
        if (live && productId) takenLive.add(productId);
        licenses.push({
          id: await backfillIds.license(row.id, row.ent_id, i),
          source: terms.source,
          startsAt: terms.startsAt ?? grantedAt,
          endsAt: terms.endsAt,
          endedAt,
          endReason: live ? null : (END_REASON[status] ?? null),
          reference: terms.reference,
          assignedProductId: productId,
          assignedAt: productId ? grantedAt : null,
          grantedBy: row.ent_granted_by,
          expiryNoticeSentAt:
            live && terms.endsAt !== null && row.ent_expiry_notice_sent_at
              ? toIsoTimestamp(row.ent_expiry_notice_sent_at)
              : null,
        });
      }
    }

    if (!createAccount && licenses.length === 0) {
      out.push(skip('nothing-to-write'));
      continue;
    }
    out.push({
      ...base,
      outcome: 'write',
      refusal: null,
      createAccount,
      accountId,
      licenses,
      perpetual,
      heldElsewhere,
    });
  }
  return { vendors: out };
}

// ─── Statements ──────────────────────────────────────────────────────────────

function lit(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return `'${escapeSqlLiteral(v)}'`;
}

/** The vendor's account id, read in SQL so a license lands on whichever account
 *  exists at write time (a concurrent claim approval may have made one). */
const accountOf = (vendorId: string) =>
  `(SELECT "id" FROM "billing_accounts" WHERE "vendor_id" = ${lit(vendorId)} ORDER BY "created_at", "id" LIMIT 1)`;

/**
 * The statements for ONE vendor's plan, in order: account, licenses, audit row. The
 * CLI runs them as one `wrangler d1 execute`, so they commit or roll back together.
 * Empty for any outcome but `write`.
 */
export function buildVendorStatements(
  p: VendorBackfillPlan,
  opts: { now: string; operator?: string | null },
): string[] {
  if (p.outcome !== 'write') return [];
  const now = lit(toIsoTimestamp(opts.now));
  const v = lit(p.vendorId);
  const ids = p.licenses.map((l) => lit(l.id)).join(', ');
  const stmts: string[] = [];

  if (p.createAccount) {
    stmts.push(
      [
        'INSERT INTO "billing_accounts" ("id","vendor_id","name","billing_email","stripe_customer_id","created_by","created_at","updated_at")',
        `SELECT ${lit(p.accountId)}, ${v}, ${lit(p.name)}, NULL, NULL, NULL, ${now}, ${now}`,
        `WHERE NOT EXISTS (SELECT 1 FROM "billing_accounts" WHERE "vendor_id" = ${v});`,
      ].join('\n'),
    );
  }

  for (const l of p.licenses) {
    stmts.push(
      [
        'INSERT INTO "licenses" ("id","billing_account_id","source","starts_at","ends_at","ended_at","end_reason","reference","assigned_product_id","assigned_at","granted_by","expiry_notice_sent_at","created_at","updated_at")',
        `SELECT ${lit(l.id)}, ${accountOf(p.vendorId)}, ${lit(l.source)}, ${lit(l.startsAt)}, ${lit(l.endsAt)}, ${lit(l.endedAt)}, ${lit(l.endReason)}, ${lit(l.reference)}, ${lit(l.assignedProductId)}, ${lit(l.assignedAt)}, ${lit(l.grantedBy)}, ${lit(l.expiryNoticeSentAt)}, ${now}, ${now}`,
        // Skip when the vendor holds any license this plan did not mint (it was
        // licensed since the read), or when this license already exists (a re-run).
        'WHERE NOT EXISTS (SELECT 1 FROM "licenses" l JOIN "billing_accounts" b ON b."id" = l."billing_account_id"',
        `                  WHERE b."vendor_id" = ${v} AND l."id" NOT IN (${ids}))`,
        `  AND NOT EXISTS (SELECT 1 FROM "licenses" WHERE "id" = ${lit(l.id)});`,
      ].join('\n'),
    );
  }

  const afterState = {
    billing_account: { id: p.accountId, name: p.name, created: p.createAccount },
    licenses: p.licenses.map((l) => ({
      license_id: l.id,
      source: l.source,
      starts_at: l.startsAt,
      ends_at: l.endsAt,
      ended_at: l.endedAt,
      end_reason: l.endReason,
      reference: l.reference,
      assigned_product_id: l.assignedProductId,
    })),
  };
  const metadata = {
    source: 'ops-cli',
    issue: BACKFILL_LICENSES_ISSUE,
    tool: BACKFILL_LICENSES_TOOL_PATH,
    operator: opts.operator ?? null,
    vendorId: p.vendorId,
    entitlement_status: p.entitlementStatus,
    owned_products: p.ownedProductCount,
    perpetual: p.perpetual,
    license_ids: p.licenses.map((l) => l.id),
  };
  // Written only when something of this plan exists after the statements above, and
  // never twice (its id is deterministic).
  const wrote = [
    ...(p.createAccount
      ? [`EXISTS (SELECT 1 FROM "billing_accounts" WHERE "id" = ${lit(p.accountId)})`]
      : []),
    ...(p.licenses.length > 0 ? [`EXISTS (SELECT 1 FROM "licenses" WHERE "id" IN (${ids}))`] : []),
  ].join(' OR ');
  stmts.push(
    [
      'INSERT INTO "audit_log" ("id","actor_id","actor_type","action","entity_type","entity_id","before_state","after_state","metadata","vendor_id","product_id","vendor_tier","vendor_entitlement_status","created_at")',
      `SELECT ${lit(p.auditId)}, NULL, 'system', ${lit(BILLING_ACCOUNT_BACKFILLED_ACTION)}, 'billing_account', ${accountOf(p.vendorId)}, NULL, ${lit(JSON.stringify(afterState))}, ${lit(JSON.stringify(metadata))}, ${v}, NULL, ${lit(p.plan.tier)}, ${lit(p.plan.status)}, ${now}`,
      `WHERE NOT EXISTS (SELECT 1 FROM "audit_log" WHERE "id" = ${lit(p.auditId)})`,
      `  AND (${wrote});`,
    ].join('\n'),
  );
  return stmts;
}

// ─── Report ──────────────────────────────────────────────────────────────────

export interface BackfillCounts {
  vendorsInScope: number;
  vendorsToWrite: number;
  accountsToCreate: number;
  liveLicenses: number;
  endedLicenses: number;
  assigned: number;
  unassigned: number;
  auditRows: number;
  alreadyLicensed: number;
  nothingToWrite: number;
  refused: number;
}

export function countBackfill(plan: BackfillPlan): BackfillCounts {
  const writes = plan.vendors.filter((v) => v.outcome === 'write');
  const all = writes.flatMap((v) => v.licenses);
  const by = (o: BackfillOutcome) => plan.vendors.filter((v) => v.outcome === o).length;
  return {
    vendorsInScope: plan.vendors.length,
    vendorsToWrite: writes.length,
    accountsToCreate: writes.filter((v) => v.createAccount).length,
    liveLicenses: all.filter((l) => l.endedAt === null).length,
    endedLicenses: all.filter((l) => l.endedAt !== null).length,
    assigned: all.filter((l) => l.assignedProductId !== null).length,
    unassigned: all.filter((l) => l.assignedProductId === null).length,
    auditRows: writes.length,
    alreadyLicensed: by('already-licensed'),
    nothingToWrite: by('nothing-to-write'),
    refused: by('refused'),
  };
}

function vendorLabel(p: VendorBackfillPlan): string {
  return `${p.name} (${p.slug})`;
}

/** The dry-run / pre-apply report: counts, then the lists an operator acts on. */
export function formatLicenseBackfillReport(plan: BackfillPlan): string {
  const c = countBackfill(plan);
  const writes = plan.vendors.filter((v) => v.outcome === 'write');
  const lines: string[] = [];

  lines.push('Counts');
  lines.push(`  vendors in scope (seat, entitlement row, or verified = 1): ${c.vendorsInScope}`);
  lines.push(`  vendors to write:            ${c.vendorsToWrite}`);
  lines.push(`  billing accounts to create:  ${c.accountsToCreate}`);
  lines.push(`  live licenses:               ${c.liveLicenses}`);
  lines.push(`  ended licenses (history):    ${c.endedLicenses}`);
  lines.push(`  assigned / unassigned:       ${c.assigned} / ${c.unassigned}`);
  lines.push(`  audit rows:                  ${c.auditRows}`);
  lines.push(`  skipped, already licensed:   ${c.alreadyLicensed}`);
  lines.push(`  skipped, nothing to write:   ${c.nothingToWrite}`);
  lines.push(`  refused (mirror drift):      ${c.refused}`);

  lines.push('');
  lines.push(`To write: ${writes.length}`);
  for (const p of writes) {
    const live = p.licenses.filter((l) => l.endedAt === null).length;
    const ended = p.licenses.length - live;
    const parts = [
      p.createAccount ? 'new account' : 'existing account',
      `entitlement ${p.entitlementStatus ?? 'none'}`,
      `${live} live`,
      `${ended} ended`,
    ];
    lines.push(`  + ${vendorLabel(p)}: ${parts.join(', ')}`);
  }
  if (writes.length === 0) lines.push('  (none)');

  const perpetual = writes.filter((p) => p.perpetual);
  lines.push('');
  lines.push(`Perpetual rows (period_end NULL, licenses carry ends_at NULL): ${perpetual.length}`);
  for (const p of perpetual) {
    const n = p.licenses.length;
    lines.push(`  ~ ${vendorLabel(p)}: ${n} complimentary license(s) with no end date`);
  }
  if (perpetual.length === 0) lines.push('  (none)');
  else lines.push('  Each needs an end date decision (ruling 2026-10-14).');

  const zero = writes.filter((p) => p.licenses.length > 0 && p.ownedProductCount === 0);
  lines.push('');
  lines.push(`Zero-product vendors (one unassigned license): ${zero.length}`);
  for (const p of zero) lines.push(`  0 ${vendorLabel(p)}`);
  if (zero.length === 0) lines.push('  (none)');

  const held = writes.filter((p) => p.heldElsewhere.length > 0);
  if (held.length > 0) {
    lines.push('');
    lines.push(`Products left unassigned because another live license holds them: ${held.length}`);
    for (const p of held) lines.push(`  = ${vendorLabel(p)}: ${p.heldElsewhere.join(', ')}`);
  }

  const refused = plan.vendors.filter((v) => v.outcome === 'refused');
  lines.push('');
  lines.push(`Mirror drift, refused and not repaired: ${refused.length}`);
  for (const p of refused) lines.push(`  ! ${vendorLabel(p)}: ${p.refusal ?? ''}`);
  if (refused.length === 0) {
    lines.push('  (none)');
  } else {
    lines.push('  This script never writes vendors.verified (STAGE_2_PAID_TIERS_SPEC.md §2.1).');
    lines.push('  Fix the entitlement or the mirror through the admin panel, then re-run.');
  }

  return lines.join('\n');
}

/** The stamp-reconcile section of the report: the licenses whose fence lags. */
export function formatStampLagReport(reconcile: readonly VendorStampReconcile[]): string {
  const total = reconcile.reduce((n, r) => n + r.licenseIds.length, 0);
  const lines = [
    `Expiry-notice stamps to copy from the entitlement (live licenses, same term): ${total}`,
    `  vendors / audit rows: ${reconcile.length}`,
  ];
  for (const r of reconcile) {
    lines.push(
      `  > ${r.name} (${r.slug}): ${r.licenseIds.length} license(s), ends ${r.endsAt}, stamp ${r.stamp}`,
    );
  }
  if (reconcile.length === 0) lines.push('  (none)');
  lines.push('  Licenses this run inserts carry the stamp already and are not counted here.');
  return lines.join('\n');
}
