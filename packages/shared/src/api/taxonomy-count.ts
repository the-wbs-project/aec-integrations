/**
 * The taxonomy term count reader, with no Zod import (AECI-2033).
 *
 * It lived in `taxonomy.ts`, which builds Zod schemas at the top level. The
 * `/categories`, `/audiences`, `/phases` and `/trades` index pages call it, and
 * one import of it kept that module, its schemas and the whole of zod on those
 * pages. Keep this file free of `zod` and `api/*` schema imports
 * (`eslint.config.mjs`), and never re-export it from a schema module.
 */

/**
 * A term's integration count, or 0 when the payload predates the field.
 *
 * The one place the absent case is decided. Sorting a term list by integrations
 * (the taxonomy index toggle) needs a total order over a field that may be
 * missing, and treating "not carried" as 0 keeps such a term at the bottom of a
 * descending sort — the same place a genuinely unintegrated term lands, which is
 * the honest reading for a payload that never measured it.
 */
export function taxonomyIntegrationCount(term: { integration_count?: number | undefined }): number {
  return term.integration_count ?? 0;
}
