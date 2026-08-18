/**
 * Product-version ordering — the `sort_key` derivation and the single comparator
 * (AECI-607 / `docs/STAGE_2_ATTESTATIONS_SPEC.md` §8.2).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
 * `product_versions.label` is vendor-authored free text (`2026.1`, `v5.2`,
 * `R2024 SP1`) and **version labels do not sort lexically**: `'2026.10' < '2026.9'`
 * as strings, and `'v10' < 'v9'`. Every ordering, every "is this version before
 * that one" comparison in the §9 diff, and the "latest" default key off the
 * INTEGER `sort_key` — never off `label`, and never off `released_at`, which is
 * nullable. The API must never expose an ordering derived from the label.
 *
 * ── THE PACKING ─────────────────────────────────────────────────────────────────
 * `deriveVersionSortKey` reads the first three numeric runs in the label and packs
 * them into one base-100000 integer, most significant first:
 *
 *   2026.9   → [2026,  9, 0] → 20_260_000_900_000
 *   2026.10  → [2026, 10, 0] → 20_260_001_000_000   (> 2026.9 — the point)
 *   v9       → [   9, 0,  0] →     90_000_000_000
 *   v10      → [  10, 0,  0] →    100_000_000_000
 *
 * Three segments at five digits each maxes out at `MAX_VERSION_SORT_KEY`, which is
 * an order of magnitude under `Number.MAX_SAFE_INTEGER` — so the value survives
 * JSON, D1's 64-bit INTEGER column, and JS arithmetic without precision loss.
 * Segments beyond the third are ignored and any single segment above
 * `VERSION_SORT_SEGMENT_MAX` clamps; both are lossy by design, because the
 * alternative is a key that silently exceeds the safe-integer range.
 *
 * ── DERIVED, NOT MANDATORY ──────────────────────────────────────────────────────
 * The derivation is the *default*, not the rule. A label the packer cannot read
 * usefully (`"Fall release"`, `"LTS"`) derives 0, so the write API accepts an
 * explicit `sort_key` override and the vendor stays in control. Ordering therefore
 * has to tolerate ties — see `compareProductVersions`.
 *
 * No zod and no `./api/*` import, and deliberately **not** re-exported from the
 * root `src/index.ts` barrel (which carries zod via `export * from './api'`) — the
 * same rule `entitlements.ts` and `algolia.ts` follow. Reach it as
 * `@aeci/shared/version-sort`.
 *
 * (An earlier version of this note said the §9 pair-page selectors would import
 * `compareProductVersions` from a lazy Angular route. As built they do **not**:
 * AECI-303's selector params carry version *labels* and the API sends each product's
 * releases already ordered, so no ordering primitive reaches the browser at all —
 * which is the point, since `PairVersion` deliberately omits `sort_key`. The subpath
 * rationale still holds for `version-diff.ts`, whose `canViewVersionDiff` seam IS
 * imported by the pair resolver.)
 */

/** How many numeric runs of the label are packed into the key. */
export const VERSION_SORT_SEGMENTS = 3;

/** Per-segment ceiling. A larger run clamps rather than overflowing the key. */
export const VERSION_SORT_SEGMENT_MAX = 99_999;

/** The radix each segment occupies — `VERSION_SORT_SEGMENT_MAX + 1`. */
const VERSION_SORT_RADIX = VERSION_SORT_SEGMENT_MAX + 1;

/**
 * The largest key `deriveVersionSortKey` can produce, and the accepted ceiling for
 * a client-supplied override: 99999·100000² + 99999·100000 + 99999 =
 * 999,999,999,999,999 — roughly 1/9th of `Number.MAX_SAFE_INTEGER`.
 */
export const MAX_VERSION_SORT_KEY = 999_999_999_999_999;

const NUMERIC_RUN = /\d+/g;

/**
 * Derive an orderable integer from a free-text version label.
 *
 * Reads the first `VERSION_SORT_SEGMENTS` numeric runs, clamps each to
 * `VERSION_SORT_SEGMENT_MAX`, and packs them most-significant-first. Missing
 * segments count as 0, so `2026.1` sorts before `2026.1.1` and a label with no
 * digits at all derives `0` (the caller should supply an explicit override for
 * those). Pure and total — never throws.
 */
export function deriveVersionSortKey(label: string): number {
  const runs = label.match(NUMERIC_RUN) ?? [];
  let key = 0;
  for (let i = 0; i < VERSION_SORT_SEGMENTS; i += 1) {
    const run = runs[i];
    // `Number()` on a 20-digit run is imprecise but the clamp lands it on
    // VERSION_SORT_SEGMENT_MAX either way, so precision below the ceiling is all
    // that matters.
    const segment = run === undefined ? 0 : Math.min(Number(run), VERSION_SORT_SEGMENT_MAX);
    key = key * VERSION_SORT_RADIX + segment;
  }
  return key;
}

/** The fields ordering needs. Structural, so both the DB row (camelCase) and any
 *  future caller can be compared without a mapper. */
export interface ComparableProductVersion {
  sortKey: number;
  createdAt: string;
  id: string;
}

/**
 * The ONE ordering primitive for product versions: `sort_key` ascending, then
 * `created_at`, then `id`.
 *
 * The tiebreak deliberately **never consults `label`**. Two labels can derive the
 * same key (`"LTS"` and `"Fall release"` both derive 0, and clamping can collide
 * too) and the unique index is on `(product_id, label)`, not on `sort_key` — so
 * ties are legal and the order still has to be total, or §9's "previous version
 * pair" is ambiguous. Falling back to the label would reintroduce exactly the
 * lexical ordering §8.2 forbids; insertion order is arbitrary but honest.
 *
 * Keep in lockstep with the SQL `orderBy` in the read path
 * (`apps/api/src/routes/vendor-product-versions.ts`).
 */
export function compareProductVersions(
  a: ComparableProductVersion,
  b: ComparableProductVersion,
): number {
  if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
