/**
 * Site-wide legal notices (AECI-1592, `STAGE_1_SPEC.md` §27.4). The Privacy Policy
 * promises a notice on every page for 30 days before a material change takes
 * effect. `src/content/legal/notices.json` holds the entries, and the operator
 * step is in `src/content/legal/README.md`.
 *
 * The entries stay a committed file, not a D1 row, because the deploy is what
 * refreshes the cache: the cache key includes the Worker version. The window's two
 * dates need no deploy, because `capTtlAtLegalNoticeBoundary` (`server-runtime.ts`)
 * ends every page's TTL at the next boundary (`CACHE_STRATEGY.md` §4).
 *
 * Pure and `.md`-free, because the app shell and the SSR runtime both import it.
 * `validateLegalNotices` runs in a spec and never at module init: a throw here
 * would take down every page.
 */
import noticesJson from '../../content/legal/notices.json';
// `legal-slugs`, not `legal-manifest`: the app shell imports this file, and the
// version lists must stay out of the initial bundle. The entry type is type-only.
import type { LegalUpcomingEntry } from './legal-manifest';
import { LEGAL_SLUGS, type LegalSlug, legalArchivePath } from './legal-slugs';

/** One entry in `notices.json`. */
export interface LegalNotice {
  readonly slug: LegalSlug;
  /** The document's frontmatter `title`. */
  readonly title: string;
  /** The version taking effect. */
  readonly version: string;
  /** The day it takes effect: `YYYY-MM-DD`, read as UTC. */
  readonly effectiveDate: string;
  /**
   * The same day as a pre-formatted "Month D, YYYY" string, like the frontmatter
   * dates, so SSR and the browser render the same bytes.
   */
  readonly effectiveDateLabel: string;
  /** One line naming what changes. Content, so it is not `$localize`-extracted. */
  readonly summary: string;
}

export interface LegalNoticeWindow {
  /** Inclusive. */
  readonly startMs: number;
  /** Exclusive. */
  readonly endMs: number;
}

export const LEGAL_NOTICES = noticesJson as readonly LegalNotice[];

/** How long a notice runs before its effective date. */
export const LEGAL_NOTICE_DAYS = 30;

/** The longest summary the one-line band is designed for. */
export const LEGAL_NOTICE_SUMMARY_MAX = 200;

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d+(?:\.\d+)*$/;

/** A notice's identity. A dismissal is stored against it, so it never hides the next one. */
export function legalNoticeId(notice: LegalNotice): string {
  return `${notice.slug}@${notice.version}`;
}

/** The URL of the version the notice announces. */
export function legalNoticeHref(notice: LegalNotice): string {
  return legalArchivePath(notice.slug, notice.version);
}

function effectiveDateMs(notice: LegalNotice): number {
  return Date.parse(`${notice.effectiveDate}T00:00:00Z`);
}

/**
 * Opens at 00:00 UTC, 30 days before the effective date, and closes when that date
 * has passed. UTC midnight comes before the US day starts, so the 30 days are never
 * short.
 */
export function legalNoticeWindow(notice: LegalNotice): LegalNoticeWindow {
  const effective = effectiveDateMs(notice);
  return { startMs: effective - LEGAL_NOTICE_DAYS * DAY_MS, endMs: effective + DAY_MS };
}

export function activeLegalNotices(
  nowMs: number,
  notices: readonly LegalNotice[],
): readonly LegalNotice[] {
  return notices.filter((notice) => {
    const { startMs, endMs } = legalNoticeWindow(notice);
    return startMs <= nowMs && nowMs < endMs;
  });
}

/** The nearest window start or end after `nowMs`, or `null` when none is left. */
export function nextLegalNoticeBoundaryMs(
  nowMs: number,
  notices: readonly LegalNotice[],
): number | null {
  let next: number | null = null;
  for (const notice of notices) {
    const { startMs, endMs } = legalNoticeWindow(notice);
    for (const boundary of [startMs, endMs]) {
      if (boundary > nowMs && (next === null || boundary < next)) next = boundary;
    }
  }
  return next;
}

/**
 * Every problem with `notices`, or an empty list. `titles` is each document's
 * frontmatter title. `upcoming` is `LEGAL_UPCOMING`: a notice whose new version
 * has no upcoming entry has no page, which would break the promise to link to it,
 * and a notice must name the same effective day as the entry (AECI-1610).
 * `currentVersions` is `LEGAL_CURRENT_VERSIONS`: the band runs through the
 * effective day, after the same-day bump has removed the upcoming entry, so a
 * notice for the version now current is allowed until it is tidied away.
 */
export function validateLegalNotices(
  notices: readonly LegalNotice[],
  titles: Readonly<Partial<Record<LegalSlug, string>>>,
  upcoming: readonly LegalUpcomingEntry[],
  currentVersions: Readonly<Partial<Record<LegalSlug, string>>> = {},
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const labelFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });

  for (const notice of notices) {
    const id = legalNoticeId(notice);
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);

    if (!LEGAL_SLUGS.includes(notice.slug)) problems.push(`${id}: unknown slug`);
    if (!VERSION_RE.test(notice.version)) problems.push(`${id}: invalid version`);
    if (notice.title !== titles[notice.slug]) {
      problems.push(`${id}: title "${notice.title}" does not match the document`);
    }

    const effective = effectiveDateMs(notice);
    if (!ISO_DATE_RE.test(notice.effectiveDate) || Number.isNaN(effective)) {
      problems.push(`${id}: effectiveDate "${notice.effectiveDate}" is not YYYY-MM-DD`);
    } else if (notice.effectiveDateLabel !== labelFormat.format(effective)) {
      problems.push(`${id}: effectiveDateLabel "${notice.effectiveDateLabel}" is not that day`);
    }

    const summary = notice.summary.trim();
    if (summary.length === 0) problems.push(`${id}: summary is empty`);
    if (summary.length > LEGAL_NOTICE_SUMMARY_MAX) {
      problems.push(`${id}: summary is longer than ${LEGAL_NOTICE_SUMMARY_MAX} characters`);
    }

    const entry = upcoming.find((u) => u.slug === notice.slug && u.version === notice.version);
    if (entry) {
      if (entry.effectiveOn !== notice.effectiveDate) {
        problems.push(
          `${id}: effectiveDate ${notice.effectiveDate} is not the LEGAL_UPCOMING effectiveOn ${entry.effectiveOn}`,
        );
      }
    } else if (currentVersions[notice.slug] !== notice.version) {
      // A bumped version is current, and its own address still serves the link.
      problems.push(`${id}: ${legalNoticeHref(notice)} is not in LEGAL_UPCOMING_PATHS`);
    }
  }
  return problems;
}
