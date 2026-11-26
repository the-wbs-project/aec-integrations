/**
 * Site-wide legal notices (AECI-1592, `STAGE_1_SPEC.md` §27.4). The Privacy Policy
 * promises a notice on every page for 30 days before a material change takes
 * effect. `src/content/legal/notices.json` holds the entries, and the operator
 * step is in `src/content/legal/README.md`.
 *
 * Two kinds of entry. A change notice (no `kind`, or `kind: "change"`) names one
 * document's upcoming version. Since AECI-1870 (ruling 68) an in-force notice
 * (`kind: "in-force"`) says the first in-force versions took effect: it runs from
 * 00:00 UTC of their effective day for 14 days, links `/legal`, and names the versions,
 * each of which must be the current one, dated that day.
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

/** A change notice in `notices.json`: one document's upcoming version. */
export interface LegalChangeNotice {
  /** Absent on every entry written before AECI-1870. */
  readonly kind?: 'change';
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

/**
 * An in-force notice in `notices.json` (AECI-1870, ruling 68): the first in-force
 * versions of the legal documents took effect on `effectiveDate`.
 */
export interface LegalInForceNotice {
  readonly kind: 'in-force';
  /** The day they took effect: `YYYY-MM-DD`, read as UTC. */
  readonly effectiveDate: string;
  /** The same day written out, "Month D, YYYY". */
  readonly effectiveDateLabel: string;
  /** Each version that took effect that day. Each must be the current version. */
  readonly documents: readonly { readonly slug: LegalSlug; readonly version: string }[];
}

/** One entry in `notices.json`. */
export type LegalNotice = LegalChangeNotice | LegalInForceNotice;

/** Whether an entry is an in-force notice (AECI-1870). */
export function isLegalInForceNotice(notice: LegalNotice): notice is LegalInForceNotice {
  return notice.kind === 'in-force';
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

/** How long an in-force notice runs from its effective day (AECI-1870, ruling 68). */
export const LEGAL_IN_FORCE_NOTICE_DAYS = 14;

/** The longest summary the one-line band is designed for. */
export const LEGAL_NOTICE_SUMMARY_MAX = 200;

const DAY_MS = 86_400_000;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION_RE = /^\d+(?:\.\d+)*$/;

/** A notice's identity. A dismissal is stored against it, so it never hides the next one. */
export function legalNoticeId(notice: LegalNotice): string {
  if (isLegalInForceNotice(notice)) return `in-force@${notice.effectiveDate}`;
  return `${notice.slug}@${notice.version}`;
}

/** The URL of the version the notice announces, or `/legal` for an in-force notice. */
export function legalNoticeHref(notice: LegalNotice): string {
  if (isLegalInForceNotice(notice)) return '/legal';
  return legalArchivePath(notice.slug, notice.version);
}

function effectiveDateMs(notice: LegalNotice): number {
  return Date.parse(`${notice.effectiveDate}T00:00:00Z`);
}

/**
 * A change notice opens at 00:00 UTC, 30 days before the effective date, and closes
 * when that date has passed. UTC midnight comes before the US day starts, so the 30
 * days are never short. An in-force notice opens at 00:00 UTC of its effective day and
 * closes 14 days later (AECI-1870).
 */
export function legalNoticeWindow(notice: LegalNotice): LegalNoticeWindow {
  const effective = effectiveDateMs(notice);
  if (isLegalInForceNotice(notice)) {
    return { startMs: effective, endMs: effective + LEGAL_IN_FORCE_NOTICE_DAYS * DAY_MS };
  }
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
 * effective day, which the bump-day cleanup may land within, so a
 * notice for the version now current is allowed until it is tidied away.
 * `currentEffectiveDates` is each current file's frontmatter `effective_date`. An
 * in-force notice (AECI-1870) is checked against it and `currentVersions` only.
 */
export function validateLegalNotices(
  notices: readonly LegalNotice[],
  titles: Readonly<Partial<Record<LegalSlug, string>>>,
  upcoming: readonly LegalUpcomingEntry[],
  currentVersions: Readonly<Partial<Record<LegalSlug, string>>> = {},
  currentEffectiveDates: Readonly<Partial<Record<LegalSlug, string>>> = {},
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const labelFormat = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });

  for (const notice of notices) {
    const id = legalNoticeId(notice);
    if (seen.has(id)) problems.push(`${id}: listed twice`);
    seen.add(id);

    const effective = effectiveDateMs(notice);
    if (!ISO_DATE_RE.test(notice.effectiveDate) || Number.isNaN(effective)) {
      problems.push(`${id}: effectiveDate "${notice.effectiveDate}" is not YYYY-MM-DD`);
    } else if (notice.effectiveDateLabel !== labelFormat.format(effective)) {
      problems.push(`${id}: effectiveDateLabel "${notice.effectiveDateLabel}" is not that day`);
    }

    if (isLegalInForceNotice(notice)) {
      problems.push(...inForceProblems(id, notice, currentVersions, currentEffectiveDates));
      continue;
    }

    if (!LEGAL_SLUGS.includes(notice.slug)) problems.push(`${id}: unknown slug`);
    if (!VERSION_RE.test(notice.version)) problems.push(`${id}: invalid version`);
    if (notice.title !== titles[notice.slug]) {
      problems.push(`${id}: title "${notice.title}" does not match the document`);
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

/**
 * The checks of an in-force notice (AECI-1870). Each named version must be the one now
 * current, not an upcoming one, and its frontmatter `effective_date` must be the
 * notice's day: the band says the documents ARE in force, so it is added in the
 * bump-day change, once the versions are current. `currentEffectiveDates` is each
 * current file's `effective_date`, written out.
 */
function inForceProblems(
  id: string,
  notice: LegalInForceNotice,
  currentVersions: Readonly<Partial<Record<LegalSlug, string>>>,
  currentEffectiveDates: Readonly<Partial<Record<LegalSlug, string>>>,
): string[] {
  const problems: string[] = [];
  if (notice.documents.length === 0) problems.push(`${id}: names no document`);
  const slugs = new Set<string>();
  for (const { slug, version } of notice.documents) {
    if (slugs.has(slug)) problems.push(`${id}: ${slug} listed twice`);
    slugs.add(slug);
    if (!LEGAL_SLUGS.includes(slug)) {
      problems.push(`${id}: unknown slug ${slug}`);
      continue;
    }
    if (currentVersions[slug] !== version) {
      problems.push(`${id}: ${slug} ${version} is not the current version`);
    } else if (currentEffectiveDates[slug] !== notice.effectiveDateLabel) {
      problems.push(`${id}: ${slug} ${version} is not in force from ${notice.effectiveDateLabel}`);
    }
  }
  return problems;
}
