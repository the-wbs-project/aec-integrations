/**
 * Legal document manifest (AECI-1361). The `.md`-free half of the legal
 * registry: which slugs exist, which file backs each, and which superseded
 * versions are archived at `/legal/<slug>/v<version>`.
 *
 * It imports nothing at runtime, so three readers can take it without pulling
 * the Markdown or `marked` into their bundles:
 *
 *   1. `app.routes.ts` generates one explicit route per archived version.
 *   2. `docs/docs-indexing.ts` puts every archive URL in `NOINDEX_PATH_PREFIXES`,
 *      so the SSR egress stamps `X-Robots-Tag` on it in every env. (The sitemap
 *      lists legal pages by hand and never lists an archive.)
 *   3. `legal-versions.ts` checks the bundled sources against it at module init.
 *
 * Adding an archive: copy the superseded file unchanged to
 * `src/content/legal/versions/<slug>/v<version>.md`, add its entry below, import
 * it in `legal-content.ts`, and add its line to the current file's
 * `## Change history`. The registry throws at module init if any of the four
 * disagree. `apps/web/src/content/legal/README.md` has the full workflow.
 */

/** Public route slug for a legal page (`/legal/<slug>`). */
export type LegalSlug =
  | 'terms'
  | 'privacy'
  | 'review-guidelines'
  | 'listing-accuracy'
  | 'vendor-terms'
  | 'managed-plan-agreement';

/** slug → the long §27.1 filename under `src/content/legal/`, in canonical order. */
export const LEGAL_SOURCE_FILES: Readonly<Record<LegalSlug, string>> = {
  terms: 'terms-of-service.md',
  privacy: 'privacy-policy.md',
  'review-guidelines': 'review-guidelines.md',
  'listing-accuracy': 'listing-accuracy-policy.md',
  'vendor-terms': 'vendor-terms.md',
  'managed-plan-agreement': 'managed-plan-agreement.md',
};

/** Every legal slug, in canonical order. */
export const LEGAL_SLUGS = Object.keys(LEGAL_SOURCE_FILES) as readonly LegalSlug[];

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
 * Every archived version. Both entries below were drafts that never took
 * effect; their `## Change history` lines say so.
 */
export const LEGAL_ARCHIVES: readonly LegalArchiveEntry[] = [
  // AECI-312 (#967) bumped the ToS to 1.1 when it filled the governing law.
  { slug: 'terms', version: '1.0', supersededOn: 'October 14, 2026' },
  // AECI-1296 (#952) bumped the Privacy Policy to 1.1 for the "About you" form.
  { slug: 'privacy', version: '1.0', supersededOn: 'October 13, 2026' },
];

/** The current version's path. */
export function legalPath(slug: LegalSlug): string {
  return `/legal/${slug}`;
}

/** An archived version's path: `/legal/<slug>/v<version>`. */
export function legalArchivePath(slug: LegalSlug, version: string): string {
  return `/legal/${slug}/v${version}`;
}

/** The archive file under `src/content/legal/`: `versions/<slug>/v<version>.md`. */
export function legalArchiveFile(slug: LegalSlug, version: string): string {
  return `versions/${slug}/v${version}.md`;
}

/** Every archive URL. Held out of the index and the sitemap. */
export const LEGAL_ARCHIVE_PATHS: readonly string[] = LEGAL_ARCHIVES.map((entry) =>
  legalArchivePath(entry.slug, entry.version),
);
