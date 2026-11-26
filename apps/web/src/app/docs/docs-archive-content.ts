/**
 * The recorded versions of every versioned docs page, bundled (AECI-1619,
 * AECI-1621). Each known version's file is inlined by the esbuild `text` loader,
 * split by `parseFrontmatter` and rendered by `renderDocsBody` once at module
 * init, the same way the docs manifest renders a page. `docs-archive-page.ts`
 * shows it at `/docs/<section>/<slug>/v<version>`.
 *
 *   - Plans: `src/content/docs/vendors/versions/plans/v<version>.md`, a rendered
 *     snapshot written by `pnpm docs:plans-snapshot` (`plans-snapshot.ts`).
 *   - How ranking works: `src/content/docs/trust/versions/how-ranking-works/v<version>.md`,
 *     a copy of the page's body without its `## Versions` section.
 *
 * Adding a version: write its file, import it below and add it to `SOURCES`
 * under its page. Module init throws when a known version in
 * `DOCS_PAGE_VERSIONS` has no file here, a file names another version or
 * date, or `SOURCES` holds a page or version the registry does not, so a gap fails
 * `ng test` and the build.
 */
import rankingV1_0Md from '../../content/docs/trust/versions/how-ranking-works/v1.0.md';
import rankingV1_1Md from '../../content/docs/trust/versions/how-ranking-works/v1.1.md';
import rankingV1_2Md from '../../content/docs/trust/versions/how-ranking-works/v1.2.md';
import plansV1_0Md from '../../content/docs/vendors/versions/plans/v1.0.md';
import plansV1_1Md from '../../content/docs/vendors/versions/plans/v1.1.md';
import plansV1_2Md from '../../content/docs/vendors/versions/plans/v1.2.md';
import plansV1_3Md from '../../content/docs/vendors/versions/plans/v1.3.md';
import plansV1_4Md from '../../content/docs/vendors/versions/plans/v1.4.md';
import plansV1_5Md from '../../content/docs/vendors/versions/plans/v1.5.md';
import plansV1_6Md from '../../content/docs/vendors/versions/plans/v1.6.md';
import { parseFrontmatter } from '../legal/legal-frontmatter';
import { type DocsBlock, renderDocsBody } from './docs-markdown';
import { DOCS_PAGE_VERSIONS, type DocsPageVersions } from './docs-page-versions';

/** One recorded version of a versioned docs page, ready to render. */
export interface DocsSnapshot {
  /** The page key in `DOCS_PAGE_VERSIONS`, `<section>/<slug>`. */
  readonly page: string;
  readonly version: string;
  readonly title: string;
  /** "Month D, YYYY", from the file's `recorded_on`. */
  readonly recordedOn: string;
  readonly blocks: readonly DocsBlock[];
  /** The whole body as one HTML string. Specs read it. */
  readonly html: string;
}

/** Each page's version files, by page key then version. */
const SOURCES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'vendors/plans': {
    '1.0': plansV1_0Md,
    '1.1': plansV1_1Md,
    '1.2': plansV1_2Md,
    '1.3': plansV1_3Md,
    '1.4': plansV1_4Md,
    '1.5': plansV1_5Md,
    '1.6': plansV1_6Md,
  },
  'trust/how-ranking-works': {
    '1.0': rankingV1_0Md,
    '1.1': rankingV1_1Md,
    '1.2': rankingV1_2Md,
  },
};

const key = (page: string, version: string): string => `${page}@${version}`;

/** Builds every snapshot. Exported so a spec can feed a fixture registry. */
export function buildDocsSnapshots(
  registry: Readonly<Record<string, DocsPageVersions>>,
  sources: Readonly<Record<string, Readonly<Record<string, string>>>>,
): ReadonlyMap<string, DocsSnapshot> {
  const snapshots = new Map<string, DocsSnapshot>();
  for (const page of Object.keys(sources)) {
    const versions = registry[page];
    if (!versions) {
      throw new Error(`Docs archive has files for "${page}", which is not in DOCS_PAGE_VERSIONS`);
    }
    for (const version of Object.keys(sources[page])) {
      if (!versions.known.includes(version)) {
        throw new Error(`Docs archive has a file for "${page}" ${version}, not a known version`);
      }
    }
  }
  for (const [page, versions] of Object.entries(registry)) {
    for (const version of versions.known) {
      const source = sources[page]?.[version];
      if (source === undefined) {
        throw new Error(
          `Docs page "${page}" version ${version} has no bundled file in docs-archive-content.ts`,
        );
      }
      const { data, body } = parseFrontmatter(source);
      if (data['version'] !== version) {
        throw new Error(`Docs page "${page}" v${version}.md names version "${data['version']}"`);
      }
      if (data['recorded_on'] !== versions.recordedOn[version]) {
        throw new Error(
          `Docs page "${page}" v${version}.md is recorded on "${data['recorded_on']}", not "${versions.recordedOn[version]}"`,
        );
      }
      const { blocks, html } = renderDocsBody(body);
      snapshots.set(key(page, version), {
        page,
        version,
        title: data['title'] ?? '',
        recordedOn: data['recorded_on'] ?? '',
        blocks,
        html,
      });
    }
  }
  return snapshots;
}

const SNAPSHOTS = buildDocsSnapshots(DOCS_PAGE_VERSIONS, SOURCES);

/** One recorded version of a versioned page, or `undefined` for an unknown one. */
export function getDocsSnapshot(page: string, version: string): DocsSnapshot | undefined {
  return SNAPSHOTS.get(key(page, version));
}
