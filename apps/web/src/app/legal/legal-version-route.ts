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
 *
 * The set does not change when an upcoming version comes into force (AECI-1689): its
 * address was already served, and the old current version's address keeps serving it,
 * now as superseded. The bump moves each into the other list, so the set is the same.
 */
import {
  LEGAL_ARCHIVES,
  LEGAL_CURRENT_VERSIONS,
  LEGAL_SLUGS,
  LEGAL_UPCOMING,
  type LegalArchiveEntry,
  type LegalSlug,
  type LegalUpcomingEntry,
} from './legal-manifest';

/** The three lists the guard reads. Injected by `legal-bump-equivalence.spec.ts`. */
export interface LegalVersionLists {
  readonly archives: readonly LegalArchiveEntry[];
  readonly current: Readonly<Record<LegalSlug, string>>;
  readonly upcoming: readonly LegalUpcomingEntry[];
}

const MANIFEST: LegalVersionLists = {
  archives: LEGAL_ARCHIVES,
  current: LEGAL_CURRENT_VERSIONS,
  upcoming: LEGAL_UPCOMING,
};

/** Whether `/legal/<slug>/v<version>` has a page. */
export function servesLegalVersion(
  slug: string,
  version: string,
  lists: LegalVersionLists = MANIFEST,
): boolean {
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) return false;
  const s = slug as LegalSlug;
  return (
    lists.current[s] === version ||
    lists.archives.some((a) => a.slug === s && a.version === version) ||
    lists.upcoming.some((u) => u.slug === s && u.version === version)
  );
}
