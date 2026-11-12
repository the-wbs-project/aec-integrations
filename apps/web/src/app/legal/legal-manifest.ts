/**
 * Legal version manifest (AECI-1361, AECI-1610). The `.md`-free half of the
 * legal registry: which superseded versions are archived at
 * `/legal/<slug>/v<version>`, which versions not yet in force are published at
 * the same kind of URL, and which version is current. The slugs, files and path
 * helpers live in `legal-slugs.ts` and are re-exported here.
 *
 * It imports nothing at runtime but `legal-slugs.ts`, so its readers can take it
 * without pulling the Markdown or `marked` into their bundles. No eager module
 * imports it, so the version lists load with the legal page, not on every page:
 *
 *   1. `legal-version-route.ts` decides, behind the one `/legal/<slug>/v<version>`
 *      route in `app.routes.ts`, whether a version is served.
 *   2. `docs/docs-indexing.ts` puts every archive, upcoming and current-version URL
 *      in `NOINDEX_PATH_PREFIXES`, so the SSR egress stamps `X-Robots-Tag` on it in
 *      every env. (The sitemap lists legal pages by hand and never lists one.)
 *   3. `legal-versions.ts` checks the bundled sources against it at module init.
 *
 * Adding an archive: copy the superseded file unchanged to
 * `src/content/legal/versions/<slug>/v<version>.md`, add its entry below, import
 * it in `legal-content.ts`, and add its line to the current file's
 * `## Change history`. The registry throws at module init if any of the four
 * disagree. An upcoming version adds its file, its import and a `LEGAL_UPCOMING`
 * entry, and never edits the current file: `LegalPage` announces it.
 * `apps/web/src/content/legal/README.md` has the full workflow.
 */
import { type LegalSlug, LEGAL_SLUGS, legalArchivePath } from './legal-slugs';

export {
  LEGAL_SLUGS,
  LEGAL_SOURCE_FILES,
  type LegalSlug,
  legalArchiveFile,
  legalArchivePath,
  legalPath,
} from './legal-slugs';

/** One superseded version, archived unchanged under `versions/<slug>/`. */
export interface LegalArchiveEntry {
  readonly slug: LegalSlug;
  readonly version: string;
  /**
   * The day the next version replaced it: the date of the commit that bumped
   * the current file's `version`. A pre-formatted display string, like the
   * frontmatter dates, so SSR and the browser render the same bytes.
   */
  readonly supersededOn: string;
}

/**
 * Every archived version. Every entry below was a draft that never took
 * effect; their `## Change history` lines say so.
 */
export const LEGAL_ARCHIVES: readonly LegalArchiveEntry[] = [
  // AECI-312 (#967) bumped the ToS to 1.1 when it filled the governing law.
  { slug: 'terms', version: '1.0', supersededOn: 'October 14, 2026' },
  // AECI-1296 (#952) bumped the Privacy Policy to 1.1 for the "About you" form.
  { slug: 'privacy', version: '1.0', supersededOn: 'October 13, 2026' },
  // AECI-1428 bumped both vendor documents to 1.1: when Managed ends, the fields
  // stay the vendor's (the 2026-10-19 ruling on AECI-1341).
  { slug: 'vendor-terms', version: '1.0', supersededOn: 'October 28, 2026' },
  { slug: 'managed-plan-agreement', version: '1.0', supersededOn: 'October 28, 2026' },
  // AECI-1363 bumped the Vendor Terms to 1.2: production held a 1.1 acceptance, so
  // counsel's held items could not change 1.1 in place (LEGAL_IMPACT_REVIEW.md §2).
  { slug: 'vendor-terms', version: '1.1', supersededOn: 'November 7, 2026' },
  // AECI-1363 bumped the Vendor Terms to 1.3 for legal branch 5: production held two
  // 1.2 acceptances (November 11, 2026), so 1.2 could not change in place.
  { slug: 'vendor-terms', version: '1.2', supersededOn: 'November 12, 2026' },
];

/** Every archive URL. Held out of the index and the sitemap. */
export const LEGAL_ARCHIVE_PATHS: readonly string[] = LEGAL_ARCHIVES.map((entry) =>
  legalArchivePath(entry.slug, entry.version),
);

/**
 * The current version of each document: the current file's frontmatter
 * `version`. Mirrored here so the routes can serve the current version at its
 * own `/legal/<slug>/v<version>` address without importing the Markdown
 * (AECI-1610). A change notice links that address. On bump day the upcoming file
 * becomes the current one and its `versions/` copy is removed, so without this
 * route the link in every notice already shown would 404 from the effective date
 * on. `buildLegalVersions` throws when an entry here disagrees with the
 * frontmatter, so the bump-day change must move both.
 */
export const LEGAL_CURRENT_VERSIONS: Readonly<Record<LegalSlug, string>> = {
  terms: '1.1',
  privacy: '1.1',
  'review-guidelines': '1.0',
  'listing-accuracy': '1.0',
  'vendor-terms': '1.3',
  'managed-plan-agreement': '1.1',
};

/**
 * The fixed address of each current version (AECI-1610). It serves the current
 * text: `noindex`, canonical to `/legal/<slug>`, out of the sitemap. Once a later
 * version supersedes it, the same URL serves the archived copy instead.
 */
export const LEGAL_CURRENT_VERSION_PATHS: readonly string[] = LEGAL_SLUGS.map((slug) =>
  legalArchivePath(slug, LEGAL_CURRENT_VERSIONS[slug]),
);

/**
 * One version not yet in force (AECI-1610, `STAGE_1_SPEC.md` §27.3). Its text is
 * committed before its effective date at `versions/<slug>/v<version>.md`, the
 * same slot an archive uses, and is served at `/legal/<slug>/v<version>`.
 *
 * Status comes from this entry, never from a frontmatter flag: the same file is
 * "upcoming" while it is listed here and "current" once the bump-day change
 * moves it to `<name>.md` and deletes the entry. The file's frontmatter
 * `effective_date` is the display label for `effectiveOn` ("Month D, YYYY");
 * `buildLegalVersions` throws when the two disagree.
 */
export interface LegalUpcomingEntry {
  readonly slug: LegalSlug;
  readonly version: string;
  /** The day it takes effect: `YYYY-MM-DD`, read as UTC. */
  readonly effectiveOn: string;
}

/**
 * Every version not yet in force. Empty until a change is announced. The vendor
 * terms and Managed plan agreement entries are mirrored in
 * `LEGAL_AGREEMENT_UPCOMING_VERSIONS` (`@aeci/shared/api/agreements`), and
 * `legal-page.component.spec.ts` pins the two equal.
 */
export const LEGAL_UPCOMING: readonly LegalUpcomingEntry[] = [];

/** The URL of each upcoming entry: `/legal/<slug>/v<version>`. */
export function legalUpcomingPaths(entries: readonly LegalUpcomingEntry[]): string[] {
  return entries.map((entry) => legalArchivePath(entry.slug, entry.version));
}

/**
 * Every URL that renders a version not yet in force (AECI-1592, AECI-1610),
 * derived from `LEGAL_UPCOMING`. Held out of the index and the sitemap, like the
 * archives. A legal notice must link to the new version, so
 * `legal-notices.spec.ts` fails on any entry in `notices.json` whose URL is not
 * listed here.
 */
export const LEGAL_UPCOMING_PATHS: readonly string[] = legalUpcomingPaths(LEGAL_UPCOMING);
