/**
 * The How ranking works page's versions (AECI-1621, counsel Q23). The Terms of
 * Service and the Vendor Terms link `/docs/trust/how-ranking-works`, so a change
 * to it is a dated version with an archive, like the Plans page (AECI-1619).
 *
 * Web-only, unlike Plans: no acceptance stores this page's version, so it has no
 * hash and no constant in `@aeci/shared`. `.md`-free, so the routes and the
 * noindex list can read it without pulling Markdown into their bundles.
 *
 * Each version has a file, `src/content/docs/trust/versions/how-ranking-works/v<version>.md`:
 * the live page's body with its `## Versions` section left out, under a
 * `title` / `version` / `recorded_on` frontmatter. The page is plain Markdown,
 * so the file is a copy, not a rendered snapshot. `ranking-page-versions.spec.ts`
 * fails when the live page and the current version's file differ. Every version,
 * the current one included, is served at `/docs/trust/how-ranking-works/v<version>`.
 */

/** The live ranking page. */
export const RANKING_PAGE_PATH = '/docs/trust/how-ranking-works';

/** The version the live page shows. The last of `RANKING_PAGE_KNOWN_VERSIONS`. */
export const RANKING_PAGE_CURRENT_VERSION = '1.2';

/** Every recorded version, oldest first. */
export const RANKING_PAGE_KNOWN_VERSIONS: readonly string[] = ['1.0', '1.1', '1.2'];

/**
 * The day each version was recorded, as its file's `recorded_on` and the live
 * page's `## Versions` line print it. A pre-formatted display string, like the
 * Plans dates, so SSR and the browser render the same bytes.
 */
export const RANKING_PAGE_RECORDED_ON: Readonly<Record<string, string>> = {
  '1.0': 'November 16, 2026',
  '1.1': 'November 18, 2026',
  // AECI-1894: Chris set 1.2's recorded date to November 30, 2026 on 2026-11-28. It is the
  // day the redesign is promoted to production. If that day moves, change it in four places
  // together: this entry, the live page's frontmatter `last_updated` and its
  // `## Versions` line (docs/trust/how-ranking-works.md), and the archive copy's
  // `recorded_on` (docs/trust/versions/how-ranking-works/v1.2.md). 1.2 stays provisional
  // in ranking-page-versions.spec.ts (no hash) until Chris approves the final text.
  '1.2': 'November 30, 2026',
};

/** One version's archive page: `/docs/trust/how-ranking-works/v<version>`. */
export function rankingArchivePath(version: string): string {
  return `${RANKING_PAGE_PATH}/v${version}`;
}

/** Every known version's archive path, oldest first. All are noindex. */
export const RANKING_ARCHIVE_PATHS: readonly string[] = RANKING_PAGE_KNOWN_VERSIONS.map((version) =>
  rankingArchivePath(version),
);
