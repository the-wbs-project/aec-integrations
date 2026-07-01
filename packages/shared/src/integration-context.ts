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
 * context-relative direction).
 */
import type { ContextDirection } from './api/product-pairs';
import type { IntegrationDirection } from './api/integrations';

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
