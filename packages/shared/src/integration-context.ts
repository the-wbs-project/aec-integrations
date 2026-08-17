/**
 * Integration-pair context + direction helpers (Stage 1.5 §7.1 — AECI-294).
 *
 * The pair page is a *query-time* grouping of the two products an integration
 * connects, served from `/products/:contextSlug/integrations/:otherSlug`. One
 * unordered pair has two possible URLs (viewed from either product); this module
 * is the single place that decides the **canonical** one and translates a
 * mechanism's stored direction into the context product's frame.
 *
 * Pure + stateless so SSR, the 301 redirect, the sitemap, and the API mapper all
 * agree byte-for-byte. Slugs are already lowercased/ASCII-folded by `slug.ts`, so
 * plain string comparison is a stable total order.
 *
 * Spec: `docs/STAGE_1_5_SPEC.md` §7.1 (context + routing), §3.2 (stored vs
 * context-relative direction); `docs/STAGE_2_ATTESTATIONS_SPEC.md` §4 (the
 * refuted-claim carve-out + attestor framing).
 */
import { type AgreementAttestation, isClaimRefuted } from './agreement';
import type { ContextDirection, IntegrationDirection } from './api/integrations';
import type { AttestationSource, ClaimDirection } from './api/promote';

/**
 * The canonical **context product** for a pair's default URL: the
 * alphabetically-first of the two slugs. Deterministic and symmetric —
 * `defaultIntegrationContext(a, b) === defaultIntegrationContext(b, a)` — so the
 * 301, the canonical `<link>`, and the sitemap always resolve one pair to one
 * indexable URL. (A pair of equal slugs is a caller error rejected upstream; we
 * still return a stable value.)
 */
export function defaultIntegrationContext(a: string, b: string): string {
  return a <= b ? a : b;
}

/**
 * The two slugs of a pair in canonical `[min, max]` order — the basis for the
 * orientation-independent `pair:{min}__{max}` cache tag and the sitemap dedupe
 * key, so both URL orientations map to the same tag / entry.
 */
export function orderedPairSlugs(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Translate a mechanism's **stored** integration direction into the page's
 * context frame (§3.2, applied at the integration-row level for Layer A).
 * Direction is stored on the row as `one-way` (flows from its `source` to its
 * `target`) or `bidirectional`; the pair page is viewed *from* a context
 * product, so:
 *
 * - `bidirectional` → `both` (regardless of which endpoint is the context).
 * - `one-way` → `outbound` when the context product is the row's **source**
 *   (data leaves the context product), else `inbound`.
 * - `null` (unknown stored direction — the column is nullable) → `null`.
 *
 * `contextIsSource` is whether the page's context product is the integration's
 * `source_product_id`. Pure — the stored value is never rewritten.
 */
export function integrationDirectionForContext(
  direction: IntegrationDirection | null,
  contextIsSource: boolean,
): ContextDirection | null {
  if (direction === null) return null;
  if (direction === 'bidirectional') return 'both';
  return contextIsSource ? 'outbound' : 'inbound';
}

/**
 * Translate a **claim's** stored direction into the page's context frame (§3.2,
 * applied at the `data_object` level for Layer B — §8). Claim direction is
 * stored relative to the integration row's own endpoints as `a_to_b` (flows
 * from endpoint A = the row's `source` to endpoint B = its `target`), `b_to_a`,
 * or `both`; the pair page is viewed *from* a context product, so:
 *
 * - `both` → `both` (regardless of which endpoint is the context).
 * - `a_to_b` → `outbound` when the context product is endpoint **A** (the row's
 *   `source`) — data leaves the context — else `inbound`; `b_to_a` is the mirror.
 *
 * The sibling of `integrationDirectionForContext`, differing only in the stored
 * vocabulary (claim `a_to_b`/`b_to_a`/`both` vs mechanism `one-way`/
 * `bidirectional`). `contextIsSource` is whether the page's context product is
 * the integration's `source_product_id` (endpoint A). Pure — the stored value is
 * never rewritten.
 */
export function claimDirectionForContext(
  direction: ClaimDirection,
  contextIsSource: boolean,
): ContextDirection {
  if (direction === 'both') return 'both';
  return (direction === 'a_to_b') === contextIsSource ? 'outbound' : 'inbound';
}

/**
 * The **inverse** of `claimDirectionForContext` — fold a caller-relative
 * direction back into the canonical form stored on `claims.direction`
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §5.2).
 *
 * Every read path so far only needed the outward translation, because the DB was
 * the only author. The vendor authoring API (AECI-301) is the first *writer*
 * that speaks the context frame: its UI says "inbound"/"outbound" and the DB
 * never does, so something has to translate at the API boundary. It lives here,
 * beside its inverse, because this module is the single home for direction
 * framing — the two surfaces drifted once already (`STAGE_1_5_SPEC.md` §7.1) and
 * a second implementation somewhere in `routes/` is how that happens again.
 *
 * `contextIsSource` is whether the caller's frame is the integration's
 * `source_product_id` (endpoint A). Exactly invertible: for every
 * `(direction, contextIsSource)`,
 * `claimDirectionFromContext(claimDirectionForContext(d, c), c) === d`.
 */
export function claimDirectionFromContext(
  direction: ContextDirection,
  contextIsSource: boolean,
): ClaimDirection {
  if (direction === 'both') return 'both';
  return (direction === 'outbound') === contextIsSource ? 'a_to_b' : 'b_to_a';
}

/**
 * Aggregate a mechanism's `data_object` claim directions (each stored relative to
 * the row's source/target — §3.2) into ONE context-relative direction: any
 * `both` claim, or any pair of opposing flows across claims, reads `both`;
 * otherwise the single shared direction. `null` when the mechanism has no claims
 * — the caller then falls back to the stored row direction. `contextIsSource` is
 * whether the page's context product is the integration's `source` (endpoint A).
 */
export function contextDirectionFromClaims(
  claimDirections: readonly ClaimDirection[],
  contextIsSource: boolean,
): ContextDirection | null {
  let outbound = false;
  let inbound = false;
  for (const claim of claimDirections) {
    const framed = claimDirectionForContext(claim, contextIsSource);
    if (framed === 'both') return 'both';
    if (framed === 'outbound') outbound = true;
    else inbound = true;
    if (outbound && inbound) return 'both';
  }
  if (!outbound && !inbound) return null;
  return outbound ? 'outbound' : 'inbound';
}

/**
 * Which party a claim's attestation speaks for, **relative to the page's
 * context product** (`STAGE_2_ATTESTATIONS_SPEC.md` §4.3). The attestation slot
 * is stored against the integration row's endpoints — `vendor_a` = endpoint A =
 * the row's `source_product`, `vendor_b` = endpoint B — so the same mirror that
 * frames direction also frames attribution:
 *
 * - `aeci` → `'aeci'` (the seed; never a party to the vote).
 * - `vendor_a` → `'context'` when the context product is endpoint A, else `'other'`;
 *   `vendor_b` is the mirror.
 *
 * Resolving this server-side is what lets the pair page render "Confirmed by
 * {vendor}" from the two `ProductListItem.vendor` links it already hydrates —
 * no join to `vendors` through `attested_by_vendor_id`, and no client-side
 * re-derivation of which endpoint is which.
 */
export function attestorForContext(
  source: AttestationSource,
  contextIsSource: boolean,
): 'aeci' | 'context' | 'other' {
  if (source === 'aeci') return 'aeci';
  return (source === 'vendor_a') === contextIsSource ? 'context' : 'other';
}

/** A mechanism's claim as `effectiveContextDirection` reads it: the stored
 *  direction plus the attestation set that decides whether it still counts. */
export interface DirectionalClaim {
  readonly direction: ClaimDirection;
  readonly attestations: readonly AgreementAttestation[];
}

/**
 * The **effective** context-relative direction for the product-detail
 * integrations table (§3.2). Claims are the more specific, richer signal — and
 * the one the pair page surfaces — so when the mechanism carries any, their
 * aggregate wins; otherwise fall back to the row's own stored
 * `one-way`/`bidirectional` translated to the context frame. `null` only when
 * there is neither claim nor stored direction (an honest "unknown", rendered as
 * an em-dash). Precomputing this here — the single home for direction framing —
 * keeps the table and the pair page from drifting.
 *
 * **Refuted claims are excluded** (`STAGE_2_ATTESTATIONS_SPEC.md` §4.3): once
 * every vendor that voted says a flow does not exist, it must stop steering the
 * table's arrow, or the table would keep claiming a direction the pair page has
 * already struck through. A `conflict` claim still counts — the vendors dispute
 * it, they have not withdrawn it. Filtering here rather than at the call site is
 * deliberate: this module is the single home for direction framing, and the two
 * surfaces drifted once already (§7.1).
 */
export function effectiveContextDirection(
  storedDirection: IntegrationDirection | null,
  claims: readonly DirectionalClaim[],
  contextIsSource: boolean,
): ContextDirection | null {
  const live = claims.filter((c) => !isClaimRefuted(c.attestations)).map((c) => c.direction);
  return (
    contextDirectionFromClaims(live, contextIsSource) ??
    integrationDirectionForContext(storedDirection, contextIsSource)
  );
}
