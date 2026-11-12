/**
 * AECI-1689: bump day is cleanup. Once an upcoming version's moment has come (and, for
 * an agreement, it was published), every surface must already show what the bump-day
 * change will show, byte for byte. This spec builds one fixture registry both ways,
 * "upcoming and past its moment" and "bumped", and compares what each surface resolves:
 *
 *   - every `/legal/<slug>` and `/legal/<slug>/v<version>` page (`resolveLegalView`):
 *     the rendered document, its notices, the address callout, the announcements,
 *     noindex and the canonical path;
 *   - which `/v<version>` addresses have a page (`servesLegalVersion`) and which are
 *     held out of the index (the `NOINDEX_PATH_PREFIXES` inputs);
 *   - the version a new acceptance stamps, for the agreement and the policy
 *     (`legalVersionsInForce`, the rule the API stamps by), and the next moment the
 *     `/legal/*` TTL is capped at.
 *
 * It also pins the other half: one millisecond before the moment, and with no publish,
 * the "upcoming" build shows what it shows today.
 */
import { describe, expect, it } from 'vitest';

import { legalVersionsInForce, type LegalInForceMaps } from '@aeci/shared/api/legal-in-force';
import { legalEffectiveAtMs } from '@aeci/shared/api/legal-versions';

import {
  type LegalDocLookup,
  legalEntrySwitched,
  nextLegalEffectiveMomentMs,
  resolveLegalView,
} from './legal-in-force-state';
import {
  type LegalArchiveEntry,
  type LegalSlug,
  type LegalUpcomingEntry,
  legalArchivePath,
} from './legal-manifest';
import { renderLegalVersion } from './legal-render';
import { servesLegalVersion, type LegalVersionLists } from './legal-version-route';
import { type LegalVersionSources, buildLegalVersions } from './legal-versions';

const DAY = '2027-03-31';
const LABEL = 'March 31, 2027';
const MOMENT = legalEffectiveAtMs(DAY);

function file(title: string, version: string, effective: string, history: string[]): string {
  return [
    '---',
    `title: ${title}`,
    `version: ${version}`,
    `effective_date: ${effective}`,
    'last_updated: February 1, 2027',
    '---',
    '',
    `Body of ${title} ${version}.`,
    '',
    '## Change history',
    '',
    ...history,
    '',
  ].join('\n');
}

// Vendor Terms: 1.2 archived, 1.3 current (a draft), 1.4 upcoming on DAY.
const VT_12 = file('Vendor Terms', '1.2', '', [
  '- **Version 1.2** (this version): draft, not yet in force.',
]);
const VT_13 = file('Vendor Terms', '1.3', '', [
  '- **Version 1.3** (this version): draft, not yet in force.',
  '- [Version 1.2](/legal/vendor-terms/v1.2): draft, never in force. Superseded November 12, 2026.',
]);
const VT_14 = file('Vendor Terms', '1.4', LABEL, [
  `- **Version 1.4** (this version): effective ${LABEL}.`,
  `- [Version 1.3](/legal/vendor-terms/v1.3): draft, never in force. Superseded ${LABEL}.`,
  '- [Version 1.2](/legal/vendor-terms/v1.2): draft, never in force. Superseded November 12, 2026.',
]);
// Listing Accuracy Policy: 1.0 current, 1.1 upcoming on DAY. No publish record.
const LA_10 = file('Listing Accuracy Policy', '1.0', '', [
  '- **Version 1.0** (this version): draft, not yet in force.',
]);
const LA_11 = file('Listing Accuracy Policy', '1.1', LABEL, [
  `- **Version 1.1** (this version): effective ${LABEL}.`,
  `- [Version 1.0](/legal/listing-accuracy/v1.0): draft, never in force. Superseded ${LABEL}.`,
]);

const VT_12_ARCHIVE: LegalArchiveEntry = {
  slug: 'vendor-terms',
  version: '1.2',
  supersededOn: 'November 12, 2026',
};
const UPCOMING: LegalUpcomingEntry[] = [
  { slug: 'vendor-terms', version: '1.4', effectiveOn: DAY },
  { slug: 'listing-accuracy', version: '1.1', effectiveOn: DAY },
];

/** The registry with the upcoming entries, as committed weeks before the date. */
const ANNOUNCED: LegalVersionSources = {
  current: { 'vendor-terms': VT_13, 'listing-accuracy': LA_10 },
  archives: {
    'versions/vendor-terms/v1.2.md': VT_12,
    'versions/vendor-terms/v1.4.md': VT_14,
    'versions/listing-accuracy/v1.1.md': LA_11,
  },
  manifest: [VT_12_ARCHIVE],
  upcoming: UPCOMING,
  currentVersions: { 'vendor-terms': '1.3', 'listing-accuracy': '1.0' },
};

/** The same registry after the bump-day change, run in the README's order. */
const BUMPED: LegalVersionSources = {
  // The upcoming files, moved byte for byte.
  current: { 'vendor-terms': VT_14, 'listing-accuracy': LA_11 },
  // The old current files, archived unchanged, superseded on the effective date.
  archives: {
    'versions/vendor-terms/v1.2.md': VT_12,
    'versions/vendor-terms/v1.3.md': VT_13,
    'versions/listing-accuracy/v1.0.md': LA_10,
  },
  manifest: [
    VT_12_ARCHIVE,
    { slug: 'vendor-terms', version: '1.3', supersededOn: LABEL },
    { slug: 'listing-accuracy', version: '1.0', supersededOn: LABEL },
  ],
  upcoming: [],
  currentVersions: { 'vendor-terms': '1.4', 'listing-accuracy': '1.1' },
};

function lookupOf(sources: LegalVersionSources): LegalDocLookup {
  const map = buildLegalVersions(sources);
  return {
    current: (slug) => {
      const set = map.get(slug as LegalSlug);
      return set && renderLegalVersion(set.current);
    },
    version: (slug, version) => {
      const v = map.get(slug as LegalSlug)?.versions.get(version);
      return v && renderLegalVersion(v);
    },
  };
}

function listsOf(sources: LegalVersionSources): LegalVersionLists {
  return {
    archives: sources.manifest,
    current: {
      terms: '0',
      privacy: '0',
      'review-guidelines': '0',
      ...sources.currentVersions,
    } as LegalVersionLists['current'],
    upcoming: sources.upcoming ?? [],
  };
}

/** The `/v<version>` paths held out of the index, as `docs-indexing.ts` derives them. */
function noindexPaths(lists: LegalVersionLists, slugs: readonly LegalSlug[]): string[] {
  return [
    ...lists.archives.map((a) => legalArchivePath(a.slug, a.version)),
    ...lists.upcoming.map((u) => legalArchivePath(u.slug, u.version)),
    ...slugs.map((s) => legalArchivePath(s, lists.current[s])),
  ].sort();
}

const SLUGS: readonly LegalSlug[] = ['vendor-terms', 'listing-accuracy'];
const VERSIONS: Record<string, (string | undefined)[]> = {
  'vendor-terms': [undefined, '1.2', '1.3', '1.4', '1.5'],
  'listing-accuracy': [undefined, '1.0', '1.1', '0.9'],
};

const announced = lookupOf(ANNOUNCED);
const bumped = lookupOf(BUMPED);

// The Vendor Terms 1.4 row a publish wrote: it takes effect at the manifest moment.
const PUBLISHED = [{ document: 'vendor_terms', version: '1.4', effectiveAt: MOMENT }];

const MAPS_ANNOUNCED: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.3', managed_plan: '1.1' },
  agreementUpcoming: { vendor_terms: { version: '1.4', effectiveOn: DAY } },
  policyCurrent: { listing_accuracy: '1.0', review_guidelines: '1.0' },
  policyUpcoming: { listing_accuracy: { version: '1.1', effectiveOn: DAY } },
};
const MAPS_BUMPED: LegalInForceMaps = {
  agreementCurrent: { vendor_terms: '1.4', managed_plan: '1.1' },
  agreementUpcoming: {},
  policyCurrent: { listing_accuracy: '1.1', review_guidelines: '1.0' },
  policyUpcoming: {},
};

describe('past its moment, the announced build equals the bumped build', () => {
  it('both registries build: the upcoming files already read as current', () => {
    expect(() => buildLegalVersions(ANNOUNCED)).not.toThrow();
    expect(() => buildLegalVersions(BUMPED)).not.toThrow();
  });

  it('the switch is on for both entries at the moment, with the row', () => {
    for (const entry of UPCOMING) expect(legalEntrySwitched(entry, PUBLISHED, MOMENT)).toBe(true);
  });

  for (const slug of SLUGS) {
    for (const version of VERSIONS[slug]) {
      const url = version === undefined ? `/legal/${slug}` : legalArchivePath(slug, version);
      it(`${url} renders the same page`, () => {
        const switched = UPCOMING.some(
          (u) => u.slug === slug && legalEntrySwitched(u, PUBLISHED, MOMENT),
        );
        const before = resolveLegalView(slug, version, announced, UPCOMING, switched);
        const after = resolveLegalView(slug, version, bumped, [], false);
        expect(before).toEqual(after);
        if (version !== undefined) {
          expect(servesLegalVersion(slug, version, listsOf(ANNOUNCED))).toBe(
            servesLegalVersion(slug, version, listsOf(BUMPED)),
          );
        }
      });
    }
  }

  it('the old version is superseded on the effective date, the new one has the address line', () => {
    const old = resolveLegalView('vendor-terms', '1.3', announced, UPCOMING, true)!;
    expect(old.doc.supersededOn).toBe(LABEL);
    expect(old.fixedCurrent).toBe(false);
    const own = resolveLegalView('vendor-terms', '1.4', announced, UPCOMING, true)!;
    expect(own.fixedCurrent).toBe(true);
    expect(own.doc.effectiveOn).toBeUndefined();
    expect(
      resolveLegalView('vendor-terms', undefined, announced, UPCOMING, true)!.announcements,
    ).toEqual([]);
  });

  it('the same addresses are held out of the index', () => {
    expect(noindexPaths(listsOf(ANNOUNCED), SLUGS)).toEqual(
      expect.arrayContaining(noindexPaths(listsOf(BUMPED), SLUGS)),
    );
    expect(noindexPaths(listsOf(BUMPED), SLUGS)).toEqual(
      expect.arrayContaining(noindexPaths(listsOf(ANNOUNCED), SLUGS)),
    );
  });

  it.each([MOMENT, MOMENT + 13 * 86_400_000])(
    'a new acceptance stamps the same versions (%s)',
    (now) => {
      expect(legalVersionsInForce(PUBLISHED, now, MAPS_ANNOUNCED)).toEqual(
        legalVersionsInForce([], now, MAPS_BUMPED),
      );
    },
  );

  it('no TTL cap is left after the moment, either way', () => {
    expect(nextLegalEffectiveMomentMs(MOMENT, UPCOMING)).toBeNull();
    expect(nextLegalEffectiveMomentMs(MOMENT, [])).toBeNull();
  });
});

describe('before the moment, or with no publish, nothing changes', () => {
  it('one millisecond before: no switch, and the pages are the pre-moment pages', () => {
    for (const entry of UPCOMING) {
      expect(legalEntrySwitched(entry, PUBLISHED, MOMENT - 1)).toBe(false);
    }
    const current = resolveLegalView('vendor-terms', undefined, announced, UPCOMING, false)!;
    expect(current.doc.frontmatter.version).toBe('1.3');
    expect(current.announcements.map((a) => a.version)).toEqual(['1.4']);
    expect(
      resolveLegalView('vendor-terms', '1.4', announced, UPCOMING, false)!.doc.effectiveOn,
    ).toBe(DAY);
    expect(legalVersionsInForce(PUBLISHED, MOMENT - 1, MAPS_ANNOUNCED)).toEqual({
      agreements: { vendor_terms: '1.3', managed_plan: '1.1' },
      policies: { listing_accuracy: '1.0', review_guidelines: '1.0' },
    });
    expect(nextLegalEffectiveMomentMs(MOMENT - 1, UPCOMING)).toBe(MOMENT);
  });

  it('an unpublished agreement never switches; the policy switches on its date', () => {
    const vt = UPCOMING[0]!;
    const la = UPCOMING[1]!;
    expect(legalEntrySwitched(vt, [], MOMENT + 365 * 86_400_000)).toBe(false);
    expect(legalEntrySwitched(la, [], MOMENT)).toBe(true);
    expect(legalVersionsInForce([], MOMENT, MAPS_ANNOUNCED).agreements.vendor_terms).toBe('1.3');
  });
});
