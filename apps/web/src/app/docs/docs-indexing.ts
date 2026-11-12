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
 * It lives under `src/app/` and imports only the `.md`-free legal manifest and
 * Plans version list, so both the browser bundle and the server can import it
 * without pulling server-only code or Markdown into either.
 */
import {
  LEGAL_ARCHIVE_PATHS,
  LEGAL_CURRENT_VERSION_PATHS,
  LEGAL_UPCOMING_PATHS,
} from '../legal/legal-manifest';
import { PLANS_ARCHIVE_PATHS } from './plans-versions';

/**
 * Path prefixes held out of the index in every env. A prefix covers the path
 * itself and everything below it: a `/docs/x` entry would match `/docs/x` (a
 * section index) and `/docs/x/page`, but not `/docs/xy`.
 *
 * No docs path since AECI-1253 (Chris, 2026-10-12): every help page and the
 * whole vendor guide are indexable and in the sitemap. The vendor guide held
 * `/docs/vendors` here from AECI-1104 until then. The list and its three
 * readers stay, so holding a section out again is a one-line change.
 *
 * AECI-1361 adds every archived legal version (`/legal/<slug>/v<version>`),
 * generated from `LEGAL_ARCHIVES`. Each entry is the exact archive path, so
 * `/legal/terms` and `/legal/vendor-terms` stay indexable. The legal page sets
 * its own robots meta, and the sitemap lists legal pages by hand, so only the
 * egress `X-Robots-Tag` stamp reads these entries.
 *
 * AECI-1610 adds every legal version not yet in force (`LEGAL_UPCOMING_PATHS`)
 * and the own address of every current version (`LEGAL_CURRENT_VERSION_PATHS`),
 * on the same terms. So a version's `/v<version>` URL stays out of the index from
 * its publication, through its time as the current version, to its archive.
 *
 * AECI-1619 adds every Plans snapshot page (`/docs/vendors/plans/v<version>`,
 * `PLANS_ARCHIVE_PATHS`), the current version's included: each canonicalises to
 * `/docs/vendors/plans`. Exact paths, so the live Plans page stays indexable.
 * The snapshot pages are not in the docs manifest, so the sitemap and the docs
 * search push never list them either.
 */
export const NOINDEX_PATH_PREFIXES: readonly string[] = [
  ...LEGAL_ARCHIVE_PATHS,
  ...LEGAL_UPCOMING_PATHS,
  ...LEGAL_CURRENT_VERSION_PATHS,
  ...PLANS_ARCHIVE_PATHS,
];

/**
 * Whether a locale-stripped pathname is held out of the index in every env.
 * `prefixes` defaults to the live list. Tests pass their own to pin the
 * whole-segment matching, because the live list holds no docs path.
 */
export function pathForcesNoindex(
  path: string,
  prefixes: readonly string[] = NOINDEX_PATH_PREFIXES,
): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
