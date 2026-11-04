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
  LEGAL_SLUGS,
  LEGAL_SOURCE_FILES,
  LEGAL_UPCOMING_PATHS,
  type LegalSlug,
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

function problems(notice: Partial<LegalNotice>, upcoming = ['/legal/privacy/v1.2']): string[] {
  return validateLegalNotices([{ ...NOTICE, ...notice }], REAL_TITLES, upcoming);
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
    expect(
      problems(notice, ['/legal/privacy/v1.2', `/legal/${notice.slug}/v${notice.version}`]).join(),
    ).toContain(message);
  });

  it('refuses a duplicate', () => {
    expect(validateLegalNotices([NOTICE, NOTICE], REAL_TITLES, ['/legal/privacy/v1.2'])).toEqual([
      'privacy@1.2: listed twice',
    ]);
  });

  // The gate on `notices.json`. It also holds the first notice back until the
  // upcoming-version page fills `LEGAL_UPCOMING_PATHS`.
  it('passes on the real entries', () => {
    expect(validateLegalNotices(LEGAL_NOTICES, REAL_TITLES, LEGAL_UPCOMING_PATHS)).toEqual([]);
  });
});
