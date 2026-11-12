/**
 * What a legal page shows once its upcoming version is in force (AECI-1689,
 * `STAGE_1_SPEC.md` §27.3, legal README "The effective date switches by itself").
 *
 * The rule is `legalUpcomingInForce` in `@aeci/shared`, the one the API Worker stamps
 * by. Here it is applied to the manifest: an upcoming entry is SWITCHED when its
 * moment (12:00 UTC of `effectiveOn`) has come and, for the two agreements, a
 * `legal_versions` row published it. A switched entry renders exactly what the
 * bump-day change will render:
 *
 *   - `/legal/<slug>` serves the upcoming text as the current one;
 *   - `/legal/<slug>/v<new>` is the current version at its own address (the address
 *     callout, no "takes effect" opener);
 *   - `/legal/<slug>/v<old>` serves the old text superseded on the effective date;
 *   - the announcement and the extra Change-history line stop.
 *
 * `noindex`, the canonical and the sitemap need nothing: every `/v<version>` address
 * is noindex and canonical to `/legal/<slug>` before and after, and the sitemap
 * lists `/legal/<slug>` only. `legal-bump-equivalence.spec.ts` proves the switched
 * view equals the bumped build for every URL.
 *
 * `.md`-free and Angular-free, so plain Vitest and the SSR runtime import it. The resolver
 * (`legal-in-force.resolver.ts`) decides `switched` per request on the server and
 * hands the browser the same answer through `TransferState`.
 */
import type { LegalAgreementDocument } from '@aeci/shared/api/agreements';
import {
  legalMomentReached,
  legalUpcomingInForce,
  type LegalPublishedLite,
} from '@aeci/shared/api/legal-in-force';
import { LEGAL_DOCUMENT_SLUGS, legalEffectiveAtMs } from '@aeci/shared/api/legal-versions';

import {
  LEGAL_UPCOMING,
  type LegalSlug,
  type LegalUpcomingEntry,
  legalArchivePath,
  legalPath,
} from './legal-manifest';
import type { LegalDoc } from './legal-render';
import { legalDateLabel } from './legal-versions';

/** slug → agreement document, for the two slugs that need a published row. */
const AGREEMENT_OF_SLUG = new Map<string, LegalAgreementDocument>(
  (Object.entries(LEGAL_DOCUMENT_SLUGS) as [LegalAgreementDocument, string][]).map(
    ([document, slug]) => [slug, document],
  ),
);

/** The agreement a slug is, or `undefined` for the four documents with no publish record. */
export function agreementOfSlug(slug: LegalSlug): LegalAgreementDocument | undefined {
  return AGREEMENT_OF_SLUG.get(slug);
}

/** The effective moment of an entry, epoch ms (NaN for a bad day, which never comes). */
export function legalEntryMomentMs(entry: LegalUpcomingEntry): number {
  return legalEffectiveAtMs(entry.effectiveOn);
}

/**
 * Whether `entry` is in force at `nowMs`. An agreement needs its published row
 * (`published`); any other document switches on its date alone.
 */
export function legalEntrySwitched(
  entry: LegalUpcomingEntry,
  published: readonly LegalPublishedLite[],
  nowMs: number,
): boolean {
  const document = agreementOfSlug(entry.slug);
  return document === undefined
    ? legalUpcomingInForce(entry.slug, entry, nowMs, null)
    : legalUpcomingInForce(document, entry, nowMs, published);
}

/** Whether `entry`'s moment has come. Before it, nothing changes and nothing is read. */
export function legalEntryMomentReached(entry: LegalUpcomingEntry, nowMs: number): boolean {
  return legalMomentReached(legalEntryMomentMs(entry), nowMs);
}

/**
 * The next effective moment after `nowMs` of any entry, or `null`. The SSR Worker caps a
 * `/legal/*` page's TTL there, so a page rendered just before a moment expires at it
 * (`capTtlAtLegalEffectiveMoment`, `CACHE_STRATEGY.md` §4).
 */
export function nextLegalEffectiveMomentMs(
  nowMs: number,
  entries: readonly LegalUpcomingEntry[] = LEGAL_UPCOMING,
): number | null {
  let next: number | null = null;
  for (const entry of entries) {
    const at = legalEntryMomentMs(entry);
    if (Number.isFinite(at) && at > nowMs && (next === null || at < next)) next = at;
  }
  return next;
}

/** How the page finds its document. A token in `legal-page.ts`, so a spec can render a fixture. */
export interface LegalDocLookup {
  current(slug: string): LegalDoc | undefined;
  version(slug: string, version: string): LegalDoc | undefined;
}

/** One upcoming version as the current page announces it. */
export interface LegalAnnouncement {
  readonly version: string;
  /** `effectiveOn` written out ("March 31, 2027"). */
  readonly effectiveDate: string;
  readonly path: string;
}

/** Everything `LegalPage` renders that depends on the version in force. */
export interface LegalView {
  readonly doc: LegalDoc;
  /** The current version's path: the canonical, and every callout's link. */
  readonly currentPath: string;
  /** The current version served at its own `/v<version>` address (AECI-1610). */
  readonly fixedCurrent: boolean;
  /** Upcoming versions announced on the current text; empty on any other page. */
  readonly announcements: readonly LegalAnnouncement[];
  /** Every `/v<version>` address is held out of the index. */
  readonly noindex: boolean;
}

/** `doc` as the current version: no "takes effect" opener, no superseded notice. */
function asCurrent(doc: LegalDoc): LegalDoc {
  const { effectiveOn: _e, supersededOn: _s, ...rest } = doc;
  return rest;
}

/**
 * What `/legal/<slug>` (no `version`) or `/legal/<slug>/v<version>` renders, given
 * whether the slug's upcoming entry has switched. `undefined` when the lookup has no
 * such document (a programming error: the routes only pass versions with a page).
 */
export function resolveLegalView(
  slug: LegalSlug,
  version: string | undefined,
  lookup: LegalDocLookup,
  upcoming: readonly LegalUpcomingEntry[],
  switched: boolean,
): LegalView | undefined {
  const entry = upcoming.find((u) => u.slug === slug);
  const live = switched ? entry : undefined;
  const buildCurrent = lookup.current(slug);
  let doc: LegalDoc | undefined;
  if (live && (version === undefined || version === live.version)) {
    const next = lookup.version(slug, live.version);
    doc = next && asCurrent(next);
  } else if (live && buildCurrent && version === buildCurrent.frontmatter.version) {
    // The old current text, archived on the effective date, as bump day archives it.
    doc = { ...buildCurrent, supersededOn: legalDateLabel(live.effectiveOn) ?? live.effectiveOn };
  } else {
    doc = version === undefined ? buildCurrent : lookup.version(slug, version);
  }
  if (!doc) return undefined;
  const fixedCurrent =
    version !== undefined && doc.supersededOn === undefined && doc.effectiveOn === undefined;
  const showsCurrent = version === undefined || fixedCurrent;
  const announcements =
    showsCurrent && !live
      ? upcoming
          .filter((u) => u.slug === slug)
          .map((u) => ({
            version: u.version,
            // The registry has already refused an invalid `effectiveOn`.
            effectiveDate: legalDateLabel(u.effectiveOn) ?? u.effectiveOn,
            path: legalArchivePath(slug, u.version),
          }))
      : [];
  return {
    doc,
    currentPath: legalPath(slug),
    fixedCurrent,
    announcements,
    noindex: version !== undefined,
  };
}
