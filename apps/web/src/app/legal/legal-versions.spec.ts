/**
 * AECI-1361 — the legal version map builder. Two halves:
 *
 *   1. The real files on disk: the manifest matches `content/legal/versions/`,
 *      and the real sources build cleanly (the same check `legal-content.ts`
 *      runs at module init under `ng test` and in the Worker).
 *   2. Synthetic sources pin each throw.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  LEGAL_ARCHIVES,
  LEGAL_ARCHIVE_PATHS,
  LEGAL_SLUGS,
  LEGAL_SOURCE_FILES,
  type LegalArchiveEntry,
  legalArchiveFile,
} from './legal-manifest';
import { type LegalVersionSources, buildLegalVersions, changeHistoryItems } from './legal-versions';

const CONTENT_DIR = fileURLToPath(new URL('../../content/legal', import.meta.url));

function read(file: string): string {
  return readFileSync(join(CONTENT_DIR, file), 'utf8');
}

function diskArchiveFiles(): string[] {
  const root = join(CONTENT_DIR, 'versions');
  return readdirSync(root).flatMap((slug) =>
    readdirSync(join(root, slug)).map((file) => `versions/${slug}/${file}`),
  );
}

function realSources(): LegalVersionSources {
  return {
    current: Object.fromEntries(LEGAL_SLUGS.map((slug) => [slug, read(LEGAL_SOURCE_FILES[slug])])),
    archives: Object.fromEntries(diskArchiveFiles().map((file) => [file, read(file)])),
    manifest: LEGAL_ARCHIVES,
  };
}

describe('the real legal sources (AECI-1361)', () => {
  it('every archive file on disk has a manifest entry, and every entry has a file', () => {
    expect(diskArchiveFiles().sort()).toEqual(
      LEGAL_ARCHIVES.map((a) => legalArchiveFile(a.slug, a.version)).sort(),
    );
  });

  it('builds: the four versioned documents are at 1.1 with 1.0 archived; the two policies have no archive', () => {
    const map = buildLegalVersions(realSources());
    expect(map.get('terms')!.current.version).toBe('1.1');
    expect(map.get('terms')!.versions.get('1.0')!.supersededOn).toBe('October 14, 2026');
    expect(map.get('privacy')!.current.version).toBe('1.1');
    expect(map.get('privacy')!.versions.get('1.0')!.supersededOn).toBe('October 13, 2026');
    // AECI-1428: when Managed ends, the fields stay the vendor's.
    expect(map.get('vendor-terms')!.current.version).toBe('1.1');
    expect(map.get('vendor-terms')!.versions.get('1.0')!.supersededOn).toBe('October 28, 2026');
    expect(map.get('managed-plan-agreement')!.current.version).toBe('1.1');
    expect(map.get('managed-plan-agreement')!.versions.get('1.0')!.supersededOn).toBe(
      'October 28, 2026',
    );
    for (const slug of ['review-guidelines', 'listing-accuracy'] as const) {
      expect(map.get(slug)!.versions.size, slug).toBe(1);
    }
  });

  it('the archived vendor documents 1.0 still say the fields are handed back; 1.1 does not', () => {
    const map = buildLegalVersions(realSources());
    for (const slug of ['vendor-terms', 'managed-plan-agreement'] as const) {
      expect(map.get(slug)!.versions.get('1.0')!.body, slug).toContain('handed back');
      expect(map.get(slug)!.current.body, slug).not.toContain('handed back');
      expect(map.get(slug)!.current.body, slug).not.toContain('We may update them again');
    }
  });

  it('the archived ToS 1.0 is the pre-AECI-312 text, copied unchanged', () => {
    const v10 = buildLegalVersions(realSources()).get('terms')!.versions.get('1.0')!;
    expect(v10.data['last_updated']).toBe('October 10, 2026');
    // 1.0 left the governing law to counsel; 1.1 filled it with Florida.
    expect(v10.body).not.toContain('State of Florida');
  });

  it('every current file ends with ## Change history', () => {
    for (const slug of LEGAL_SLUGS) {
      expect(changeHistoryItems(read(LEGAL_SOURCE_FILES[slug])), slug).toBeDefined();
    }
  });

  it('no current file still calls the change history a public repository log', () => {
    for (const slug of LEGAL_SLUGS) {
      expect(read(LEGAL_SOURCE_FILES[slug]), slug).not.toMatch(/public commit log/i);
    }
  });

  it('archive URLs are /legal/<slug>/v<version>', () => {
    expect(LEGAL_ARCHIVE_PATHS).toEqual([
      '/legal/terms/v1.0',
      '/legal/privacy/v1.0',
      '/legal/vendor-terms/v1.0',
      '/legal/managed-plan-agreement/v1.0',
    ]);
  });
});

// --- Synthetic sources -------------------------------------------------------

function doc(version: string, history: string, extra = ''): string {
  return `---\ntitle: T\nversion: ${version}\n---\n\nBody.\n${extra}\n## Change history\n\n${history}\n`;
}

const ARCHIVE: LegalArchiveEntry = { slug: 'terms', version: '1.0', supersededOn: 'May 1, 2026' };
const GOOD_HISTORY = [
  '- **Version 1.1** (this version): draft, not yet in force.',
  '- [Version 1.0](/legal/terms/v1.0): draft, never in force. Superseded May 1, 2026.',
].join('\n');

function sources(overrides: Partial<LegalVersionSources> = {}): LegalVersionSources {
  return {
    current: { terms: doc('1.1', GOOD_HISTORY) },
    archives: { 'versions/terms/v1.0.md': '---\ntitle: T\nversion: 1.0\n---\n\nOld body.\n' },
    manifest: [ARCHIVE],
    ...overrides,
  };
}

describe('buildLegalVersions', () => {
  it('builds slug → versions with the current pointer and the archive', () => {
    const set = buildLegalVersions(sources()).get('terms')!;
    expect(set.current.version).toBe('1.1');
    expect([...set.versions.keys()]).toEqual(['1.1', '1.0']);
    expect(set.versions.get('1.0')!.body).toContain('Old body.');
    expect(set.versions.get('1.0')!.supersededOn).toBe('May 1, 2026');
    expect(set.current.supersededOn).toBeUndefined();
  });

  it('throws on a version collision: an archive at the current version', () => {
    expect(() =>
      buildLegalVersions(
        sources({
          current: { terms: doc('1.0', '- **Version 1.0** (this version).') },
        }),
      ),
    ).toThrow(/version collision/);
  });

  it('throws on a version collision: the same archive listed twice in the manifest', () => {
    expect(() => buildLegalVersions(sources({ manifest: [ARCHIVE, ARCHIVE] }))).toThrow(
      /version collision/,
    );
  });

  it('throws on a filename/frontmatter mismatch', () => {
    expect(() =>
      buildLegalVersions(
        sources({ archives: { 'versions/terms/v1.0.md': '---\nversion: 0.9\n---\nOld.\n' } }),
      ),
    ).toThrow(/filename\/frontmatter mismatch/);
  });

  it('throws on an archive file outside versions/<slug>/v<version>.md', () => {
    expect(() =>
      buildLegalVersions(sources({ archives: { 'terms-1.0.md': '---\nversion: 1.0\n---\n' } })),
    ).toThrow(/is not named versions/);
  });

  it('throws when an archive file has no manifest entry', () => {
    expect(() => buildLegalVersions(sources({ manifest: [] }))).toThrow(
      /has no LEGAL_ARCHIVES entry/,
    );
  });

  it('throws when a manifest entry has no bundled file', () => {
    expect(() => buildLegalVersions(sources({ archives: {} }))).toThrow(/is not bundled/);
  });

  it('throws when the current file has no ## Change history', () => {
    expect(() =>
      buildLegalVersions(sources({ current: { terms: '---\nversion: 1.1\n---\n\nBody.\n' } })),
    ).toThrow(/does not end with a "## Change history" section/);
  });

  it('throws when ## Change history is not the last section', () => {
    expect(() =>
      buildLegalVersions(
        sources({ current: { terms: `${doc('1.1', GOOD_HISTORY)}\n## Contact\n\nMail us.\n` } }),
      ),
    ).toThrow(/does not end with/);
  });

  it('throws when an archived version is not listed', () => {
    expect(() =>
      buildLegalVersions(
        sources({ current: { terms: doc('1.1', '- **Version 1.1** (this version).') } }),
      ),
    ).toThrow(/does not list archived version 1.0/);
  });

  it('throws when a listed version does not resolve', () => {
    const history = `${GOOD_HISTORY}\n- [Version 0.9](/legal/terms/v0.9): draft.`;
    expect(() => buildLegalVersions(sources({ current: { terms: doc('1.1', history) } }))).toThrow(
      /lists version 0.9, which does not resolve/,
    );
  });

  it('throws when a change history link does not resolve', () => {
    const history = [
      '- **Version 1.1** (this version).',
      '- [Version 1.0](/legal/terms/v1.0) and [the old one](/legal/terms/v0.1). Superseded May 1, 2026.',
    ].join('\n');
    expect(() => buildLegalVersions(sources({ current: { terms: doc('1.1', history) } }))).toThrow(
      /links to \/legal\/terms\/v0.1, which does not resolve/,
    );
  });

  it('throws when the current version is not listed', () => {
    const history =
      '- [Version 1.0](/legal/terms/v1.0): draft, never in force. Superseded May 1, 2026.';
    expect(() => buildLegalVersions(sources({ current: { terms: doc('1.1', history) } }))).toThrow(
      /does not list the current version 1.1/,
    );
  });

  it('throws when an archived line has no archive link or no superseded date', () => {
    const noLink = '- **Version 1.1** (this version).\n- Version 1.0: Superseded May 1, 2026.';
    expect(() => buildLegalVersions(sources({ current: { terms: doc('1.1', noLink) } }))).toThrow(
      /does not link to \/legal\/terms\/v1.0/,
    );
    const noDate = '- **Version 1.1** (this version).\n- [Version 1.0](/legal/terms/v1.0): draft.';
    expect(() => buildLegalVersions(sources({ current: { terms: doc('1.1', noDate) } }))).toThrow(
      /does not give its superseded date/,
    );
  });
});
