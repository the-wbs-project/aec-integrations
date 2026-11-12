/**
 * AECI-1619 (counsel ruling 16): the Plans snapshot files. Plain Vitest, cwd =
 * apps/web. `@angular/localize/init` installs `$localize`, so the strings are
 * the en-US sources the live page renders. `@angular/compiler` loads first
 * because `formatCurrency` comes from `@angular/common`, whose partially
 * compiled injectables need the JIT compiler outside the Angular build.
 *
 * **This spec is also the generator.** `pnpm docs:plans-snapshot` runs it with
 * `UPDATE_PLANS_SNAPSHOT=1`, which writes the current version's file before the
 * checks run. Without the variable it only checks. Writing an older version's
 * file is never allowed: an older version's text is a record.
 */
import '@angular/compiler';
import '@angular/localize/init';

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PLANS_PAGE_SHA256 } from '@aeci/shared/api/agreements';
import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../legal/legal-frontmatter';
import { NOINDEX_PATH_PREFIXES, pathForcesNoindex } from './docs-indexing';
import {
  plansActionsMarkdown,
  plansComparisonMarkdown,
  plansCtaMarkdown,
  plansSnapshotMarkdown,
} from './plans-snapshot';
import {
  PLANS_ARCHIVE_PATHS,
  PLANS_PAGE_CURRENT_VERSION,
  PLANS_PAGE_KNOWN_VERSIONS,
  PLANS_PAGE_PATH,
  PLANS_PAGE_RECORDED_ON,
  plansArchivePath,
} from './plans-versions';

const VENDORS = join(process.cwd(), 'src', 'content', 'docs', 'vendors');
const SOURCE = join(VENDORS, 'plans.md');
const SNAPSHOTS = join(VENDORS, 'versions', 'plans');
const snapshotFile = (version: string) => join(SNAPSHOTS, `v${version}.md`);

const source = readFileSync(SOURCE, 'utf8');
const rendered = plansSnapshotMarkdown(
  source,
  PLANS_PAGE_CURRENT_VERSION,
  PLANS_PAGE_RECORDED_ON[PLANS_PAGE_CURRENT_VERSION] ?? '',
);

if (process.env['UPDATE_PLANS_SNAPSHOT'] === '1') {
  writeFileSync(snapshotFile(PLANS_PAGE_CURRENT_VERSION), rendered);
}

const BUMP_HINT =
  'The Plans page changed: its copy, the cards, the comparison table, a capability or a price. ' +
  'Every change is a new version. Bump PLANS_PAGE_CURRENT_VERSION, add the version to ' +
  'PLANS_PAGE_KNOWN_VERSIONS (packages/shared/src/api/agreements.ts) and PLANS_PAGE_RECORDED_ON ' +
  '(plans-versions.ts), set plans.md frontmatter `version`, add its "## Versions" line, run ' +
  '`pnpm docs:plans-snapshot`, then put the new file hash in PLANS_PAGE_SHA256.';

describe('Plans snapshot', () => {
  it('the current version file is the page as it renders now, byte for byte', () => {
    const path = snapshotFile(PLANS_PAGE_CURRENT_VERSION);
    expect(existsSync(path), `${path} is missing. Run \`pnpm docs:plans-snapshot\`.`).toBe(true);
    expect(readFileSync(path, 'utf8'), BUMP_HINT).toBe(rendered);
  });

  it('has a file, a recorded date and a hash for every known version, and no other', () => {
    const files = readdirSync(SNAPSHOTS)
      .filter((file) => /^v[\d.]+\.md$/.test(file))
      .map((file) => file.slice(1, -3))
      .sort();
    expect(files).toEqual([...PLANS_PAGE_KNOWN_VERSIONS].sort());
    expect(Object.keys(PLANS_PAGE_RECORDED_ON).sort()).toEqual(
      [...PLANS_PAGE_KNOWN_VERSIONS].sort(),
    );
    expect(Object.keys(PLANS_PAGE_SHA256).sort()).toEqual([...PLANS_PAGE_KNOWN_VERSIONS].sort());
    expect(PLANS_PAGE_KNOWN_VERSIONS.at(-1)).toBe(PLANS_PAGE_CURRENT_VERSION);
  });

  it.each([...PLANS_PAGE_KNOWN_VERSIONS])(
    'v%s frontmatter names its version and date',
    (version) => {
      const { data } = parseFrontmatter(readFileSync(snapshotFile(version), 'utf8'));
      expect(data['version']).toBe(version);
      expect(data['recorded_on']).toBe(PLANS_PAGE_RECORDED_ON[version]);
      expect(data['title']).toBe('Plans');
    },
  );

  it('the live page carries the current version in its frontmatter', () => {
    expect(parseFrontmatter(source).data['version']).toBe(PLANS_PAGE_CURRENT_VERSION);
  });

  it.each([...PLANS_PAGE_KNOWN_VERSIONS])(
    'PLANS_PAGE_SHA256 holds the v%s file hash',
    (version) => {
      const hash = createHash('sha256')
        .update(readFileSync(snapshotFile(version)))
        .digest('hex');
      expect(PLANS_PAGE_SHA256[version]).toBe(hash);
    },
  );
});

describe('plansSnapshotMarkdown', () => {
  it('prints the widgets, drops the buttons and leaves out the Versions section', () => {
    expect(rendered).not.toContain('<!-- docs:');
    // Ruled 2026-11-11: every statement a vendor sees on the live page is in the record.
    expect(rendered).toContain(plansActionsMarkdown());
    expect(rendered).toContain(
      'For a short overview of what AEC Integrations offers vendors, see [the vendor program](/vendor-program).',
    );
    expect(rendered).toContain(plansCtaMarkdown());
    expect(rendered).toContain(
      '$25 USD a month or $250 USD a year per product. Monthly, cancel any time. Full refund within 14 days. If a plan ends, your text stays unless you ask us to remove it.',
    );
    expect(rendered).toContain('### Tell the full story of your product');
    expect(rendered).toContain('2. We review it and email you the result.');
    expect(rendered).not.toContain('Claim your listing');
    expect(rendered).not.toContain('Contact us');
    expect(rendered).not.toContain('## Versions');
    expect(rendered).toContain(plansComparisonMarkdown());
    expect(rendered).toContain('| Feature | Free | Managed |');
    expect(rendered).toContain('| Price | $0 | $25 USD a month or $250 USD a year per product |');
    expect(rendered).toContain('### Managed');
    expect(rendered).toContain('## Related');
    expect(rendered.endsWith('\n') && !rendered.endsWith('\n\n')).toBe(true);
    expect(rendered).not.toMatch(/\n{3,}/);
  });

  it('a new Versions line does not change the snapshot', () => {
    const withLine = source.replace(
      '## Versions\n',
      '## Versions\n\n- [Version 9.9](/docs/vendors/plans/v9.9): recorded never.\n',
    );
    expect(withLine).not.toBe(source);
    expect(plansSnapshotMarkdown(withLine, '1.0', 'X')).toBe(
      plansSnapshotMarkdown(source, '1.0', 'X'),
    );
  });

  it('is the same with CRLF line endings', () => {
    expect(plansSnapshotMarkdown(source.replace(/\n/g, '\r\n'), '1.0', 'X')).toBe(
      plansSnapshotMarkdown(source, '1.0', 'X'),
    );
  });

  it('throws on a widget it cannot print', () => {
    expect(() =>
      plansSnapshotMarkdown('---\ntitle: P\n---\n\n<!-- docs:mystery -->\n', '1', 'X'),
    ).toThrow(/mystery/);
  });
});

describe('Plans snapshot routes', () => {
  it('are one exact noindex path per known version, below the live page', () => {
    expect(PLANS_ARCHIVE_PATHS).toEqual(
      PLANS_PAGE_KNOWN_VERSIONS.map((v) => `/docs/vendors/plans/v${v}`),
    );
    for (const path of PLANS_ARCHIVE_PATHS) {
      expect(NOINDEX_PATH_PREFIXES).toContain(path);
      expect(pathForcesNoindex(path)).toBe(true);
    }
    expect(plansArchivePath('1.0')).toBe('/docs/vendors/plans/v1.0');
    expect(pathForcesNoindex(PLANS_PAGE_PATH)).toBe(false);
  });
});
