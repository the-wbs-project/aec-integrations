/**
 * The versioned docs pages (AECI-1619, AECI-1621): one registry the manifest
 * check, the archive routes, the archive content and the noindex list all read.
 * `.md`-free, so `docs-indexing.ts` (bundled into the server egress) can import
 * it without pulling Markdown in.
 *
 *   - `vendors/plans`: a checkout or grant acceptance records its version
 *     (counsel ruling 16). Its versions live in `@aeci/shared`, with a hash.
 *   - `trust/how-ranking-works`: the Terms of Service and the Vendor Terms link
 *     it (counsel Q23). Web-only, no hash.
 *
 * Each page's versions are served at `/docs/<key>/v<version>` by
 * `docs-archive-page.ts`, from the files bundled in `docs-archive-content.ts`.
 */
import {
  PLANS_PAGE_CURRENT_VERSION,
  PLANS_PAGE_KNOWN_VERSIONS,
  PLANS_PAGE_RECORDED_ON,
} from './plans-versions';
import {
  RANKING_PAGE_CURRENT_VERSION,
  RANKING_PAGE_KNOWN_VERSIONS,
  RANKING_PAGE_RECORDED_ON,
} from './ranking-page-versions';

/** A docs page served as dated versions (AECI-1619). */
export interface DocsPageVersions {
  readonly current: string;
  /** Oldest first. The current one is last. */
  readonly known: readonly string[];
  /** version → "Month D, YYYY", the date its `## Versions` line gives. */
  readonly recordedOn: Readonly<Record<string, string>>;
}

/** Versioned docs pages, keyed `<section>/<slug>`. Archive routes are generated in this order. */
export const DOCS_PAGE_VERSIONS: Readonly<Record<string, DocsPageVersions>> = {
  'vendors/plans': {
    current: PLANS_PAGE_CURRENT_VERSION,
    known: PLANS_PAGE_KNOWN_VERSIONS,
    recordedOn: PLANS_PAGE_RECORDED_ON,
  },
  'trust/how-ranking-works': {
    current: RANKING_PAGE_CURRENT_VERSION,
    known: RANKING_PAGE_KNOWN_VERSIONS,
    recordedOn: RANKING_PAGE_RECORDED_ON,
  },
};

/** The live page of a versioned page key: `/docs/<section>/<slug>`. */
export function docsVersionedPagePath(page: string): string {
  return `/docs/${page}`;
}

/** One recorded version's archive page: `/docs/<section>/<slug>/v<version>`. */
export function docsArchivePath(page: string, version: string): string {
  return `${docsVersionedPagePath(page)}/v${version}`;
}

/** One archive route's address and the page and version it serves. */
export interface DocsArchiveEntry {
  readonly page: string;
  readonly version: string;
  readonly path: string;
}

/** Every recorded version of every versioned page, in registry order, oldest first. */
export const DOCS_ARCHIVES: readonly DocsArchiveEntry[] = Object.entries(
  DOCS_PAGE_VERSIONS,
).flatMap(([page, versions]) =>
  versions.known.map((version) => ({ page, version, path: docsArchivePath(page, version) })),
);

/** Every archive path. All are noindex, and none is in the sitemap or the docs search. */
export const DOCS_ARCHIVE_PATHS: readonly string[] = DOCS_ARCHIVES.map((entry) => entry.path);
