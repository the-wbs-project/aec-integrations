/**
 * The Plans page's versions (AECI-1619, counsel ruling 16). The `.md`-free half of
 * the Plans snapshot set, like `legal/legal-manifest.ts` is for legal archives, so
 * the routes, the noindex list and the Billing tables can read it without pulling
 * Markdown into their bundles.
 *
 * `/docs/vendors/plans` is versioned content. Each version has a snapshot file,
 * `src/content/docs/vendors/versions/plans/v<version>.md`, rendered by
 * `plansSnapshotMarkdown` (`plans-snapshot.ts`) and written by
 * `pnpm docs:plans-snapshot`. A checkout or grant acceptance stores the version
 * and the SHA-256 of that file (`PLANS_PAGE_SHA256` in `@aeci/shared/api/agreements`).
 * Every version, the current one included, is served at `/docs/vendors/plans/v<version>`.
 */
import { PLANS_PAGE_CURRENT_VERSION, PLANS_PAGE_KNOWN_VERSIONS } from '@aeci/shared/api/agreements';

/** The live Plans page. */
export const PLANS_PAGE_PATH = '/docs/vendors/plans';

/**
 * The day each Plans version was recorded, as the snapshot's `recorded_on`
 * frontmatter and the `## Versions` line on the live page print it. A
 * pre-formatted display string, like the legal dates, so SSR and the browser
 * render the same bytes. Add the new version here when you bump
 * `PLANS_PAGE_CURRENT_VERSION`. A spec checks every known version has a date.
 */
export const PLANS_PAGE_RECORDED_ON: Readonly<Record<string, string>> = {
  '1.0': 'November 11, 2026',
};

/** One version's snapshot page: `/docs/vendors/plans/v<version>`. */
export function plansArchivePath(version: string): string {
  return `${PLANS_PAGE_PATH}/v${version}`;
}

/** Every known version's snapshot path, oldest first. All are noindex. */
export const PLANS_ARCHIVE_PATHS: readonly string[] = PLANS_PAGE_KNOWN_VERSIONS.map((version) =>
  plansArchivePath(version),
);

export { PLANS_PAGE_CURRENT_VERSION, PLANS_PAGE_KNOWN_VERSIONS };
