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
    '  e."granted_at" AS "ent_granted_at", e."ended_at" AS "ent_ended_at", e."updated_at" AS "ent_updated_at"',
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
        'INSERT INTO "licenses" ("id","billing_account_id","source","starts_at","ends_at","ended_at","end_reason","reference","assigned_product_id","assigned_at","granted_by","created_at","updated_at")',
        `SELECT ${lit(l.id)}, ${accountOf(p.vendorId)}, ${lit(l.source)}, ${lit(l.startsAt)}, ${lit(l.endsAt)}, ${lit(l.endedAt)}, ${lit(l.endReason)}, ${lit(l.reference)}, ${lit(l.assignedProductId)}, ${lit(l.assignedAt)}, ${lit(l.grantedBy)}, ${now}, ${now}`,
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
