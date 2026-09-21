/**
 * The privacy fence for every agent tool (the point of this spike).
 *
 * ── WHAT THE RISK ACTUALLY IS ────────────────────────────────────────────────
 * Every ROW in the app D1 is already promoted and public — promote is the only
 * INSERT path into `products` / `vendors` / `integrations`, and a retraction is a
 * hard delete. So "the agent read a row it shouldn't" is not the failure mode.
 *
 * The failure mode is **an internal COLUMN on an otherwise-public table**. The
 * public site never renders `products.admin_notes`, `vendors.contact_email`, or
 * the VQS score columns, but they sit in the same row as `name` and `slug`, one
 * `SELECT *` away from a model that will happily quote them back.
 *
 * AECI-779 is the prior art and it is exactly this shape: `attestations.note` is
 * curation-internal when `source = 'aeci'`, and it leaked into the public pair
 * response from TWO separate mappers before anyone noticed. A denylist that is
 * only enforced at one call site is not enforced.
 *
 * ── HOW IT IS ENFORCED ───────────────────────────────────────────────────────
 * Two layers, both cheap:
 *   1. Every D1 tool hand-writes an EXPLICIT column list. There is no `SELECT *`
 *      anywhere in `src/tools/`, and the model never supplies SQL, a table name,
 *      a column name, or a sort direction — only bound values.
 *   2. `src/tools/index.spec.ts` runs EVERY registered tool and asserts that no
 *      name in {@link DENIED_COLUMNS} appears as a key anywhere in its output.
 *      That test is data-driven off the constants below and off the tool
 *      registry, so a new tool is covered the moment it is registered and a new
 *      denied name is enforced against every existing tool for free.
 *
 * ── WHY `note` IS NOT ON THE LIST, AND `notes` IS ────────────────────────────
 * `attestations.note` IS reader-facing when a VENDOR wrote it; the API Worker's
 * `readerFacingNote()` suppresses it only for `source = 'aeci'`. The entity tools
 * go through the shipped public endpoints precisely so that rule keeps applying,
 * so denying the output key `note` outright would be wrong. `integrations.notes`
 * (plural) has no such carve-out — it is curation-internal in every row — and it
 * is denied.
 */

/**
 * Tables no tool may read, at all. A whole-table ban rather than a column list
 * because nothing on them is public and a partial read invites a later "just one
 * more column" edit.
 *
 * Sourced from `apps/api/src/db/schema.ts` and `docs/DATABASE_SCHEMA.md` §12
 * (the app-layer authorization model — D1 has no RLS, so the guard is code).
 */
export const DENIED_TABLES: readonly string[] = [
  // Personal data and account state.
  'profiles', // Supabase-keyed user rows: email, role, ban state.
  'mailing_list', // Lead capture (AECI-257) — subscriber emails.
  'feedback', // Lead capture — free-text plus contact details.
  // Operator / audit surfaces.
  'audit_log', // §26 — actor ids and before/after payloads.
  'page_views', // Raw traffic, IP-derived; ~89% bot and never reader-facing.
  'promote_jobs', // Ingest ledger (AECI-571).
  'job_runs',
  'metrics_daily',
  'stats_cache',
  'asn_registry',
  'indexnow_queue',
  'gsc_recrawl_queue',
  'workflow_instances',
  'workflow_transitions',
  // Commercial state. `vendor_entitlements` is also the no-pay-for-placement
  // firewall: a model that can read a vendor's plan can be led into ranking by it.
  'vendor_entitlements',
  'vendor_seat_invites', // Invite tokens.
  'vendor_requests', // Claim/request workflow, operator-only.
  'integration_field_challenges', // Contests (AECI-1008) — routing is internal.
  // Moderation. Approved review CONTENT is public, but this table carries the
  // moderation columns inline, so it is read through the API Worker or not at all.
  'reviews',
];

/**
 * Column names that must never reach a tool's output, even though the table they
 * sit on is otherwise public. Compared by NAME, in both `snake_case` (the D1
 * column) and the `camelCase` a mapper might produce.
 */
export const DENIED_COLUMNS: readonly string[] = [
  // ── products / vendors: operator notes ────────────────────────────────────
  'admin_notes',
  'research_notes',
  'research_status',
  'tool_integration_check_notes',
  'notes', // integrations + connector_evidenced_pairs — curation-internal.
  // ── vendors: direct contact details ───────────────────────────────────────
  'contact_email',
  'phone_number',
  // ── vendors: the Vendor Quality Score, an internal prioritisation signal ──
  'vqs_credibility',
  'vqs_momentum',
  'vqs_fit',
  'vqs_total',
  'vqs_computed_at',
  // ── products: curation prioritisation and demand research ────────────────
  'priority_tier',
  'priority_score',
  'score_computed_at',
  'google_trends_index',
  'search_volume_monthly',
  'search_checked_at',
  'reddit_mentions_24mo',
  'reddit_checked_at',
  // ── pipeline state, not product facts ─────────────────────────────────────
  'promotion_status',
  'promoted_at',
  'logo_source',
  'usefulness_source',
  // ── reviews: moderation ───────────────────────────────────────────────────
  'rejection_reason',
  'moderated_at',
  'moderated_by',
  'toxicity_score',
  'reviewer_id',
  'verified_work_email',
  'anonymized_at',
  // ── attestations / claims: server-side provenance (AECI-779's neighbourhood)
  'attested_by_vendor_id',
];

const DENIED_COLUMN_SET = new Set<string>([...DENIED_COLUMNS, ...DENIED_COLUMNS.map(toCamelCase)]);

const DENIED_TABLE_SET = new Set<string>(DENIED_TABLES);

function toCamelCase(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Is this column name forbidden in tool output? Case-shape insensitive. */
export function isDeniedColumn(name: string): boolean {
  return DENIED_COLUMN_SET.has(name);
}

/** Is this table forbidden to every tool? */
export function isDeniedTable(name: string): boolean {
  return DENIED_TABLE_SET.has(name);
}

/**
 * Walk any JSON-shaped tool output and collect every denied key it contains.
 * Returns the offending key PATHS so a failing assertion names the leak rather
 * than just reporting that one exists.
 */
export function findDeniedKeys(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findDeniedKeys(item, `${path}[${i}]`));
  }
  if (value === null || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (isDeniedColumn(key)) found.push(`${path}.${key}`);
    found.push(...findDeniedKeys(child, `${path}.${key}`));
  }
  return found;
}
