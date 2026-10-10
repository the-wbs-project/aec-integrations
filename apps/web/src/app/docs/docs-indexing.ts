/**
 * Path-driven indexing policy for the product docs (`docs/STAGE_2_PRODUCT_DOCS_SPEC.md`
 * §3, "Indexing"; AECI-1104, AECI-1248).
 *
 * The ONE list of paths held out of the index even where `ALLOW_INDEXING` is
 * `"true"`. Three readers share it, so opening a section to search engines is a
 * one-line change here:
 *
 *   1. The docs components set `<meta name="robots" content="noindex">` from it.
 *   2. The SSR egress middleware stamps `X-Robots-Tag` from it in every env
 *      (re-exported by `src/server/robots-policy.ts`).
 *   3. `sitemap.xml` leaves out every path it covers (`indexableDocsPaths`).
 *
 * It lives under `src/app/` and imports nothing, so both the browser bundle and
 * the server can import it without pulling server-only code into the app.
 */

/**
 * Path prefixes held out of the index in every env. A prefix covers the path
 * itself and everything below it: `/docs/vendors` matches `/docs/vendors` (the
 * section index) and `/docs/vendors/your-seat`, but not `/docs/vendorsx`.
 *
 * The vendor guide describes a portal that is still a dark launch, so it stays
 * unindexed until vendors are seated.
 *
 * TODO(AECI-1253): remove `/docs/vendors` when the vendor guide is published
 * (the same sitting as AECI-1105).
 */
export const NOINDEX_PATH_PREFIXES: readonly string[] = ['/docs/vendors'];

/** Whether a locale-stripped pathname is held out of the index in every env. */
export function pathForcesNoindex(path: string): boolean {
  return NOINDEX_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
