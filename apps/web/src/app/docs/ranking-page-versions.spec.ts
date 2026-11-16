/**
 * AECI-1621 (counsel Q23): the bump guard for `/docs/trust/how-ranking-works`.
 * Plain Vitest, cwd = apps/web.
 *
 * The Terms of Service and the Vendor Terms link the page, so every change to
 * it is a new dated version. The current version's file must be the live page
 * as it stands: its body with the `## Versions` section left out, under a
 * `title` / `version` / `recorded_on` frontmatter. So any edit to the page
 * fails here until the version is bumped. No hash: no acceptance stores it.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../legal/legal-frontmatter';
import { DOCS_ARCHIVE_PATHS, DOCS_PAGE_VERSIONS } from './docs-page-versions';
import { NOINDEX_PATH_PREFIXES, pathForcesNoindex } from './docs-indexing';
import {
  RANKING_ARCHIVE_PATHS,
  RANKING_PAGE_CURRENT_VERSION,
  RANKING_PAGE_KNOWN_VERSIONS,
  RANKING_PAGE_PATH,
  RANKING_PAGE_RECORDED_ON,
  rankingArchivePath,
} from './ranking-page-versions';

const TRUST = join(process.cwd(), 'src', 'content', 'docs', 'trust');
const SOURCE = join(TRUST, 'how-ranking-works.md');
const VERSIONS = join(TRUST, 'versions', 'how-ranking-works');
const versionFile = (version: string) => join(VERSIONS, `v${version}.md`);

const FRONTMATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

/**
 * The version file the live page implies: the page with its frontmatter
 * replaced and its `## Versions` section (heading to the next `##`) removed.
 */
function rankingVersionMarkdown(source: string, version: string, recordedOn: string): string {
  const text = source.replace(/\r\n/g, '\n');
  const fence = text.match(FRONTMATTER_RE);
  const title = parseFrontmatter(text).data['title'] ?? '';
  const rest = fence ? text.slice(fence[0].length) : text;
  const withoutVersions = rest.replace(/^## Versions\n[\s\S]*?(?=^## )/m, '');
  return `---\ntitle: ${title}\nversion: ${version}\nrecorded_on: ${recordedOn}\n---\n${withoutVersions}`;
}

const source = readFileSync(SOURCE, 'utf8');
const expected = rankingVersionMarkdown(
  source,
  RANKING_PAGE_CURRENT_VERSION,
  RANKING_PAGE_RECORDED_ON[RANKING_PAGE_CURRENT_VERSION] ?? '',
);

const BUMP_HINT =
  'How ranking works changed. The Terms link it, so every change is a new version ' +
  '(apps/web/src/content/README.md, "Versioned pages"). Bump RANKING_PAGE_CURRENT_VERSION, add ' +
  'it to RANKING_PAGE_KNOWN_VERSIONS and RANKING_PAGE_RECORDED_ON (ranking-page-versions.ts), ' +
  'set how-ranking-works.md frontmatter `version`, add its "## Versions" line, write ' +
  'versions/how-ranking-works/v<version>.md as the page without its Versions section, and add ' +
  'the file to SOURCES in docs-archive-content.ts. Never edit an older version file.';

describe('How ranking works versions', () => {
  it('the current version file is the live page without its Versions section, byte for byte', () => {
    const path = versionFile(RANKING_PAGE_CURRENT_VERSION);
    expect(existsSync(path), `${path} is missing. ${BUMP_HINT}`).toBe(true);
    expect(readFileSync(path, 'utf8'), BUMP_HINT).toBe(expected);
  });

  it('has a file and a recorded date for every known version, and no other', () => {
    const files = readdirSync(VERSIONS)
      .filter((file) => /^v[\d.]+\.md$/.test(file))
      .map((file) => file.slice(1, -3))
      .sort();
    expect(files).toEqual([...RANKING_PAGE_KNOWN_VERSIONS].sort());
    expect(Object.keys(RANKING_PAGE_RECORDED_ON).sort()).toEqual(
      [...RANKING_PAGE_KNOWN_VERSIONS].sort(),
    );
    expect(RANKING_PAGE_KNOWN_VERSIONS.at(-1)).toBe(RANKING_PAGE_CURRENT_VERSION);
  });

  it.each([...RANKING_PAGE_KNOWN_VERSIONS])(
    'v%s frontmatter names its version, date and title',
    (version) => {
      const { data } = parseFrontmatter(readFileSync(versionFile(version), 'utf8'));
      expect(data['version']).toBe(version);
      expect(data['recorded_on']).toBe(RANKING_PAGE_RECORDED_ON[version]);
      expect(data['title']).toBe('How ranking works');
    },
  );

  it('the live page carries the current version and keeps the anchors other pages link', () => {
    expect(parseFrontmatter(source).data['version']).toBe(RANKING_PAGE_CURRENT_VERSION);
    // e2e/docs.spec.ts pins the footer link to #what-does-not-count.
    expect(source).toContain('\n## What does not count\n');
  });

  it('is registered as a versioned docs page', () => {
    expect(DOCS_PAGE_VERSIONS['trust/how-ranking-works']).toEqual({
      current: RANKING_PAGE_CURRENT_VERSION,
      known: RANKING_PAGE_KNOWN_VERSIONS,
      recordedOn: RANKING_PAGE_RECORDED_ON,
    });
  });
});

describe('rankingVersionMarkdown', () => {
  it('a new Versions line does not change the version file', () => {
    const withLine = source.replace(
      '## Versions\n',
      '## Versions\n\n- [Version 9.9](/docs/trust/how-ranking-works/v9.9): recorded never.\n',
    );
    expect(withLine).not.toBe(source);
    expect(rankingVersionMarkdown(withLine, '1.0', 'X')).toBe(
      rankingVersionMarkdown(source, '1.0', 'X'),
    );
  });

  it('an edit to the body does change it', () => {
    const edited = source.replace('Ratings. They decide', 'Ratings. They only decide');
    expect(edited).not.toBe(source);
    expect(rankingVersionMarkdown(edited, '1.0', 'X')).not.toBe(
      rankingVersionMarkdown(source, '1.0', 'X'),
    );
  });

  it('leaves the Versions section out and keeps Related', () => {
    expect(expected).not.toContain('## Versions');
    expect(expected).toContain('## What does not count');
    expect(expected).toContain('\n## Related\n');
    expect(expected).not.toMatch(/\n{3,}/);
  });

  it('is the same with CRLF line endings', () => {
    expect(rankingVersionMarkdown(source.replace(/\n/g, '\r\n'), '1.0', 'X')).toBe(
      rankingVersionMarkdown(source, '1.0', 'X'),
    );
  });
});

describe('How ranking works archive routes', () => {
  it('are one exact noindex path per known version, below the live page', () => {
    expect(RANKING_ARCHIVE_PATHS).toEqual(
      RANKING_PAGE_KNOWN_VERSIONS.map((v) => `/docs/trust/how-ranking-works/v${v}`),
    );
    for (const path of RANKING_ARCHIVE_PATHS) {
      expect(DOCS_ARCHIVE_PATHS).toContain(path);
      expect(NOINDEX_PATH_PREFIXES).toContain(path);
      expect(pathForcesNoindex(path)).toBe(true);
    }
    expect(rankingArchivePath('1.0')).toBe('/docs/trust/how-ranking-works/v1.0');
    expect(pathForcesNoindex(RANKING_PAGE_PATH)).toBe(false);
  });
});
