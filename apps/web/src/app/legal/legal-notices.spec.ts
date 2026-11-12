/**
 * AECI-1592 — the legal notice window and the entry checks. `validateLegalNotices`
 * runs here and not at module init, so the real-data case below is the gate on
 * `notices.json`.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseFrontmatter } from './legal-frontmatter';
import {
  LEGAL_CURRENT_VERSIONS,
  LEGAL_SLUGS,
  LEGAL_SOURCE_FILES,
  LEGAL_UPCOMING,
  LEGAL_UPCOMING_PATHS,
  type LegalSlug,
  type LegalUpcomingEntry,
  legalUpcomingPaths,
} from './legal-manifest';
import {
  LEGAL_NOTICES,
  type LegalNotice,
  activeLegalNotices,
  legalNoticeHref,
  legalNoticeId,
  legalNoticeWindow,
  nextLegalNoticeBoundaryMs,
  validateLegalNotices,
} from './legal-notices';

const CONTENT_DIR = fileURLToPath(new URL('../../content/legal', import.meta.url));

const REAL_TITLES = Object.fromEntries(
  LEGAL_SLUGS.map((slug) => [
    slug,
    parseFrontmatter(readFileSync(join(CONTENT_DIR, LEGAL_SOURCE_FILES[slug]), 'utf8')).data[
      'title'
    ],
  ]),
) as Record<LegalSlug, string>;

const NOTICE: LegalNotice = {
  slug: 'privacy',
  title: 'Privacy Policy',
  version: '1.2',
  effectiveDate: '2027-03-31',
  effectiveDateLabel: 'March 31, 2027',
  summary: 'We change how long we keep visit records.',
};
const OPENS = Date.UTC(2027, 2, 1);
const CLOSES = Date.UTC(2027, 3, 1);

const ENTRY: LegalUpcomingEntry = { slug: 'privacy', version: '1.2', effectiveOn: '2027-03-31' };

/** By default the notice has a matching `LEGAL_UPCOMING` entry, so one field is under test. */
function problems(notice: Partial<LegalNotice>, upcoming?: LegalUpcomingEntry[]): string[] {
  const merged = { ...NOTICE, ...notice };
  const entries = upcoming ?? [
    { slug: merged.slug, version: merged.version, effectiveOn: merged.effectiveDate },
  ];
  return validateLegalNotices([merged], REAL_TITLES, entries);
}

describe('legalNoticeWindow', () => {
  it('opens 30 days before the effective date and closes when that date has passed', () => {
    expect(legalNoticeWindow(NOTICE)).toEqual({ startMs: OPENS, endMs: CLOSES });
  });
});

describe('activeLegalNotices', () => {
  it.each([
    ['1 ms before it opens', OPENS - 1, false],
    ['the moment it opens', OPENS, true],
    ['the effective date', Date.UTC(2027, 2, 31, 12), true],
    ['the last ms', CLOSES - 1, true],
    ['the moment it closes', CLOSES, false],
  ])('at %s', (_label, now, active) => {
    expect(activeLegalNotices(now, [NOTICE])).toEqual(active ? [NOTICE] : []);
  });
});

describe('nextLegalNoticeBoundaryMs', () => {
  const later: LegalNotice = { ...NOTICE, slug: 'terms', effectiveDate: '2027-03-15' };

  it('finds the opening boundary, then the closing one, then none', () => {
    expect(nextLegalNoticeBoundaryMs(OPENS - 1, [NOTICE])).toBe(OPENS);
    expect(nextLegalNoticeBoundaryMs(OPENS, [NOTICE])).toBe(CLOSES);
    expect(nextLegalNoticeBoundaryMs(CLOSES, [NOTICE])).toBeNull();
  });

  it('takes the nearest boundary across notices', () => {
    expect(nextLegalNoticeBoundaryMs(OPENS, [NOTICE, later])).toBe(Date.UTC(2027, 2, 16));
  });

  it('is null with no notices', () => {
    expect(nextLegalNoticeBoundaryMs(OPENS, [])).toBeNull();
  });
});

describe('legalNoticeId', () => {
  it('differs by version, so a dismissal never hides the next notice', () => {
    expect(legalNoticeId(NOTICE)).toBe('privacy@1.2');
    expect(legalNoticeId({ ...NOTICE, version: '1.3' })).toBe('privacy@1.3');
  });
});

describe('legalNoticeHref', () => {
  it('names the new version', () => {
    expect(legalNoticeHref(NOTICE)).toBe('/legal/privacy/v1.2');
  });
});

describe('validateLegalNotices', () => {
  it('accepts a good entry', () => {
    expect(problems({})).toEqual([]);
  });

  it('refuses an entry whose new version has no page', () => {
    expect(problems({}, [])).toEqual([
      'privacy@1.2: /legal/privacy/v1.2 is not in LEGAL_UPCOMING_PATHS',
    ]);
  });

  it.each<[string, Partial<LegalNotice>, string]>([
    ['an unknown slug', { slug: 'nope' as LegalSlug }, 'unknown slug'],
    ['a bad version', { version: 'next' }, 'invalid version'],
    ['a wrong title', { title: 'Privacy' }, 'does not match the document'],
    ['a bad date', { effectiveDate: '03/31/2027' }, 'is not YYYY-MM-DD'],
    ['an impossible date', { effectiveDate: '2027-13-01' }, 'is not YYYY-MM-DD'],
    ['a label for another day', { effectiveDateLabel: 'March 30, 2027' }, 'is not that day'],
    ['an empty summary', { summary: '  ' }, 'summary is empty'],
    ['a long summary', { summary: 'x'.repeat(201) }, 'longer than 200'],
  ])('refuses %s', (_label, notice, message) => {
    expect(problems(notice).join()).toContain(message);
  });

  it('refuses a duplicate', () => {
    expect(validateLegalNotices([NOTICE, NOTICE], REAL_TITLES, [ENTRY])).toEqual([
      'privacy@1.2: listed twice',
    ]);
  });

  // AECI-1610: a notice needs a `LEGAL_UPCOMING` entry for its version, on the
  // same effective day.
  it('accepts a notice whose LEGAL_UPCOMING entry matches, and refuses one without an entry', () => {
    expect(validateLegalNotices([NOTICE], REAL_TITLES, [ENTRY])).toEqual([]);
    expect(validateLegalNotices([NOTICE], REAL_TITLES, [{ ...ENTRY, version: '1.3' }])).toEqual([
      'privacy@1.2: /legal/privacy/v1.2 is not in LEGAL_UPCOMING_PATHS',
    ]);
  });

  it('refuses a notice whose effectiveDate is not the entry effectiveOn', () => {
    expect(
      validateLegalNotices([NOTICE], REAL_TITLES, [{ ...ENTRY, effectiveOn: '2027-04-01' }]),
    ).toEqual([
      'privacy@1.2: effectiveDate 2027-03-31 is not the LEGAL_UPCOMING effectiveOn 2027-04-01',
    ]);
  });

  // The band runs through the effective day, after the same-day bump removed the
  // upcoming entry. The notice stays valid while its version is the current one.
  it('accepts a notice for the version now current, after the bump', () => {
    expect(validateLegalNotices([NOTICE], REAL_TITLES, [], { privacy: '1.2' })).toEqual([]);
    expect(validateLegalNotices([NOTICE], REAL_TITLES, [], { privacy: '1.1' })).toEqual([
      'privacy@1.2: /legal/privacy/v1.2 is not in LEGAL_UPCOMING_PATHS',
    ]);
  });

  it('LEGAL_UPCOMING_PATHS is the paths of LEGAL_UPCOMING', () => {
    expect(LEGAL_UPCOMING_PATHS).toEqual(legalUpcomingPaths(LEGAL_UPCOMING));
  });

  // The gate on `notices.json`: every real notice must link an upcoming version
  // the manifest lists.
  it('passes on the real entries', () => {
    expect(
      validateLegalNotices(LEGAL_NOTICES, REAL_TITLES, LEGAL_UPCOMING, LEGAL_CURRENT_VERSIONS),
    ).toEqual([]);
  });
});
