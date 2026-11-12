/**
 * The Plans snapshot files, bundled (AECI-1619). Each known Plans version's
 * snapshot (`src/content/docs/vendors/versions/plans/v<version>.md`, written by
 * `pnpm docs:plans-snapshot`) is inlined by the esbuild `text` loader, split by
 * `parseFrontmatter` and rendered by `renderDocsBody` once at module init, the
 * same way the docs manifest renders a page. `plans-archive-page.ts` shows it at
 * `/docs/vendors/plans/v<version>`.
 *
 * Adding a version: run the generator, import the new file below and add it to
 * `SOURCES`. Module init throws when a known version has no file here, or a file
 * names another version, so a gap fails `ng test` and the build.
 */
import plansV1_0Md from '../../content/docs/vendors/versions/plans/v1.0.md';
import { parseFrontmatter } from '../legal/legal-frontmatter';
import { type DocsBlock, renderDocsBody } from './docs-markdown';
import { PLANS_PAGE_KNOWN_VERSIONS } from './plans-versions';

/** One recorded Plans version, ready to render. */
export interface PlansSnapshot {
  readonly version: string;
  readonly title: string;
  /** "Month D, YYYY", from the snapshot's `recorded_on`. */
  readonly recordedOn: string;
  readonly blocks: readonly DocsBlock[];
  /** The whole body as one HTML string. Specs read it. */
  readonly html: string;
}

const SOURCES: Readonly<Record<string, string>> = {
  '1.0': plansV1_0Md,
};

function buildSnapshots(): ReadonlyMap<string, PlansSnapshot> {
  const snapshots = new Map<string, PlansSnapshot>();
  for (const version of PLANS_PAGE_KNOWN_VERSIONS) {
    const source = SOURCES[version];
    if (source === undefined) {
      throw new Error(
        `Plans version ${version} has no bundled snapshot in plans-archive-content.ts`,
      );
    }
    const { data, body } = parseFrontmatter(source);
    if (data['version'] !== version) {
      throw new Error(`Plans snapshot v${version}.md names version "${data['version']}"`);
    }
    const { blocks, html } = renderDocsBody(body);
    snapshots.set(version, {
      version,
      title: data['title'] ?? '',
      recordedOn: data['recorded_on'] ?? '',
      blocks,
      html,
    });
  }
  return snapshots;
}

const SNAPSHOTS = buildSnapshots();

/** One recorded Plans version, or `undefined` for an unknown one. */
export function getPlansSnapshot(version: string): PlansSnapshot | undefined {
  return SNAPSHOTS.get(version);
}
