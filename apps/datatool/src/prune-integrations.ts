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
 * `claims.integration_id` and `attestations.claim_id` both cascade
 * (`apps/api/src/db/schema.ts`), but the delete walks child → parent explicitly
 * so the footprint is auditable rather than implicit.
 *
 * D1 has no undo, and a Worker has no filesystem — so **every** response
 * (dry-run included) carries a complete `rollbackSql`. Save it before executing.
 */

/** Upper bound on a single prune, so a malformed paste can't become a mass delete. */
export const MAX_PRUNE_IDS = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PruneFootprint {
  integrations: number;
  claims: number;
  attestations: number;
}

export interface PruneGuards {
  claimsUniqueToOrphans: number;
  orphansWithoutATwin: number;
  orphansRicherThanTwin: number;
}

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
  /** Names of the guards that tripped. Non-empty ⇒ the execute path refuses. */
  blocked: (keyof PruneGuards)[];
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

/** `?,?,?` for an IN clause — ids are always bound, never interpolated. */
function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
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
 * Read the full rows this prune would remove and render them as parent → child
 * INSERTs (`integrations` → `claims` → `attestations`) so the FKs hold on replay.
 * `SELECT *` on purpose: the rollback then can't drift when a column is added.
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
    ...integrations.map((r) => toInsert('integrations', r)),
    ...claims.map((r) => toInsert('claims', r)),
    ...attestations.map((r) => toInsert('attestations', r)),
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
  const blocked = (Object.keys(guards) as (keyof PruneGuards)[]).filter((k) => guards[k] > 0);

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
 * `apps/api/src/lib/recompute-counts.ts` — count integrations where the product
 * is source OR target.
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
               (SELECT COUNT(*) FROM integrations WHERE source_product_id = ? OR target_product_id = ?)
             WHERE id = ?`,
          )
          .bind(pid, pid, pid),
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
