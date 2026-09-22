/**
 * The "live integration" predicate, raw-SQL form (AECI-1010 /
 * `STAGE_1_5_SPEC.md` §13.5).
 *
 * An `integrations` row is LIVE when `retired_at IS NULL`. The owner retires a row
 * (`POST /api/vendor/integrations/:id/retire`) and restores it; a retired row keeps
 * its claims and attestations but counts nowhere, is searchable nowhere and renders
 * on no public page. Retire is not retract (ADR 0030): nothing is deleted.
 *
 * This module is the string half, for the sites that write SQL by hand and cannot
 * import from `apps/api`: the datatool reindex and prune, the catalog agent's
 * queries and the API's own operator scripts. The Drizzle half is
 * `apps/api/src/lib/live-integration.ts`, and both are pinned by
 * `apps/api/src/lib/count-lockstep.spec.ts`.
 *
 * Three rules, each of which has a failure behind it:
 *
 * 1. **`IS NULL`, never `= NULL`.** A comparison with NULL is never true. On the
 *    09:00 orphan sweep's id set that empties the set, and an empty set makes every
 *    record look orphaned (the cap then refuses the pass, so retired records are
 *    never swept either).
 * 2. **`integrations` only.** `connector_evidenced_pairs` has no `retired_at`. Every
 *    row there is connector-powered, and decision 9 of AECI-1003 keeps every vendor
 *    write, retire included, off connector-powered rows. Do not add the predicate to
 *    an evidenced-pair arm "for symmetry": the column does not exist.
 * 3. **Never key membership on `claimed_at` or `origin`.** Only `retired_at` removes
 *    a row. A predicate on either ownership column drops a small live subset, which
 *    sits under the orphan sweep's 50-delete cap and is deleted permanently.
 *
 * `scripts/ops/**` is plain `.mjs` and cannot import this. Those sites carry the
 * literal `retired_at IS NULL`, and the lockstep spec's source scan checks them.
 */

/** The column. Exported so a source scan can name it without a string literal. */
export const INTEGRATION_RETIRED_COLUMN = 'retired_at';

/** `<alias>."retired_at" IS NULL`: the row is live. Pass the table alias the
 *  surrounding query uses (`i`, `bi`, `integrations`). */
export function liveIntegrationSql(alias: string): string {
  return `${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NULL`;
}

/** `<alias>."retired_at" IS NOT NULL`: the exact complement of
 *  {@link liveIntegrationSql}. The sync's delete arm is built from this. */
export function retiredIntegrationSql(alias: string): string {
  return `${alias}."${INTEGRATION_RETIRED_COLUMN}" IS NOT NULL`;
}
