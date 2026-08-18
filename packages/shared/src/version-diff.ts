/**
 * The version-diff rules — claim presence at a version pair, the previous version
 * pair, `added`/`removed`/`unchanged`, and the `canViewVersionDiff` entitlement
 * seam (AECI-303 / `docs/STAGE_2_ATTESTATIONS_SPEC.md` §9).
 *
 * ── WHAT THIS ANSWERS ───────────────────────────────────────────────────────────
 * The pair page offers two selectors — the context product's version × the other
 * product's version. For a chosen pair, every claim resolves to one of three
 * states relative to the *previous* version pair. This module is the whole rule,
 * pure and total, so it is provable without D1 and cannot drift between the
 * handler that computes it and any future consumer.
 *
 * ── ORDERING: ONE COMPARATOR, NEVER TWO ─────────────────────────────────────────
 * Everything here compares through `compareProductVersions`
 * (`./version-sort`) — never a raw `sortKey` subtraction, never `label`, never the
 * nullable `released_at`. §9.1 states the presence rule in terms of
 * `sort_key <= sort_key`, and that is the same thing whenever sort keys are
 * distinct; the comparator is used anyway because ties are legal (the unique
 * index is on `(product_id, label)`, and every digit-free label derives 0) and
 * §8.4 records that the `created_at`/`id` tiebreak exists *precisely* so §9's
 * "previous version pair" has a total order. Using that order for presence too
 * means the system carries ONE comparator instead of two that agree by luck.
 *
 * ── THE TRAP: `sort_key` IS PER-PRODUCT ─────────────────────────────────────────
 * `deriveVersionSortKey` packs a product's own label into an integer, so keys are
 * only meaningful *within* one product. Procore `2026.1` packs to
 * 20_260_000_900_000 and Revit `v5.2` to 50_000_200_000 — comparing them is
 * meaningless arithmetic that looks like it works. That is why there is no
 * "merged timeline" here and why `previousVersionPair` steps each side
 * independently. Do not "optimize" the two axes into one.
 *
 * No zod and no `./api/*` import, and deliberately **not** re-exported from the
 * root `src/index.ts` barrel (which carries zod via `export * from './api'`) — the
 * same rule `version-sort.ts` and `algolia.ts` follow, because the pair page is a
 * lazy Angular route. Reach it as `@aeci/shared/version-diff`.
 */

import { compareProductVersions, type ComparableProductVersion } from './version-sort';

// ---------------------------------------------------------------------------
// The URL contract
// ---------------------------------------------------------------------------

/**
 * The two selector query params, carrying a version **label** each.
 *
 * Declared here because FOUR places must agree on the spelling and three of them
 * are in different packages: the API handler that reads them, the Angular resolver
 * and page that read and write them, and — critically — the SSR Worker's
 * `cacheKeyParams` for the pair route (`apps/web/src/server-runtime.ts`). Miss the
 * last one and two selections collapse onto one edge-cache entry, serving one
 * reader's version choice, and its robots tag, to everyone (`CACHE_STRATEGY.md`
 * §4a). That file cannot import from here (it is the Worker entry, and this is a
 * value import into the SSR bundle's critical path), so its allowlist is a literal
 * — which is exactly why the spelling is pinned in one place and asserted in
 * `cache-key-url.spec.ts`.
 *
 * Labels rather than version ids: labels are unique per product
 * (`product_versions_label_key`), so they are a natural key, and the whole value of
 * this feature is a link somebody sends a colleague — `?context_version=2026.1` is
 * that link, a UUID pair is not. It also lets the wire omit both `id` and
 * `sort_key`, which is what structurally stops the browser re-deriving order. The
 * accepted cost is link rot on a rename, which degrades to latest (§9.2 keeps such
 * URLs out of the index anyway).
 */
export const CONTEXT_VERSION_PARAM = 'context_version';
export const OTHER_VERSION_PARAM = 'other_version';

// ---------------------------------------------------------------------------
// The presence rule (§9.1)
// ---------------------------------------------------------------------------

/**
 * One live version stamp, reduced to what presence needs: which endpoint's
 * release timeline it speaks in, and its two bounds. Structural, so a DB row maps
 * in without a dedicated mapper.
 *
 * `side` is resolved from which product the stamped version actually belongs to,
 * **not** from the attestation's slot. §8.2 guarantees the two agree (a
 * `vendor_a` attestation may only stamp versions of endpoint A, enforced by
 * `resolveVersionStamps`), but resolving from the data means this rule keeps
 * working if that ever changes — and it needs no special case for the `aeci`
 * slot, which carries no stamps today because promote does not ingest versions
 * (§11).
 *
 * A `null` bound is open-ended: `introduced === null` means "has always been
 * there", `deprecated === null` means "still there".
 */
export interface ClaimVersionWindow {
  readonly side: 'context' | 'other';
  readonly introduced: ComparableProductVersion | null;
  readonly deprecated: ComparableProductVersion | null;
}

/**
 * The version selected on each side. `null` means that product has no versions at
 * all, so no stamp can reference it and its side is vacuously satisfied.
 */
export interface VersionPairSelection {
  readonly context: ComparableProductVersion | null;
  readonly other: ComparableProductVersion | null;
}

/** Does `window`'s own side admit `at`? Open bounds are always satisfied. */
function windowAdmits(window: ClaimVersionWindow, at: VersionPairSelection): boolean {
  const selected = window.side === 'context' ? at.context : at.other;
  // No version selected on that side means the product has no releases, so a
  // stamp against it cannot exist and there is nothing to exclude.
  if (selected === null) return true;
  // `introduced <= selected` — inclusive: a flow introduced IN this version is
  // present in it.
  if (window.introduced !== null && compareProductVersions(window.introduced, selected) > 0) {
    return false;
  }
  // `selected < deprecated` — strict: a flow deprecated IN this version is gone
  // FROM it. Explicit null check rather than a MAX_VERSION_SORT_KEY sentinel; an
  // explicit `sort_key` override may legally equal that ceiling, which would make
  // the comparison false at the top of the range.
  if (window.deprecated !== null && compareProductVersions(selected, window.deprecated) >= 0) {
    return false;
  }
  return true;
}

/**
 * §9.1's presence rule. A claim is present at `at` when **every** window admits
 * the selection on its own side.
 *
 * **No windows ⇒ always present.** That is the Stage 1.5 baseline the spec bolds:
 * every claim promote has ever written is unstamped, and it must not vanish from
 * the default view. It is also the fail-open direction for a stamp whose version
 * row no longer resolves (`ON DELETE SET NULL` degrades the stamp rather than
 * deleting the assertion — §8.2), because the caller drops such a stamp and the
 * claim keeps rendering.
 */
export function isClaimPresentAt(
  windows: readonly ClaimVersionWindow[],
  at: VersionPairSelection,
): boolean {
  return windows.every((window) => windowAdmits(window, at));
}

// ---------------------------------------------------------------------------
// The previous version pair (§9.1 does not define it)
// ---------------------------------------------------------------------------

/**
 * The version immediately before `selected` in `ascending`, or `null` when
 * `selected` is the earliest (or absent from the list, or `null`).
 *
 * `ascending` must already be sorted by `compareProductVersions` — the API's
 * `VERSION_ORDER` read is the same rule in SQL. Identity is by `id`, so a caller
 * holding a copy of the row still resolves.
 */
export function previousVersion<T extends ComparableProductVersion>(
  ascending: readonly T[],
  selected: ComparableProductVersion | null,
): T | null {
  if (selected === null) return null;
  const index = ascending.findIndex((candidate) => candidate.id === selected.id);
  if (index <= 0) return null;
  return ascending[index - 1] ?? null;
}

/**
 * The version pair the diff is measured against — **each side stepped back one
 * release, independently**. A side with no predecessor holds its current version;
 * when NEITHER side can step back there is no previous pair at all and the caller
 * reports every present claim as `unchanged`.
 *
 * Two alternatives were rejected, and both are worth naming because both look
 * reasonable:
 *
 *   - **Step only the context side.** Breaks orientation symmetry. A pair renders
 *     from either of its two URLs over identical data, so a context-only step
 *     would compute *different diffs* for the same pair depending on which
 *     product the reader came from.
 *   - **Merge both products' releases into one timeline and step back the
 *     globally-newer version.** Requires comparing `sort_key` across products,
 *     which is meaningless (see the module header). `released_at` cannot stand in
 *     either — it is nullable, and §8.2 forbids ordering by it.
 *
 * A third option — walk back until the claim set actually differs, so the diff is
 * never a no-op — is nicer UX but O(|A|×|B|) and makes "added" mean "added at some
 * unspecified earlier point". Noted as a possible later refinement, not built.
 */
export function previousVersionPair<T extends ComparableProductVersion>(
  contextAscending: readonly T[],
  contextSelected: T | null,
  otherAscending: readonly T[],
  otherSelected: T | null,
): { context: T | null; other: T | null } | null {
  const previousContext = previousVersion(contextAscending, contextSelected);
  const previousOther = previousVersion(otherAscending, otherSelected);
  if (previousContext === null && previousOther === null) return null;
  return {
    context: previousContext ?? contextSelected,
    other: previousOther ?? otherSelected,
  };
}

// ---------------------------------------------------------------------------
// added / removed / unchanged
// ---------------------------------------------------------------------------

/** The three states a claim can hold for a selected version pair (§9.1). */
export const VERSION_STATUSES = ['added', 'removed', 'unchanged'] as const;

export type VersionStatus = (typeof VERSION_STATUSES)[number];

/**
 * Resolve one claim's state for `selected`, relative to `previous`.
 *
 * `previous === null` (neither side has a predecessor) means there is no prior
 * state to compare, so a present claim is `unchanged` — the earliest version pair
 * is a baseline, not a wave of additions.
 *
 * A claim that is present at **neither** pair belongs to an earlier era and
 * reports `unchanged`; the caller **must drop it from the response** rather than
 * render it, or a pair with a long release history would show every flow it ever
 * had. `isClaimPresentAt` is the caller's test for that (present at selected OR
 * at previous ⇒ keep).
 */
export function claimVersionStatus(
  windows: readonly ClaimVersionWindow[],
  selected: VersionPairSelection,
  previous: VersionPairSelection | null,
): VersionStatus {
  const presentNow = isClaimPresentAt(windows, selected);
  if (previous === null) return 'unchanged';
  const presentBefore = isClaimPresentAt(windows, previous);
  if (presentNow === presentBefore) return 'unchanged';
  return presentNow ? 'added' : 'removed';
}

// ---------------------------------------------------------------------------
// The entitlement seam (§9.3)
// ---------------------------------------------------------------------------

/**
 * How much diff depth a reader may see. An enum rather than a boolean because
 * `STAGE_2_SPEC.md` §2.2 requires entitlements to be "data, not code branches
 * scattered across the app": the API stamps this value into the payload and the
 * render path switches on it, so adding a rung later is a member here plus one
 * branch in the view — never a new conditional in a handler.
 */
export const VERSION_DIFF_ACCESS = ['full', 'latest_only'] as const;

export type VersionDiffAccess = (typeof VERSION_DIFF_ACCESS)[number];

export interface VersionDiffRequest {
  /**
   * Is anything other than latest × latest being asked for? Passing this in —
   * rather than asking the seam a bare entitlement question — is what makes the
   * §8.1(4) invariant a labelled line of code instead of a convention.
   */
  readonly historical: boolean;
  /**
   * The viewer's entitlement tier; `null` for an anonymous reader, which is every
   * reader until AECI-304. Accepted and ignored today so the swap to
   * `hasCapability(tier, 'integration.version_diff')` needs no call-site edit.
   */
  readonly viewerTier: string | null;
}

/**
 * ⚠️ **PLACEHOLDER** — the `aeci-514`-local stand-in for
 * `hasCapability(tier, 'integration.version_diff')`, whose registry AECI-610 has
 * already shipped on the `aeci-515` branch (`@aeci/shared/entitlements` declares
 * that capability id) and whose guard AECI-611 adds. Neither is reachable from
 * this branch.
 *
 * Same discipline as `assertVerifiedVendor`
 * (`apps/api/src/routes/vendor-shared.ts`): ONE function, and — per §9.3 and
 * AECI-303's acceptance criteria — exactly **two** consult sites repo-wide, so the
 * swap is a mechanical edit rather than an audit. Those two are
 * `resolveDiffAccess` (`apps/api/src/lib/pair-version-diff.ts`, which both the
 * pair read and the timeline read route through) and the web pair resolver
 * (`apps/web/src/app/products/products-pair.resolver.ts`).
 *
 * **The `!historical` early return IS `STAGE_2_SPEC.md` §8.1(4)** — "the
 * latest-version view, and the latest conflict / single-source state, are always
 * free and full-fidelity to readers." AECI-304 must replace only the line below
 * it, never that one.
 *
 * **Cache constraint AECI-304 must confront.** Returning a constant is what keeps
 * gated pair URLs storable in the shared, URL-keyed edge cache. The moment this
 * depends on a cookie or session, a gated selection can no longer live there
 * (`STAGE_1_SPEC.md` §9.1a) — so AECI-304 must either keep the pair-page gate
 * URL-derived, mark gated selections `Cache-Control: private` (the
 * query-dependent-redirect carve-out in `CACHE_STRATEGY.md` §4a is the
 * precedent), or move the gated portion to a post-hydration fetch.
 */
export function canViewVersionDiff(request: VersionDiffRequest): VersionDiffAccess {
  if (!request.historical) return 'full';
  return 'full'; // ← AECI-304 replaces exactly this line.
}
