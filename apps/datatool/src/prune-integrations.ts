/**
 * Prune orphaned `integrations` rows (+ their claims/attestations) from a target
 * env's D1 — the Worker port of
 * `scripts/ops/2026-08-orphan-integration-cleanup/cleanup.sh`.
 *
 * **What an orphan is.** A row that **no Airtable record points at** — no
 * `Integrations.supabase_integration_id` holds its id. Because promote keys
 * identity solely on the caller-supplied `supabaseId` (`promote.ts:28` —
 * "Present → update; absent → insert"), such a row is unreachable: no future
 * promote will update it and nothing will ever delete it. It renders as a
 * duplicate mechanism card on the public pair page.
 *
 * **Why the id list is an input, not something we derive here.** Deciding
 * orphan-hood requires reading Airtable, which this Worker deliberately has no
 * credentials for. So the operator supplies the ids (the runbook's
 * `orphan-ids.txt` produces them) and this module owns the dangerous half:
 * guards, backup, an ordered delete, count repair, and the search/cache refresh.
 * That split also makes the tool reusable for any future stranded-row set rather
 * than hard-coding the 2026-08 batch.
 *
 * **The three guards** are the whole safety story, and a non-zero value on ANY of
 * them blocks the run. Each means "this row is not actually a redundant copy":
 *
 *   - `claimsUniqueToOrphans` — a claim exists only on the orphan, so the
 *     `ON DELETE CASCADE` would destroy curation rather than a duplicate.
 *   - `orphansWithoutATwin` — no surviving row shares its
 *     (source, target, mechanism_name); it is the ONLY copy, not a duplicate.
 *   - `orphansRicherThanTwin` — the orphan's `description`/`notes` are longer
 *     than its twin's, so deleting it would lose editorial content.
 *
 * **Blocking is the default, not an absolute.** A tripped guard means "not
 * redundant residue" — which is usually a reason to stop, but not always. When a
 * curator has *editorially retracted* an edge (deleted the Airtable record on
 * purpose) the live D1 row must go even though it has no twin, because promote has
 * no delete semantics and nothing else will ever remove it (AECI-593). So the
 * route accepts an acknowledgment that must name EXACTLY the guards that tripped,
 * plus a reason. Exact-match rather than "at least these": naming a guard that
 * reads zero proves the plan being acknowledged is not the plan that just ran, so
 * the run refuses. The reason is load-bearing — a prune writes no `audit_log` row,
 * so the observability log line is the only durable record of why.
 *
 * `claims.integration_id` and `attestations.claim_id` both cascade
 * (`apps/api/src/db/schema.ts`), but the delete walks child → parent explicitly
 * so the footprint is auditable rather than implicit.
 *
 * D1 has no undo, and a Worker has no filesystem — so **every** response
 * (dry-run included) carries a complete `rollbackSql`. Save it before executing.
 */

/** Upper bound on a single prune, so a malformed paste can't become a mass delete. */
export const MAX_PRUNE_IDS = 500;

/**
 * Shortest acceptable `acknowledgeReason`. Long enough that "ok" / "yes" won't
 * pass: the reason is the whole audit trail for an overridden guard.
 */
export const MIN_ACK_REASON_LENGTH = 20;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PruneFootprint {
  integrations: number;
  claims: number;
  attestations: number;
}

/**
 * The guard names, in report order. This array is the single source of truth —
 * `PruneGuards` is derived from it, so a new guard cannot be added to one and
 * forgotten in the other (which would make it silently un-acknowledgeable).
 */
export const PRUNE_GUARD_NAMES = [
  'claimsUniqueToOrphans',
  'orphansWithoutATwin',
  'orphansRicherThanTwin',
] as const;

export type PruneGuardName = (typeof PRUNE_GUARD_NAMES)[number];

/** Guard counts for a prune set. Zero on every key ⇒ the rows are redundant copies. */
export type PruneGuards = Record<PruneGuardName, number>;

export interface PruneRow {
  id: string;
  sourceSlug: string | null;
  targetSlug: string | null;
  mechanismName: string | null;
  createdAt: string | null;
}

export interface PrunePlan {
  requested: number;
  /** Ids that resolved to a live `integrations` row. */
  found: number;
  /** Requested ids with no matching row (already deleted, or a bad paste). */
  missing: string[];
  footprint: PruneFootprint;
  guards: PruneGuards;
  /**
   * Names of the guards that tripped. Non-empty ⇒ the execute path refuses unless
   * the operator acknowledges exactly this list with a reason.
   */
  blocked: PruneGuardName[];
  rows: PruneRow[];
  affectedProductIds: string[];
  affectedSlugs: string[];
  /** Full parent→child INSERTs recreating everything this prune would remove. */
  rollbackSql: string;
}

export interface PruneResult {
  deleted: PruneFootprint;
  /** Products whose `integration_count` was recomputed, and the new values. */
  recounted: { productId: string; from: number; to: number }[];
  remaining: { integrations: number };
}

/**
 * Normalize operator input into a validated id list. Accepts a JSON array or a
 * pasted blob (newline / comma / whitespace separated), so the runbook's
 * `orphan-ids.txt` can be pasted straight in. Throws on anything that isn't a
 * UUID rather than silently dropping it — a typo'd id must not quietly shrink
 * the set the operator thinks they reviewed.
 */
export function parseIds(input: unknown): string[] {
  const raw: string[] = Array.isArray(input)
    ? input.map((v) => String(v))
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : [];
  const cleaned = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  const bad = cleaned.filter((s) => !UUID_RE.test(s));
  if (bad.length) {
    throw new Error(`Not a UUID: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}`);
  }
  const unique = [...new Set(cleaned.map((s) => s.toLowerCase()))];
  if (unique.length === 0) throw new Error('No integration ids supplied.');
  if (unique.length > MAX_PRUNE_IDS) {
    throw new Error(`Refusing to prune ${unique.length} ids (max ${MAX_PRUNE_IDS}).`);
  }
  return unique;
}

/**
 * Normalize an operator's guard acknowledgment into validated guard names. Same
 * contract as `parseIds`: accepts a JSON array or a pasted blob, de-dupes, and
 * throws on anything unrecognized rather than dropping it — a typo'd guard name
 * must not quietly downgrade an override into "acknowledged nothing", which the
 * exact-match rule in the route would then reject for the wrong reason.
 *
 * Case-sensitive on purpose: these are code identifiers echoed back verbatim from
 * the dry-run `blocked` list, not free text.
 */
export function parseAcknowledgedGuards(input: unknown): PruneGuardName[] {
  const raw: string[] = Array.isArray(input)
    ? input.map((v) => String(v))
    : typeof input === 'string'
      ? input.split(/[\s,]+/)
      : [];
  const cleaned = raw.map((s) => s.trim()).filter((s) => s.length > 0);
  const known: readonly string[] = PRUNE_GUARD_NAMES;
  const bad = cleaned.filter((s) => !known.includes(s));
  if (bad.length) {
    throw new Error(
      `Not a guard name: ${bad.slice(0, 3).join(', ')}${bad.length > 3 ? ' …' : ''}. Valid names: ${PRUNE_GUARD_NAMES.join(', ')}.`,
    );
  }
  return [...new Set(cleaned)] as PruneGuardName[];
}

/** `?,?,?` for an IN clause — ids are always bound, never interpolated. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

/** Drop the generated columns from a `SELECT *` row so the rollback INSERT is legal. */
function writableColumns(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const generated = GENERATED_COLUMNS[table];
  if (!generated?.length) return row;
  return Object.fromEntries(Object.entries(row).filter(([col]) => !generated.includes(col)));
}

/** SQLite literal for a rollback INSERT. Blobs are out of scope (none on these tables). */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function toInsert(table: string, row: Record<string, unknown>): string {
  const cols = Object.keys(row);
  const vals = cols.map((c) => sqlLiteral(row[c]));
  // OR IGNORE so a partial replay is safe to re-run.
  return `INSERT OR IGNORE INTO "${table}" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${vals.join(',')});`;
}

async function selectAll(
  db: D1Database,
  sql: string,
  binds: unknown[],
): Promise<Record<string, unknown>[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all();
  return (results ?? []) as Record<string, unknown>[];
}

/**
 * Columns SQLite computes and refuses to be given (`cannot INSERT into generated
 * column`). `claims.anchor_id` is `coalesce(integration_id,
 * connector_evidenced_pair_id) STORED` (AECI-721) and arrives through `SELECT *`
 * like any other column — a rollback that echoed it back would be rejected at the
 * exact moment an operator needed it to work.
 *
 * A denylist rather than a schema read on purpose: it is one name, it fails loudly
 * in `prune-integrations.spec.ts` the moment another generated column appears, and
 * the alternative — introspecting `PRAGMA table_info` for `hidden = 2/3` — puts a
 * second D1 round trip and a SQLite version dependency into a recovery path.
 */
const GENERATED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  claims: ['anchor_id'],
};

/**
 * Read the full rows this prune would remove and render them as parent → child
 * INSERTs (`integrations` → `claims` → `attestations`) so the FKs hold on replay.
 * `SELECT *` on purpose: the rollback then can't drift when a column is added —
 * except for generated columns, which are stripped by {@link GENERATED_COLUMNS}.
 */
async function buildRollbackSql(db: D1Database, ids: string[]): Promise<string> {
  const ph = placeholders(ids.length);
  const integrations = await selectAll(
    db,
    `SELECT * FROM integrations WHERE id IN (${ph}) ORDER BY id`,
    ids,
  );
  const claims = await selectAll(
    db,
    `SELECT * FROM claims WHERE integration_id IN (${ph}) ORDER BY id`,
    ids,
  );
  const attestations = await selectAll(
    db,
    `SELECT * FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph})) ORDER BY id`,
    ids,
  );
  return [
    '-- Rollback for datatool prune-integrations.',
    '-- Replay order is parent -> child so the FKs hold; INSERT OR IGNORE makes re-runs safe.',
    `-- integrations: ${integrations.length}, claims: ${claims.length}, attestations: ${attestations.length}`,
    ...integrations.map((r) => toInsert('integrations', writableColumns('integrations', r))),
    ...claims.map((r) => toInsert('claims', writableColumns('claims', r))),
    ...attestations.map((r) => toInsert('attestations', writableColumns('attestations', r))),
    '',
  ].join('\n');
}

/**
 * Everything the operator needs to decide, computed without writing: which ids
 * resolve, how many child rows hang off them, whether any guard trips, which
 * products/slugs are touched, and the rollback SQL.
 */
export async function prunePlan(db: D1Database, ids: string[]): Promise<PrunePlan> {
  const ph = placeholders(ids.length);
  const binds = ids;

  const rows = (await selectAll(
    db,
    `SELECT i.id AS id, s.slug AS sourceSlug, t.slug AS targetSlug,
            i.mechanism_name AS mechanismName, i.created_at AS createdAt
       FROM integrations i
       LEFT JOIN products s ON s.id = i.source_product_id
       LEFT JOIN products t ON t.id = i.target_product_id
      WHERE i.id IN (${ph})
      ORDER BY s.slug, t.slug`,
    binds,
  )) as unknown as PruneRow[];

  const foundIds = new Set(rows.map((r) => r.id.toLowerCase()));
  const missing = ids.filter((id) => !foundIds.has(id));

  // One row of scalar subqueries: footprint (3) + guards (3). The guard SQL is a
  // faithful port of cleanup.sh — see the module doc for what each one means.
  const [agg] = await selectAll(
    db,
    `SELECT
       (SELECT COUNT(*) FROM integrations WHERE id IN (${ph})) AS integrations,
       (SELECT COUNT(*) FROM claims WHERE integration_id IN (${ph})) AS claims,
       (SELECT COUNT(*) FROM attestations
          WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}))) AS attestations,
       (SELECT COUNT(*) FROM claims oc
          JOIN integrations o ON o.id = oc.integration_id
         WHERE o.id IN (${ph})
           AND NOT EXISTS (
             SELECT 1 FROM integrations s JOIN claims sc ON sc.integration_id = s.id
              WHERE s.id NOT IN (${ph})
                AND s.source_product_id = o.source_product_id
                AND s.target_product_id = o.target_product_id
                AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
                AND sc.data_object_id = oc.data_object_id
                AND sc.direction = oc.direction
           )) AS claimsUniqueToOrphans,
       (SELECT COUNT(*) FROM integrations o
         WHERE o.id IN (${ph})
           AND NOT EXISTS (
             SELECT 1 FROM integrations s
              WHERE s.id NOT IN (${ph})
                AND s.source_product_id = o.source_product_id
                AND s.target_product_id = o.target_product_id
                AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
           )) AS orphansWithoutATwin,
       (SELECT COUNT(*) FROM integrations o
          JOIN integrations s ON s.id NOT IN (${ph})
            AND s.source_product_id = o.source_product_id
            AND s.target_product_id = o.target_product_id
            AND IFNULL(s.mechanism_name,'') = IFNULL(o.mechanism_name,'')
         WHERE o.id IN (${ph})
           AND (LENGTH(IFNULL(o.description,'')) > LENGTH(IFNULL(s.description,''))
             OR LENGTH(IFNULL(o.notes,'')) > LENGTH(IFNULL(s.notes,'')))) AS orphansRicherThanTwin`,
    // Ten IN clauses, same list each time.
    [...binds, ...binds, ...binds, ...binds, ...binds, ...binds, ...binds, ...binds, ...binds],
  );

  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));
  const guards: PruneGuards = {
    claimsUniqueToOrphans: num(agg?.claimsUniqueToOrphans),
    orphansWithoutATwin: num(agg?.orphansWithoutATwin),
    orphansRicherThanTwin: num(agg?.orphansRicherThanTwin),
  };
  // Iterate the name list, not Object.keys, so `blocked` has a stable documented
  // order — the operator pastes it back verbatim as `acknowledgeGuards`.
  const blocked = PRUNE_GUARD_NAMES.filter((k) => guards[k] > 0);

  const affected = await selectAll(
    db,
    `SELECT DISTINCT p.id AS id, p.slug AS slug
       FROM integrations i
       JOIN products p ON p.id IN (i.source_product_id, i.target_product_id)
      WHERE i.id IN (${ph})
      ORDER BY p.slug`,
    binds,
  );

  return {
    requested: ids.length,
    found: rows.length,
    missing,
    footprint: {
      integrations: num(agg?.integrations),
      claims: num(agg?.claims),
      attestations: num(agg?.attestations),
    },
    guards,
    blocked,
    rows,
    affectedProductIds: affected.map((r) => String(r.id)),
    affectedSlugs: affected.map((r) => String(r.slug)),
    rollbackSql: await buildRollbackSql(db, ids),
  };
}

/**
 * Delete child → parent, then repair the denormalized `integration_count` on
 * every touched product.
 *
 * The recount is part of THIS operation rather than a follow-up because the
 * column is denormalized: the moment the rows are gone every affected product
 * card overstates its integration count, and leaving that to a separate CLI run
 * is how drift ships to production. Same rule as
 * `apps/api/src/lib/recompute-counts.ts` — count DELIVERED edges regardless of
 * which table holds them (`STAGE_1_5_SPEC.md` §13.5): `integrations` where the
 * product is source OR target, plus `connector_evidenced_pairs` where it is an
 * endpoint in either canonical slot OR the connector itself.
 *
 * The prune only ever deletes from `integrations`, so the evidenced subquery is
 * a constant for any given product here — which is exactly why it must be
 * present. Omitting it would make this repair path write the pre-AECI-721 answer
 * back over a correct count, turning a routine prune into silent count drift on
 * every connector-adjacent product it touches.
 *
 * Caller must pass `affectedProductIds` from the plan: they have to be captured
 * BEFORE the delete, since afterwards the join that finds them is gone.
 */
export async function pruneExecute(
  db: D1Database,
  ids: string[],
  affectedProductIds: string[],
): Promise<PruneResult> {
  const ph = placeholders(ids.length);

  const before = await selectAll(
    db,
    `SELECT
       (SELECT COUNT(*) FROM integrations WHERE id IN (${ph})) AS integrations,
       (SELECT COUNT(*) FROM claims WHERE integration_id IN (${ph})) AS claims,
       (SELECT COUNT(*) FROM attestations
          WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}))) AS attestations`,
    [...ids, ...ids, ...ids],
  );

  const priorCounts = affectedProductIds.length
    ? await selectAll(
        db,
        `SELECT id, integration_count AS c FROM products WHERE id IN (${placeholders(affectedProductIds.length)})`,
        affectedProductIds,
      )
    : [];

  // Explicit child → parent. `db.batch` is atomic on D1 (no interactive txns).
  await db.batch([
    db
      .prepare(
        `DELETE FROM attestations WHERE claim_id IN (SELECT id FROM claims WHERE integration_id IN (${ph}))`,
      )
      .bind(...ids),
    db.prepare(`DELETE FROM claims WHERE integration_id IN (${ph})`).bind(...ids),
    db.prepare(`DELETE FROM integrations WHERE id IN (${ph})`).bind(...ids),
  ]);

  const recounted: PruneResult['recounted'] = [];
  if (affectedProductIds.length) {
    const priorById = new Map(priorCounts.map((r) => [String(r.id), Number(r.c ?? 0)]));
    await db.batch(
      // Plain positional `?` (not `?1`) so the same statement binds identically
      // under D1 and the better-sqlite3 test shim.
      affectedProductIds.map((pid) =>
        db
          .prepare(
            `UPDATE products SET integration_count =
               ((SELECT COUNT(*) FROM integrations WHERE source_product_id = ? OR target_product_id = ?)
                + (SELECT COUNT(*) FROM connector_evidenced_pairs
                     WHERE product_a_id = ? OR product_b_id = ? OR connector_product_id = ?))
             WHERE id = ?`,
          )
          .bind(pid, pid, pid, pid, pid, pid),
      ),
    );
    const after = await selectAll(
      db,
      `SELECT id, integration_count AS c FROM products WHERE id IN (${placeholders(affectedProductIds.length)})`,
      affectedProductIds,
    );
    for (const row of after) {
      const pid = String(row.id);
      recounted.push({ productId: pid, from: priorById.get(pid) ?? 0, to: Number(row.c ?? 0) });
    }
  }

  const [left] = await selectAll(db, `SELECT COUNT(*) AS n FROM integrations`, []);
  const num = (v: unknown) => (typeof v === 'number' ? v : Number(v ?? 0));

  return {
    deleted: {
      integrations: num(before[0]?.integrations),
      claims: num(before[0]?.claims),
      attestations: num(before[0]?.attestations),
    },
    recounted,
    remaining: { integrations: num(left?.n) },
  };
}
