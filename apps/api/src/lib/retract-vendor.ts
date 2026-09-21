/**
 * retract-vendor — the testable core of the Tier-0 vendor-retraction ops CLI
 * (`apps/api/scripts/retract-vendor.ts`).
 *
 * WHY THIS EXISTS. There is no vendor-delete path anywhere: `POST /api/promote` only
 * upserts, the retraction journal (`docs/REVIEW_APP_PROMOTE_API.md` §5.1) carries only
 * products and integrations, and the review app refuses to delete a vendor that is live
 * in production. So a vendor row that ends up owning nothing — the AECI-1016 re-triage
 * left eight of them, and the daily strand audit has been red on `vendorNoLiveProducts`
 * ever since — can only be removed by hand against the deployed D1. This module holds
 * the *pure* pieces (SQL builders, footprint classification, the audit INSERT, cache-tag
 * set, report formatting) so they can be unit-tested without a live database or
 * `wrangler`; the CLI shell supplies argv, the `wrangler d1 execute` I/O, Algolia
 * credentials, and `console`. Same split as `retract-product.ts`.
 *
 * THE RULE THIS LANE ENFORCES (owner ruling, 2026-09-18, AECI-1024). A vendor is
 * retractable only if it owns **nothing**: zero products and zero owned edges. "Owned
 * edges" means BOTH `integrations.built_by_vendor_id` AND
 * `connector_evidenced_pairs.built_by_vendor_id` — the AECI-721 two-table rule, which
 * this repo has been bitten by three times when a check read only one of them. There is
 * no `--force` for products or edges. There is no legitimate reason to cascade a vendor
 * that owns something: the fix for that vendor is a merge or a product-level retraction,
 * not a delete.
 *
 * WHAT POINTS AT `vendors` (schema snapshot `apps/api/migrations/meta/0042_snapshot.json`;
 * every one of the nine is handled here and nothing else references the table):
 *
 *   table                      column                   on delete   this lane
 *   ─────────────────────────  ───────────────────────  ──────────  ─────────────────────
 *   product_vendors            vendor_id                cascade     REFUSE (the products check)
 *   integrations               built_by_vendor_id       —           REFUSE (owned edge)
 *   connector_evidenced_pairs  built_by_vendor_id       —           REFUSE (owned edge)
 *   profiles                   vendor_id                —           REFUSE (claimed, or was)
 *   vendor_entitlements        vendor_id                cascade     REFUSE (a seat exists)
 *   vendor_seat_invites        vendor_id                cascade     REFUSE (a seat is pending)
 *   claims                     created_by_vendor_id     set null    allowed; reported + NULLed
 *   attestations               attested_by_vendor_id    set null    allowed; reported + NULLed
 *   page_views                 vendor_id                —           allowed; NULLed, never deleted
 *
 * D1 ENFORCES FOREIGN KEYS. `PRAGMA foreign_keys = on|off` is not available on D1 (only
 * `defer_foreign_keys`, and that defers violation *reporting*, not cascade *actions* —
 * migrations `0023`/`0027`/`0033` are all written around that fact). So the three
 * no-action references are genuine blockers: `page_views.vendor_id` must be NULLed before
 * the vendor row goes or the DELETE fails outright. `buildVendorDeleteStatements` orders
 * child→parent and writes every SET NULL explicitly rather than leaning on the FK action,
 * so the statement list is correct and readable regardless of what the engine does.
 *
 * AUDIT (§26.1). Like `retract-product.ts` (since AECI-687), this lane writes an `audit_log` row —
 * one per deleted vendor, in the SAME `wrangler d1 execute` batch as the delete, in the
 * shape `scripts/ops/2026-09-retraction-consumer/consume.mjs` writes. A vendor delete is
 * catalog domain state and the row is the only surviving account of it.
 *
 * WHAT THIS LANE DOES NOT DO:
 *   - It does not touch the review app. Clearing `supabase_vendor_id` upstream and
 *     deleting the upstream record is a separate, manual step (§5.1).
 *   - It does not merge, re-point, or re-curate anything. It only deletes a vendor that
 *     already owns nothing.
 *   - It does not repair `claims.origin`. See `VENDOR_ORIGIN_RESIDUE_NOTE`.
 *   - It does not purge the edge cache itself (no Worker cache context); it prints the
 *     `POST /admin/purge` command, and `production` currently serves uncached anyway.
 */

import { escapeSqlLiteral } from './retract-product';

export { escapeSqlLiteral };

/**
 * `claims` carries a two-column invariant — `origin = 'vendor' ⟺ created_by_vendor_id IS
 * NOT NULL` — that is enforced in application code (`lib/attestation-authority.ts`) and
 * NOT by a DB CHECK (see the `claims` header in `db/schema.ts`). NULLing the vendor id
 * therefore leaves any vendor-origin claim reading `origin = 'vendor'` with no vendor,
 * which the schema comment accepts on purpose ("the claim survives as an orphan for AECi
 * to re-curate"). The lane reports the count loudly rather than silently rewriting
 * `origin` to `'aeci'`, which would assert AECi curated a row it did not.
 */
export const VENDOR_ORIGIN_RESIDUE_NOTE =
  "claims.origin stays 'vendor' with a NULL created_by_vendor_id — an application-level " +
  'invariant this delete breaks by design; re-curate or re-origin those claims by hand.';

/** How the operator named the vendor(s) to retract: by slug (one) or by id (one or many). */
export type RetractVendorTarget = { slug: string } | { id: string };

function targetPredicate(target: RetractVendorTarget): string {
  return 'slug' in target
    ? `"slug" = '${escapeSqlLiteral(target.slug)}'`
    : `"id" = '${escapeSqlLiteral(target.id)}'`;
}

/** The identity row read first — resolves a target to a concrete id + slug and surfaces
 *  the name/status/verified bit for the confirmation report. */
export interface VendorRow {
  id: string;
  slug: string;
  company_name: string;
  promotion_status: string;
  verified: number;
}

const VENDOR_COLUMNS = `"id", "slug", "company_name", "promotion_status", "verified"`;

export function buildVendorLookupSql(target: RetractVendorTarget): string {
  return `SELECT ${VENDOR_COLUMNS} FROM "vendors" WHERE ${targetPredicate(target)} LIMIT 1;`;
}

/**
 * Batch identity read. One statement for the whole cohort so the plan is resolved from a
 * single consistent read — the eight-vendor AECI-1024 run is the immediate case. Ordered
 * by id so the plan, the report and `--confirm-count` all see the same sequence.
 */
export function buildVendorLookupSqlForIds(ids: readonly string[]): string {
  const list = ids.map((id) => `'${escapeSqlLiteral(id)}'`).join(', ');
  return `SELECT ${VENDOR_COLUMNS} FROM "vendors" WHERE "id" IN (${list}) ORDER BY "id";`;
}

/**
 * One-row footprint: every table that references the vendor. All scalar subqueries in a
 * single SELECT (not a compound UNION — D1 caps compound-SELECT terms at 5). The escaped
 * vendor id is interpolated as a quoted literal into every subquery.
 *
 * `products` is counted through `product_vendors`, which is the ownership edge; there is
 * no `products.vendor_id`. `integrations` and `connector_evidenced_pairs` are counted
 * SEPARATELY and both are blockers — a single-table edge check is the AECI-721 trap.
 */
export function buildVendorFootprintSql(id: string): string {
  const v = `'${escapeSqlLiteral(id)}'`;
  return `SELECT
    (SELECT count(*) FROM "product_vendors" WHERE "vendor_id" = ${v}) AS products,
    (SELECT count(*) FROM "integrations" WHERE "built_by_vendor_id" = ${v}) AS integrations,
    (SELECT count(*) FROM "connector_evidenced_pairs" WHERE "built_by_vendor_id" = ${v}) AS evidenced_pairs,
    (SELECT count(*) FROM "profiles" WHERE "vendor_id" = ${v}) AS profiles,
    (SELECT count(*) FROM "vendor_entitlements" WHERE "vendor_id" = ${v}) AS entitlements,
    (SELECT count(*) FROM "vendor_seat_invites" WHERE "vendor_id" = ${v}) AS seat_invites,
    (SELECT count(*) FROM "claims" WHERE "created_by_vendor_id" = ${v}) AS claims,
    (SELECT count(*) FROM "attestations" WHERE "attested_by_vendor_id" = ${v}) AS attestations,
    (SELECT count(*) FROM "page_views" WHERE "vendor_id" = ${v}) AS page_views;`;
}

/** Raw footprint row as D1 returns it. */
export interface RawVendorFootprintRow {
  products: number;
  integrations: number;
  evidenced_pairs: number;
  profiles: number;
  entitlements: number;
  seat_invites: number;
  claims: number;
  attestations: number;
  page_views: number;
}

export interface VendorFootprint {
  products: number;
  integrations: number;
  evidencedPairs: number;
  profiles: number;
  entitlements: number;
  seatInvites: number;
  claims: number;
  attestations: number;
  pageViews: number;
}

export function parseVendorFootprint(row: RawVendorFootprintRow): VendorFootprint {
  return {
    products: row.products,
    integrations: row.integrations,
    evidencedPairs: row.evidenced_pairs,
    profiles: row.profiles,
    entitlements: row.entitlements,
    seatInvites: row.seat_invites,
    claims: row.claims,
    attestations: row.attestations,
    pageViews: row.page_views,
  };
}

export interface VendorRetractionClassification {
  safe: boolean;
  blockers: string[];
}

/**
 * Does this vendor own anything? Six counts refuse and there is no override for any of
 * them. `claims`, `attestations` and `page_views` never refuse — they are detached, not
 * destroyed, and the CLI reports each count.
 */
export function classifyVendorRetraction(
  footprint: VendorFootprint,
): VendorRetractionClassification {
  const blockers: string[] = [];
  if (footprint.products > 0) blockers.push(`owns ${footprint.products} product(s)`);
  if (footprint.integrations > 0)
    blockers.push(`built ${footprint.integrations} integration(s) (\`built_by_vendor_id\`)`);
  if (footprint.evidencedPairs > 0)
    blockers.push(
      `built ${footprint.evidencedPairs} connector-evidenced pair(s) (\`built_by_vendor_id\`)`,
    );
  if (footprint.profiles > 0)
    blockers.push(`${footprint.profiles} profile(s) attached — the vendor is claimed, or was`);
  if (footprint.entitlements > 0)
    blockers.push(`${footprint.entitlements} entitlement row(s) — a seat exists`);
  if (footprint.seatInvites > 0)
    blockers.push(`${footprint.seatInvites} seat invite(s) — a seat is pending`);
  return { safe: blockers.length === 0, blockers };
}

// ─── The audit row ───────────────────────────────────────────────────────────

/** `scripts/ops/2026-09-retraction-consumer/consume.mjs` sqlLiteral, same semantics. */
function sqlLiteral(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${escapeSqlLiteral(String(v))}'`;
}

export const RETRACT_VENDOR_TOOL_PATH = 'apps/api/scripts/retract-vendor.ts';
export const RETRACT_VENDOR_ISSUE = 'AECI-1024';
export const RETRACT_VENDOR_REASON =
  'vendor owns no products and no edges (owner ruling 2026-09-18)';

export interface VendorAuditInsertArgs {
  vendor: VendorRow;
  footprint: VendorFootprint;
  /** Injected so the statement is deterministic under test. */
  auditId: string;
  /** ISO-8601, injected for the same reason. */
  now: string;
  operator?: string;
}

/**
 * One `audit_log` INSERT per deleted vendor, in the same batch as the delete (§26.1).
 * Column list and shape copied from `consume.mjs`'s `buildAuditInsert`: `actor_id` is
 * NULL (no operator profile row exists for a CLI run), `actor_type` is `'system'`,
 * `before_state` holds the vendor row and the detach counts, and `metadata` carries the
 * tool, the issue and the ruling that authorised it.
 *
 * `actor_type` must stay inside the `audit_log_actor_type_check` CHECK
 * (`user|admin|system|workflow`); `entity_type` is deliberately unconstrained.
 */
export function buildVendorAuditInsert({
  vendor,
  footprint,
  auditId,
  now,
  operator = 'chrisw@thewbsproject.com',
}: VendorAuditInsertArgs): string {
  const beforeState = {
    table: 'vendors',
    row: vendor,
    detached: {
      claims: footprint.claims,
      attestations: footprint.attestations,
      page_views: footprint.pageViews,
    },
  };
  const metadata = {
    source: 'operator-ruling',
    issue: RETRACT_VENDOR_ISSUE,
    reason: RETRACT_VENDOR_REASON,
    ruling_source: 'owner ruling 2026-09-18 (AECI-1024): a vendor owning nothing is retractable',
    operator,
    tool: RETRACT_VENDOR_TOOL_PATH,
    table: 'vendors',
    origin_residue: footprint.claims > 0 ? VENDOR_ORIGIN_RESIDUE_NOTE : null,
  };
  const cols = [
    'id',
    'actor_id',
    'actor_type',
    'action',
    'entity_type',
    'entity_id',
    'before_state',
    'metadata',
    'created_at',
  ];
  const vals = [
    sqlLiteral(auditId),
    'NULL',
    sqlLiteral('system'),
    sqlLiteral('vendor.deleted'),
    sqlLiteral('vendor'),
    sqlLiteral(vendor.id),
    sqlLiteral(JSON.stringify(beforeState)),
    sqlLiteral(JSON.stringify(metadata)),
    sqlLiteral(now),
  ];
  return `INSERT INTO "audit_log" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${vals.join(',')});`;
}

// ─── The delete plan ─────────────────────────────────────────────────────────

/**
 * Ordered statements to detach and remove one vendor, child→parent. The three SET NULLs
 * come first because D1 enforces the FKs and `page_views.vendor_id` has no `ON DELETE`
 * action at all, so it would block the vendor DELETE outright. `claims` and `attestations`
 * would be NULLed by their own `ON DELETE SET NULL`, but they are written explicitly so
 * the plan reads the same as it behaves.
 *
 * `page_views` rows are NEVER deleted — they are log-class traffic history whose value
 * does not depend on the vendor row surviving.
 *
 * The audit INSERT is the LAST statement, so it lands in the same batch as the delete and
 * rolls back with it if the delete fails. Nothing after it can leave a row claiming a
 * deletion that did not happen.
 */
export function buildVendorDeleteStatements(args: VendorAuditInsertArgs): string[] {
  const v = `'${escapeSqlLiteral(args.vendor.id)}'`;
  return [
    // Detach, never destroy.
    `UPDATE "page_views" SET "vendor_id" = NULL WHERE "vendor_id" = ${v};`,
    `UPDATE "claims" SET "created_by_vendor_id" = NULL WHERE "created_by_vendor_id" = ${v};`,
    `UPDATE "attestations" SET "attested_by_vendor_id" = NULL WHERE "attested_by_vendor_id" = ${v};`,
    // The vendor itself. Everything else that references it was a refusal.
    `DELETE FROM "vendors" WHERE "id" = ${v};`,
    // §26.1 — same batch as the mutation.
    buildVendorAuditInsert(args),
  ];
}

/**
 * Cache-Tags to purge so no edge-cached page keeps rendering the deleted vendor. The
 * vendor detail page sets `vendor:<slug>` (`apps/web/src/server/cache-tags.ts`); AECI-165
 * removed the `/vendors` index page, so there is no `index:vendors` tag, and a vendor that
 * owns no products appears embedded on no product page either.
 */
export function buildCacheTagsForVendor(slug: string): string[] {
  return [`vendor:${slug}`];
}

// ─── Reporting ───────────────────────────────────────────────────────────────

export interface VendorPlanEntry {
  vendor: VendorRow;
  footprint: VendorFootprint;
  classification: VendorRetractionClassification;
  /** `undefined` when Algolia was not consulted (no creds, `--local`, `--skip-algolia`). */
  inAlgolia?: boolean;
}

/** Human-readable footprint block for one vendor in the dry-run / pre-apply report. */
export function formatVendorFootprintReport(entry: VendorPlanEntry): string {
  const { vendor, footprint, classification } = entry;
  const rows: Array<[string, number]> = [
    ['products (product_vendors)', footprint.products],
    ['integrations built', footprint.integrations],
    ['connector-evidenced pairs built', footprint.evidencedPairs],
    ['profiles attached', footprint.profiles],
    ['entitlements', footprint.entitlements],
    ['seat invites', footprint.seatInvites],
    ['claims → created_by NULLed', footprint.claims],
    ['attestations → attested_by NULLed', footprint.attestations],
    ['page_views → vendor_id NULLed', footprint.pageViews],
  ];
  const algolia = entry.inAlgolia === undefined ? 'not checked' : entry.inAlgolia ? 'yes' : 'no';
  const lines = [
    `Vendor:   ${vendor.company_name}  (slug: ${vendor.slug})`,
    `Id:       ${vendor.id}`,
    `Status:   ${vendor.promotion_status}${vendor.verified ? '  [verified]' : ''}`,
    `Algolia:  ${algolia}`,
    '',
    'Footprint (rows that will be removed / detached):',
    ...rows.map(([label, n]) => `  ${n === 0 ? ' ' : '•'} ${label.padEnd(36)} ${n}`),
  ];
  if (!classification.safe) {
    lines.push('', '  REFUSED — this vendor owns something:');
    for (const b of classification.blockers) lines.push(`     ✗ ${b}`);
  }
  return lines.join('\n');
}

/**
 * `--confirm-count` gate, same contract as `consume.mjs`: required to apply, must be an
 * integer, and must equal the resolved plan size. The point is that the plan is read from
 * the database at apply time, so a cohort that changed between the dry run and the apply
 * refuses instead of quietly deleting a different set.
 */
export function checkConfirmCount(
  raw: string | undefined,
  planLength: number,
): { ok: boolean; message?: string } {
  if (raw === undefined) {
    return {
      ok: false,
      message: `--confirm-count is required to apply. The plan is ${planLength} vendor(s).`,
    };
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return {
      ok: false,
      message: `--confirm-count must be an integer. Got: ${raw}. The plan is ${planLength} vendor(s).`,
    };
  }
  if (n !== planLength) {
    return {
      ok: false,
      message:
        `--confirm-count ${n} does not match the resolved plan of ${planLength}.\n` +
        'The catalog moved between the dry run and this one. Re-read it before applying.',
    };
  }
  return { ok: true };
}
