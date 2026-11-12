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
  LEGAL_CURRENT_VERSIONS,
  LEGAL_CURRENT_VERSION_PATHS,
  LEGAL_SLUGS,
  LEGAL_SOURCE_FILES,
  LEGAL_UPCOMING,
  LEGAL_UPCOMING_PATHS,
  type LegalArchiveEntry,
  type LegalUpcomingEntry,
  legalArchiveFile,
} from './legal-manifest';
import {
  type LegalVersionSources,
  buildLegalVersions,
  changeHistoryItems,
  legalDateLabel,
} from './legal-versions';

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
    upcoming: LEGAL_UPCOMING,
    currentVersions: LEGAL_CURRENT_VERSIONS,
  };
}

describe('the real legal sources (AECI-1361)', () => {
  it('every versions/ file on disk has a manifest entry, and every entry has a file', () => {
    expect(diskArchiveFiles().sort()).toEqual(
      [...LEGAL_ARCHIVES, ...LEGAL_UPCOMING].map((a) => legalArchiveFile(a.slug, a.version)).sort(),
    );
  });

  it('upcoming URLs derive from LEGAL_UPCOMING (AECI-1610)', () => {
    expect(LEGAL_UPCOMING_PATHS).toEqual(
      LEGAL_UPCOMING.map((u) => `/legal/${u.slug}/v${u.version}`),
    );
  });

  // A change notice links /legal/<slug>/v<version>. On bump day that version
  // becomes the current file, so the current version must keep that URL.
  it('serves each current version at its own /legal/<slug>/v<version> address (AECI-1610)', () => {
    const map = buildLegalVersions(realSources());
    for (const slug of LEGAL_SLUGS) {
      expect(LEGAL_CURRENT_VERSIONS[slug], slug).toBe(map.get(slug)!.current.version);
    }
    expect(LEGAL_CURRENT_VERSION_PATHS).toEqual(
      LEGAL_SLUGS.map((slug) => `/legal/${slug}/v${LEGAL_CURRENT_VERSIONS[slug]}`),
    );
    for (const path of LEGAL_CURRENT_VERSION_PATHS) {
      expect(LEGAL_ARCHIVE_PATHS).not.toContain(path);
      expect(LEGAL_UPCOMING_PATHS).not.toContain(path);
    }
  });

  it('builds: the four versioned documents carry their archives; the two policies have no archive', () => {
    const map = buildLegalVersions(realSources());
    expect(map.get('terms')!.current.version).toBe('1.1');
    expect(map.get('terms')!.versions.get('1.0')!.supersededOn).toBe('October 14, 2026');
    expect(map.get('privacy')!.current.version).toBe('1.1');
    expect(map.get('privacy')!.versions.get('1.0')!.supersededOn).toBe('October 13, 2026');
    // AECI-1428: when Managed ends, the fields stay the vendor's.
    expect(map.get('vendor-terms')!.versions.get('1.0')!.supersededOn).toBe('October 28, 2026');
    // AECI-1363: production held a 1.1 acceptance, so counsel's held items bumped to 1.2,
    // and two 1.2 acceptances bumped legal branch 5 to 1.3.
    expect(map.get('vendor-terms')!.current.version).toBe('1.3');
    expect(map.get('vendor-terms')!.versions.get('1.1')!.supersededOn).toBe('November 7, 2026');
    expect(map.get('vendor-terms')!.versions.get('1.2')!.supersededOn).toBe('November 12, 2026');
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
      '/legal/vendor-terms/v1.1',
      '/legal/vendor-terms/v1.2',
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
      /has no LEGAL_ARCHIVES or LEGAL_UPCOMING entry/,
    );
  });

  it('throws when LEGAL_CURRENT_VERSIONS disagrees with the current file (AECI-1610)', () => {
    expect(() => buildLegalVersions(sources({ currentVersions: { terms: '1.1' } }))).not.toThrow();
    expect(() => buildLegalVersions(sources({ currentVersions: { terms: '1.0' } }))).toThrow(
      /LEGAL_CURRENT_VERSIONS says terms is version 1.0/,
    );
    expect(() => buildLegalVersions(sources({ currentVersions: {} }))).toThrow(/move both/);
  });

  it('lets the change history link the current version at its own address', () => {
    const history = GOOD_HISTORY.replace('**Version 1.1**', '[Version 1.1](/legal/terms/v1.1)');
    expect(() =>
      buildLegalVersions(sources({ current: { terms: doc('1.1', history) } })),
    ).not.toThrow();
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

// --- Upcoming versions (AECI-1610) -------------------------------------------

describe('legalDateLabel', () => {
  it('writes a real day out as "Month D, YYYY"', () => {
    expect(legalDateLabel('2027-03-01')).toBe('March 1, 2027');
    expect(legalDateLabel('2026-12-31')).toBe('December 31, 2026');
  });

  it.each(['03/01/2027', '2027-3-1', '2027-13-01', '2027-02-30', ''])('refuses "%s"', (iso) => {
    expect(legalDateLabel(iso)).toBeUndefined();
  });
});

describe('buildLegalVersions with an upcoming version', () => {
  const UPCOMING: LegalUpcomingEntry = { slug: 'terms', version: '1.2', effectiveOn: '2027-03-31' };
  const UPCOMING_FILE = 'versions/terms/v1.2.md';
  const OLD_FILE = '---\ntitle: T\nversion: 1.0\n---\n\nOld body.\n';
  function upcomingFile(version = '1.2', effective = 'March 31, 2027'): string {
    return `---\ntitle: T\nversion: ${version}\neffective_date: ${effective}\n---\n\nNew body.\n`;
  }

  function withUpcoming(overrides: Partial<LegalVersionSources> = {}): LegalVersionSources {
    return sources({
      archives: { 'versions/terms/v1.0.md': OLD_FILE, [UPCOMING_FILE]: upcomingFile() },
      upcoming: [UPCOMING],
      ...overrides,
    });
  }

  it('builds: the upcoming version resolves, carries its effective day, and is not current', () => {
    const set = buildLegalVersions(withUpcoming()).get('terms')!;
    expect(set.current.version).toBe('1.1');
    const next = set.versions.get('1.2')!;
    expect(next.effectiveOn).toBe('2027-03-31');
    expect(next.supersededOn).toBeUndefined();
    expect(next.body).toContain('New body.');
    expect(next.data['effective_date']).toBe('March 31, 2027');
  });

  // AECI-1689 owns what happens on the date. The builder never reads the clock,
  // so `main` cannot go red the day after an effective date.
  it('still builds once the effective date has passed', () => {
    const past: LegalUpcomingEntry = { ...UPCOMING, effectiveOn: '2001-01-01' };
    expect(() =>
      buildLegalVersions(
        withUpcoming({
          upcoming: [past],
          archives: {
            'versions/terms/v1.0.md': OLD_FILE,
            [UPCOMING_FILE]: upcomingFile('1.2', 'January 1, 2001'),
          },
        }),
      ),
    ).not.toThrow();
  });

  it('throws when the upcoming file is missing', () => {
    expect(() =>
      buildLegalVersions(withUpcoming({ archives: { 'versions/terms/v1.0.md': OLD_FILE } })),
    ).toThrow(/LEGAL_UPCOMING lists terms 1.2 but "versions\/terms\/v1.2.md" is not bundled/);
  });

  it('throws when a versions/ file has no entry in either manifest', () => {
    expect(() => buildLegalVersions(withUpcoming({ upcoming: [] }))).toThrow(
      /"versions\/terms\/v1.2.md" has no LEGAL_ARCHIVES or LEGAL_UPCOMING entry/,
    );
  });

  it('throws when the upcoming file names another version than its filename', () => {
    expect(() =>
      buildLegalVersions(
        withUpcoming({
          archives: { 'versions/terms/v1.0.md': OLD_FILE, [UPCOMING_FILE]: upcomingFile('1.3') },
        }),
      ),
    ).toThrow(/filename\/frontmatter mismatch/);
  });

  it('throws when the frontmatter label is not the effectiveOn day', () => {
    expect(() =>
      buildLegalVersions(
        withUpcoming({
          archives: {
            'versions/terms/v1.0.md': OLD_FILE,
            [UPCOMING_FILE]: upcomingFile('1.2', 'March 30, 2027'),
          },
        }),
      ),
    ).toThrow(/effective_date "March 30, 2027" is not "March 31, 2027"/);
  });

  it.each(['2027-02-30', '31/03/2027', ''])('throws on an effectiveOn of "%s"', (effectiveOn) => {
    expect(() =>
      buildLegalVersions(withUpcoming({ upcoming: [{ ...UPCOMING, effectiveOn }] })),
    ).toThrow(/is not a real YYYY-MM-DD day/);
  });

  it.each(['1.1', '1.0.5', '0.9'])(
    'throws when the upcoming version %s is not later than the current one',
    (version) => {
      expect(() =>
        buildLegalVersions(withUpcoming({ upcoming: [{ ...UPCOMING, version }] })),
      ).toThrow(/is not later than the current version 1.1/);
    },
  );

  it('compares versions numerically, not as text', () => {
    const v110: LegalUpcomingEntry = { ...UPCOMING, version: '1.10' };
    expect(() =>
      buildLegalVersions(
        withUpcoming({
          archives: {
            'versions/terms/v1.0.md': OLD_FILE,
            'versions/terms/v1.10.md': upcomingFile('1.10'),
          },
          upcoming: [v110],
        }),
      ),
    ).not.toThrow();
  });

  it('throws when the same file is both archived and upcoming, or listed twice', () => {
    expect(() =>
      buildLegalVersions(
        withUpcoming({
          manifest: [ARCHIVE, { slug: 'terms', version: '1.2', supersededOn: 'May 2, 2026' }],
        }),
      ),
    ).toThrow(/is also in LEGAL_ARCHIVES/);
    expect(() => buildLegalVersions(withUpcoming({ upcoming: [UPCOMING, UPCOMING] }))).toThrow(
      /is listed twice/,
    );
  });

  it('throws on a second upcoming entry for the same document', () => {
    const second: LegalUpcomingEntry = { ...UPCOMING, version: '1.3', effectiveOn: '2027-06-30' };
    expect(() =>
      buildLegalVersions(
        withUpcoming({
          archives: {
            'versions/terms/v1.0.md': OLD_FILE,
            [UPCOMING_FILE]: upcomingFile(),
            'versions/terms/v1.3.md': upcomingFile('1.3', 'June 30, 2027'),
          },
          upcoming: [UPCOMING, second],
        }),
      ),
    ).toThrow(/terms already has upcoming version 1.2/);
  });

  // Announcing a version must not edit the current file: for an agreement that
  // would change the hashed text of a version in force. `LegalPage` announces it.
  it('builds with the current file unchanged: its change history need not list it', () => {
    const plain = sources();
    const withIt = withUpcoming();
    expect(withIt.current).toEqual(plain.current);
    expect(() => buildLegalVersions(withIt)).not.toThrow();
  });
});
