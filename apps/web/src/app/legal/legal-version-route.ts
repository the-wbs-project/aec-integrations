/**
 * The `/legal/<slug>/v<version>` route (AECI-1361, AECI-1610). One route serves
 * every version that has a page: each archive, each upcoming version and each
 * current version at its own address.
 *
 * `legalVersionMatcher` is eager (it is in `app.routes.ts`) and only reads the URL
 * shape. `canMatchLegalVersion` lazy-loads this file's `servesLegalVersion`, which
 * reads the version lists from `legal-manifest.ts`, so those lists stay out of the
 * initial bundle. A version with no page fails the guard, the router falls
 * through to the `**` route, and the SSR response is a real 404 with the
 * not-found TTL, as with an unknown `/legal/*` path.
 */
import {
  LEGAL_ARCHIVES,
  LEGAL_CURRENT_VERSIONS,
  LEGAL_SLUGS,
  LEGAL_UPCOMING,
  type LegalSlug,
} from './legal-manifest';

/** Whether `/legal/<slug>/v<version>` has a page. */
export function servesLegalVersion(slug: string, version: string): boolean {
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) return false;
  const s = slug as LegalSlug;
  return (
    LEGAL_CURRENT_VERSIONS[s] === version ||
    LEGAL_ARCHIVES.some((a) => a.slug === s && a.version === version) ||
    LEGAL_UPCOMING.some((u) => u.slug === s && u.version === version)
  );
}
