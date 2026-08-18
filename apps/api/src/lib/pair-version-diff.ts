/**
 * The product-PAIR version selection — D1 rows in, `PairVersionDiff` out
 * (AECI-303 / `docs/STAGE_2_ATTESTATIONS_SPEC.md` §9).
 *
 * The *rules* live in `@aeci/shared/version-diff` (pure, zod-free, provable without
 * a database). This module is the plumbing around them: resolve two query params to
 * two `product_versions` rows, build the by-id maps the presence rule reads, and
 * decide access. Same split as `attestation-authority.ts` (row-shaped) vs
 * `agreement.ts` (the rule) — one is testable without D1, the other is about D1.
 *
 * ── DEGRADE, NEVER 404 ──────────────────────────────────────────────────────────
 * An unknown, renamed, over-long, or empty version label falls back to **latest**.
 * The pair exists; only the selection is stale. A 404 here would render the
 * NotFound shell for a valid page — and because the resolved selection is echoed
 * back on the wire (`selected`), the UI shows the truth rather than pretending the
 * URL was honoured. The same degrade-don't-reject rule the `?view` param already
 * follows.
 *
 * ── THE ONE ACCESS CONSULT ──────────────────────────────────────────────────────
 * `resolveDiffAccess` is the ONLY importer of `canViewVersionDiff` in `apps/api`.
 * Both the pair read and the timeline read route through it, so §9.3's seam keeps
 * exactly two consult sites repo-wide (this file and the web pair resolver) even
 * though two handlers need the answer. See its doc comment.
 */

import type { PairVersion, PairVersionDiff } from '@aeci/shared';
import {
  canViewVersionDiff,
  previousVersionPair,
  type ClaimVersionWindow,
  type VersionDiffAccess,
  type VersionPairSelection,
} from '@aeci/shared/version-diff';
import { type ComparableProductVersion } from '@aeci/shared/version-sort';

import type { PairVersionResolver } from './drizzle-helpers';

// The param names live in `@aeci/shared/version-diff` — four places across three
// packages must agree on the spelling, including the SSR Worker's `cacheKeyParams`.
// Re-exported so the handler imports its route contract from one module.
export { CONTEXT_VERSION_PARAM, OTHER_VERSION_PARAM } from '@aeci/shared/version-diff';

/**
 * Longest label a selection param may carry. `product_versions.label` is capped at
 * 60 chars by `CreateProductVersionSchema`, so anything longer cannot match a row —
 * rejecting it early keeps a hostile `?context_version=<10 KB>` from minting a
 * junk edge-cache entry keyed on 10 KB of query string.
 */
const MAX_LABEL_LENGTH = 60;

/** A `product_versions` row, as the pair handler reads it. */
export interface VersionRow {
  id: string;
  productId: string;
  label: string;
  releasedAt: string | null;
  sortKey: number;
  createdAt: string;
}

export interface ResolveVersionSelectionInput {
  /** Both endpoints' versions, already ordered by `VERSION_ORDER` (ascending). */
  readonly versionRows: readonly VersionRow[];
  readonly contextProductId: string;
  readonly otherProductId: string;
  readonly contextParam: string | undefined;
  readonly otherParam: string | undefined;
  /** The viewer's entitlement tier; `null` for every reader until AECI-304. */
  readonly viewerTier: string | null;
  /**
   * Whether any live attestation on this pair carries a version stamp. When no
   * stamp exists, nothing on the page can vary by version, so the diff does not
   * apply and the selectors would be dead chrome — see `resolveVersionSelection`.
   */
  readonly hasVersionStamps: boolean;
}

/**
 * ⚠️ The **only** place `apps/api` consults `canViewVersionDiff`.
 *
 * §9.3 and AECI-303's acceptance criteria require the seam to be consulted in
 * exactly two places — the pair resolver and the API. But two API handlers need the
 * answer (the pair read, whose `historical` depends on the selection, and the
 * timeline read, which is always history), so a direct call in each would make it
 * three. This wrapper reconciles the two: one importer here, one in the web
 * resolver, and AECI-304 swaps the seam without auditing call sites.
 *
 * The looser precedent — `assertVerifiedVendor`'s "ONE function with ONE call site
 * per handler" — does not satisfy the literal AC, which is why this exists.
 */
export function resolveDiffAccess(
  historical: boolean,
  viewerTier: string | null,
): VersionDiffAccess {
  return canViewVersionDiff({ historical, viewerTier });
}

/** Ascending rows for one product, filtered out of the combined read. */
function versionsFor(rows: readonly VersionRow[], productId: string): VersionRow[] {
  return rows.filter((row) => row.productId === productId);
}

/**
 * Resolve one side's selection. Total: always a row when the product has any, and
 * always `null` when it has none.
 *
 * "Latest" is the LAST element, because the caller hands these over already sorted
 * by `VERSION_ORDER` — the SQL mirror of `compareProductVersions`. It is
 * deliberately not "the newest non-sunset release" and never `released_at`: sunset
 * is not an ordering input and `released_at` is nullable (§8.2).
 */
function resolveSide(
  ascending: readonly VersionRow[],
  rawParam: string | undefined,
): VersionRow | null {
  const latest = ascending.length === 0 ? null : (ascending[ascending.length - 1] ?? null);
  if (latest === null) return null;
  const wanted = (rawParam ?? '').trim();
  if (!wanted || wanted.length > MAX_LABEL_LENGTH) return latest;
  // Exact, case-SENSITIVE match. `product_versions_label_key` is a plain unique
  // index with no NOCASE collation, so a case-insensitive match could be ambiguous
  // — and ambiguity here silently shows the reader a different diff.
  return ascending.find((row) => row.label === wanted) ?? latest;
}

function toPairVersion(row: VersionRow): PairVersion {
  // Label + released_at only. No id and no sort_key reach the browser: the API has
  // resolved every comparison, and `released_at` is display-only (§8.2 forbids
  // ordering by it).
  return { label: row.label, released_at: row.releasedAt };
}

/** `VersionRow` narrowed to what the ordering primitive reads. */
function comparable(row: VersionRow | null): ComparableProductVersion | null {
  return row === null ? null : { sortKey: row.sortKey, createdAt: row.createdAt, id: row.id };
}

/**
 * Resolve the pair read's version selection, or `null` when the §9 diff does not
 * apply — which is the ordinary case for the whole catalog today.
 *
 * `null` (and therefore `version_diff: null` on the wire) for any of:
 *
 *   1. **Neither endpoint product has a release.** Promote does not ingest versions
 *      (§11) and the vendor authoring surface is new, so this is nearly every pair.
 *   2. **No live attestation on the pair carries a version stamp.** Both products
 *      could have releases while nothing on *this* pair varies by them; rendering
 *      selectors that can never change anything is worse than rendering none.
 *   3. **The reader is gated to `latest_only` and asked for a historical pair.**
 *      The free latest view is served in full; only the depth is withheld.
 *
 * That single null is the whole browser-side suppression rule, which is what makes
 * "latest × latest renders identically to today for claims with no version data" a
 * structural guarantee rather than a rendering discipline. All three conditions
 * need data only the API has.
 */
export function resolveVersionSelection(
  input: ResolveVersionSelectionInput,
): PairVersionResolver | null {
  const contextAscending = versionsFor(input.versionRows, input.contextProductId);
  const otherAscending = versionsFor(input.versionRows, input.otherProductId);
  if (contextAscending.length === 0 && otherAscending.length === 0) return null;
  if (!input.hasVersionStamps) return null;

  // `historical` is asked of the RAW params, before any degrade: a reader who
  // typed a label is asking for history whether or not it resolves, and the answer
  // must not depend on catalog state a gate cannot see.
  const requestedContext = (input.contextParam ?? '').trim();
  const requestedOther = (input.otherParam ?? '').trim();
  const historical = requestedContext !== '' || requestedOther !== '';
  const access = resolveDiffAccess(historical, input.viewerTier);

  // Gated ⇒ clamp to latest × latest rather than 403. A 403 would make the gate a
  // control-flow branch (`STAGE_2_SPEC.md` §2.2 forbids that) and the SSR resolver
  // treats a non-200 as the NotFound shell — so a shared historical link would cost
  // the reader the FREE latest view, inverting §8.1(4). Clamping keeps the whole
  // free page and declares the reason in `diff_access`.
  const clamped = access === 'latest_only';
  const contextSelected = resolveSide(contextAscending, clamped ? undefined : input.contextParam);
  const otherSelected = resolveSide(otherAscending, clamped ? undefined : input.otherParam);

  const contextLatest = contextAscending[contextAscending.length - 1] ?? null;
  const otherLatest = otherAscending[otherAscending.length - 1] ?? null;
  const isDefault =
    contextSelected?.id === contextLatest?.id && otherSelected?.id === otherLatest?.id;

  const selected: VersionPairSelection = {
    context: comparable(contextSelected),
    other: comparable(otherSelected),
  };

  // No previous pair when the reader is gated: the clamp exists to withhold
  // history, and a diff against the previous release IS history.
  const previousRows = clamped
    ? null
    : previousVersionPair(contextAscending, contextSelected, otherAscending, otherSelected);
  const previous: VersionPairSelection | null =
    previousRows === null
      ? null
      : { context: comparable(previousRows.context), other: comparable(previousRows.other) };

  const labelById = new Map<string, string>();
  const sideById = new Map<string, 'context' | 'other'>();
  const rowById = new Map<string, ComparableProductVersion>();
  for (const row of contextAscending) {
    labelById.set(row.id, row.label);
    sideById.set(row.id, 'context');
    rowById.set(row.id, comparable(row)!);
  }
  for (const row of otherAscending) {
    labelById.set(row.id, row.label);
    sideById.set(row.id, 'other');
    rowById.set(row.id, comparable(row)!);
  }

  const diff: PairVersionDiff = {
    context_versions: contextAscending.map(toPairVersion),
    other_versions: otherAscending.map(toPairVersion),
    selected: {
      context: contextSelected?.label ?? null,
      other: otherSelected?.label ?? null,
    },
    previous:
      previousRows === null
        ? null
        : {
            context: previousRows.context?.label ?? null,
            other: previousRows.other?.label ?? null,
          },
    is_default: isDefault,
    // Filled by the mapper, which is the only thing that has seen the claims.
    counts: { added: 0, removed: 0 },
    diff_access: access,
  };

  return {
    diff,
    selected,
    previous,
    versionLabel: (versionId) => (versionId === null ? undefined : labelById.get(versionId)),
    claimWindows: (attestation) => claimWindows(attestation, sideById, rowById),
  };
}

/**
 * The 0, 1, or 2 presence windows one attestation's stamps contribute.
 *
 * **The side comes from which product the stamped version belongs to, not from the
 * attestation's slot.** §8.2 guarantees the two agree — `resolveVersionStamps`
 * rejects a stamp against the counterparty's release history — but resolving from
 * the data means this needs no special case for the `aeci` slot (which has no side,
 * and carries no stamps today because promote does not ingest versions) and keeps
 * working if the authority rule ever widens.
 *
 * An id that resolves in neither map — only reachable if that rule were violated —
 * is **ignored**, so the claim keeps its "no version data ⇒ always present"
 * baseline. Fail-open toward present is the right direction: the alternative is
 * silently hiding a real flow.
 *
 * Two stamps landing on *different* sides is impossible under §8.2 but handled
 * totally: emit one window per side, each with the one bound it knows.
 */
function claimWindows(
  attestation: { introducedVersionId: string | null; deprecatedVersionId: string | null },
  sideById: ReadonlyMap<string, 'context' | 'other'>,
  rowById: ReadonlyMap<string, ComparableProductVersion>,
): ClaimVersionWindow[] {
  const introducedId = attestation.introducedVersionId;
  const deprecatedId = attestation.deprecatedVersionId;
  const introducedSide = introducedId === null ? undefined : sideById.get(introducedId);
  const deprecatedSide = deprecatedId === null ? undefined : sideById.get(deprecatedId);
  const introduced = introducedId === null ? null : (rowById.get(introducedId) ?? null);
  const deprecated = deprecatedId === null ? null : (rowById.get(deprecatedId) ?? null);

  if (introducedSide === undefined && deprecatedSide === undefined) return [];
  if (introducedSide !== undefined && deprecatedSide === undefined) {
    return [{ side: introducedSide, introduced, deprecated: null }];
  }
  if (introducedSide === undefined && deprecatedSide !== undefined) {
    return [{ side: deprecatedSide, introduced: null, deprecated }];
  }
  if (introducedSide === deprecatedSide) {
    return [{ side: introducedSide!, introduced, deprecated }];
  }
  return [
    { side: introducedSide!, introduced, deprecated: null },
    { side: deprecatedSide!, introduced: null, deprecated },
  ];
}
