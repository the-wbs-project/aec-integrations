/**
 * Coverage for the version-diff rules (AECI-303 / §9.1, §9.3).
 *
 * The headline case this file exists for: **a claim with no version stamps is
 * always present**. Every claim promote has ever written is unstamped, so if that
 * rule regresses the entire catalog's pair pages go blank — and no other test in
 * the repo would notice.
 */

import { describe, expect, it } from 'vitest';

import { TIERS, hasCapability } from './entitlements';
import {
  VERSION_DIFF_ACCESS,
  VERSION_STATUSES,
  canViewVersionDiff,
  claimVersionStatus,
  isClaimPresentAt,
  previousVersion,
  previousVersionPair,
  vendorTiersFromMirror,
  type ClaimVersionWindow,
  type VersionDiffRequest,
  type VersionPairSelection,
} from './version-diff';
import { deriveVersionSortKey, type ComparableProductVersion } from './version-sort';

/**
 * A version row reduced to what ordering reads. `sortKey` derived from the label
 * so the fixtures exercise the real packing rather than hand-picked integers.
 */
function v(label: string, createdAt = '2026-01-01T00:00:00.000Z'): ComparableProductVersion {
  return { sortKey: deriveVersionSortKey(label), createdAt, id: label };
}

/** A window on one side, with either bound optional. */
function window_(
  side: 'context' | 'other',
  introduced: ComparableProductVersion | null,
  deprecated: ComparableProductVersion | null = null,
): ClaimVersionWindow {
  return { side, introduced, deprecated };
}

function at(
  context: ComparableProductVersion | null,
  other: ComparableProductVersion | null = null,
): VersionPairSelection {
  return { context, other };
}

// The context product's release line, ascending. `2026.9` before `2026.10` is the
// lexical trap, kept in the fixture so the diff inherits the AECI-607 guarantee.
const CTX = [v('2026.1'), v('2026.9'), v('2026.10')];
// The other product's line. Deliberately a different label scheme, because
// `sort_key` is per-product and comparing across the two is meaningless.
const OTH = [v('v4'), v('v5'), v('v6')];

describe('isClaimPresentAt', () => {
  it('is present with NO windows — the Stage 1.5 baseline that must never regress', () => {
    expect(isClaimPresentAt([], at(CTX[2]!, OTH[2]!))).toBe(true);
    // …and at every other selection, including the earliest.
    expect(isClaimPresentAt([], at(CTX[0]!, OTH[0]!))).toBe(true);
    expect(isClaimPresentAt([], at(null, null))).toBe(true);
  });

  it('treats `introduced` as inclusive — a flow introduced IN a version is in it', () => {
    const w = [window_('context', CTX[1]!)];
    expect(isClaimPresentAt(w, at(CTX[1]!))).toBe(true);
    expect(isClaimPresentAt(w, at(CTX[2]!))).toBe(true);
    expect(isClaimPresentAt(w, at(CTX[0]!))).toBe(false);
  });

  it('treats `deprecated` as strict — a flow deprecated IN a version is gone FROM it', () => {
    const w = [window_('context', null, CTX[1]!)];
    expect(isClaimPresentAt(w, at(CTX[0]!))).toBe(true);
    expect(isClaimPresentAt(w, at(CTX[1]!))).toBe(false);
    expect(isClaimPresentAt(w, at(CTX[2]!))).toBe(false);
  });

  it('leaves an open `deprecated` bound present at the latest version', () => {
    expect(isClaimPresentAt([window_('context', CTX[0]!, null)], at(CTX[2]!))).toBe(true);
  });

  it('conjoins the two sides — either side excluding is enough to exclude', () => {
    const w = [window_('context', CTX[0]!), window_('other', OTH[2]!)];
    expect(isClaimPresentAt(w, at(CTX[2]!, OTH[2]!))).toBe(true);
    // The other side has not introduced it yet.
    expect(isClaimPresentAt(w, at(CTX[2]!, OTH[1]!))).toBe(false);
  });

  it('evaluates each window against its OWN side, never the opposite one', () => {
    // Stamped on `other` only. Walking the CONTEXT selector must not move it.
    const w = [window_('other', OTH[2]!)];
    expect(isClaimPresentAt(w, at(CTX[0]!, OTH[2]!))).toBe(true);
    expect(isClaimPresentAt(w, at(CTX[2]!, OTH[0]!))).toBe(false);
  });

  it('is vacuously present on a side with no selected version', () => {
    // The product has no releases at all, so a stamp against it cannot exist.
    expect(isClaimPresentAt([window_('other', OTH[2]!)], at(CTX[2]!, null))).toBe(true);
  });

  it('respects the 2026.9 < 2026.10 ordering rather than the lexical one', () => {
    // Introduced in 2026.10: present there, absent in 2026.9. A lexical compare
    // would invert both.
    const w = [window_('context', CTX[2]!)];
    expect(isClaimPresentAt(w, at(CTX[2]!))).toBe(true);
    expect(isClaimPresentAt(w, at(CTX[1]!))).toBe(false);
  });
});

describe('previousVersion', () => {
  it('steps back one release from the middle of the list', () => {
    expect(previousVersion(CTX, CTX[1]!)?.id).toBe('2026.1');
    expect(previousVersion(CTX, CTX[2]!)?.id).toBe('2026.9');
  });

  it('is null at the earliest version, on a single-element list, and for null', () => {
    expect(previousVersion(CTX, CTX[0]!)).toBeNull();
    expect(previousVersion([CTX[0]!], CTX[0]!)).toBeNull();
    expect(previousVersion(CTX, null)).toBeNull();
  });

  it('is null for a version absent from the list', () => {
    expect(previousVersion(CTX, v('2099.1'))).toBeNull();
  });

  it('resolves identity by id, so a copied row still steps back', () => {
    const copy = { ...CTX[1]! };
    expect(previousVersion(CTX, copy)?.id).toBe('2026.1');
  });

  it('steps back through a sort_key TIE using created_at, never the label', () => {
    // Two digit-free labels both derive 0, so the tie is real. Ascending order is
    // whatever `compareProductVersions` says — created_at, then id.
    const early = { sortKey: 0, createdAt: '2026-01-01T00:00:00.000Z', id: 'zzz-lts' };
    const late = { sortKey: 0, createdAt: '2026-06-01T00:00:00.000Z', id: 'aaa-fall' };
    // A label sort would put 'aaa-fall' first; insertion order puts 'zzz-lts' first.
    expect(previousVersion([early, late], late)?.id).toBe('zzz-lts');
  });
});

describe('previousVersionPair', () => {
  it('steps BOTH sides back one release when both can', () => {
    const previous = previousVersionPair(CTX, CTX[2]!, OTH, OTH[2]!);
    expect(previous?.context?.id).toBe('2026.9');
    expect(previous?.other?.id).toBe('v5');
  });

  it('holds the side that cannot step back', () => {
    const previous = previousVersionPair(CTX, CTX[2]!, OTH, OTH[0]!);
    expect(previous?.context?.id).toBe('2026.9');
    // `other` is already the earliest, so it stays put rather than going null.
    expect(previous?.other?.id).toBe('v4');
  });

  it('is null when NEITHER side has a predecessor — the baseline pair', () => {
    expect(previousVersionPair(CTX, CTX[0]!, OTH, OTH[0]!)).toBeNull();
  });

  it('is null when neither side has a selection at all', () => {
    expect(previousVersionPair(CTX, null, OTH, null)).toBeNull();
  });

  it('is symmetric under swapping which product is the context', () => {
    // The same pair viewed from either URL must measure against the same
    // releases, or one page would show a diff the other does not.
    const fromContext = previousVersionPair(CTX, CTX[2]!, OTH, OTH[2]!);
    const fromOther = previousVersionPair(OTH, OTH[2]!, CTX, CTX[2]!);
    expect(fromContext?.context?.id).toBe(fromOther?.other?.id);
    expect(fromContext?.other?.id).toBe(fromOther?.context?.id);
  });
});

describe('claimVersionStatus', () => {
  const selected = at(CTX[2]!, OTH[2]!);
  const previous = at(CTX[1]!, OTH[1]!);

  it('is `added` when present now and absent before', () => {
    // Introduced in 2026.10, the selected version.
    const w = [window_('context', CTX[2]!)];
    expect(claimVersionStatus(w, selected, previous)).toBe('added');
  });

  it('is `removed` when absent now and present before', () => {
    // Deprecated in 2026.10, so gone from it but present in 2026.9.
    const w = [window_('context', null, CTX[2]!)];
    expect(claimVersionStatus(w, selected, previous)).toBe('removed');
  });

  it('is `unchanged` when present at both — the majority case', () => {
    expect(claimVersionStatus([], selected, previous)).toBe('unchanged');
    expect(claimVersionStatus([window_('context', CTX[0]!)], selected, previous)).toBe('unchanged');
  });

  it('is `unchanged` when absent at BOTH — the caller must drop the claim', () => {
    // Deprecated back in 2026.1, so it belongs to an earlier era entirely.
    const w = [window_('context', null, CTX[0]!)];
    expect(claimVersionStatus(w, selected, previous)).toBe('unchanged');
    // The caller's own test for dropping it: present at neither pair.
    expect(isClaimPresentAt(w, selected)).toBe(false);
    expect(isClaimPresentAt(w, previous)).toBe(false);
  });

  it('is `unchanged` for every claim when there is no previous pair', () => {
    // The earliest version pair is a baseline, not a wave of additions.
    const w = [window_('context', CTX[0]!)];
    expect(claimVersionStatus(w, at(CTX[0]!, OTH[0]!), null)).toBe('unchanged');
  });

  it('only ever returns a declared status', () => {
    const w = [window_('context', CTX[2]!)];
    expect(VERSION_STATUSES).toContain(claimVersionStatus(w, selected, previous));
  });
});

describe('vendorTiersFromMirror', () => {
  it('maps the `vendors.verified` mirror onto the tier ladder', () => {
    expect(vendorTiersFromMirror([{ verified: true }, { verified: false }])).toEqual([
      'verified',
      'unclaimed',
    ]);
  });

  it('is fail-closed for an endpoint with no vendor at all', () => {
    // A product with no vendor link contributes `unclaimed`, so the array is always
    // the pair's two sides and `.some(…)` reads as "either vendor pays".
    expect(vendorTiersFromMirror([null, undefined])).toEqual(['unclaimed', 'unclaimed']);
  });

  it('only ever emits tiers the registry knows', () => {
    for (const tier of vendorTiersFromMirror([{ verified: true }, null])) {
      expect(TIERS).toContain(tier);
    }
  });
});

describe('canViewVersionDiff', () => {
  it('is `full` for a non-historical request regardless of tier — the §8.1(4) guard', () => {
    // THE reader invariant: the latest-version view is always free and
    // full-fidelity, and the `!historical` early return runs BEFORE any entitlement
    // is consulted. These two lines must never be reordered.
    expect(canViewVersionDiff({ historical: false, pairVendorTiers: [] })).toBe('full');
    expect(
      canViewVersionDiff({ historical: false, pairVendorTiers: ['unclaimed', 'unclaimed'] }),
    ).toBe('full');
  });

  it('is `latest_only` when neither of the pair’s vendors is entitled', () => {
    expect(
      canViewVersionDiff({ historical: true, pairVendorTiers: ['unclaimed', 'unclaimed'] }),
    ).toBe('latest_only');
  });

  it('is `full` when ONE of the pair’s vendors is entitled — either side opens it', () => {
    expect(
      canViewVersionDiff({ historical: true, pairVendorTiers: ['verified', 'unclaimed'] }),
    ).toBe('full');
    expect(
      canViewVersionDiff({ historical: true, pairVendorTiers: ['unclaimed', 'verified'] }),
    ).toBe('full');
  });

  it('is `full` when BOTH of the pair’s vendors are entitled', () => {
    expect(
      canViewVersionDiff({ historical: true, pairVendorTiers: ['verified', 'verified'] }),
    ).toBe('full');
  });

  it('is `latest_only` for a pair with no vendors at all — fail closed', () => {
    expect(canViewVersionDiff({ historical: true, pairVendorTiers: [] })).toBe('latest_only');
  });

  it('asks the registry rather than testing the tier id, so a new rung stays data-only', () => {
    // The gate is `hasCapability(tier, 'integration.version_diff')`, never
    // `tier === 'verified'`. Proving it through the registry is what keeps
    // `STAGE_2_PAID_TIERS_SPEC.md` §3.1's "adding a rung is a data edit" true.
    for (const tier of TIERS) {
      expect(canViewVersionDiff({ historical: true, pairVendorTiers: [tier] })).toBe(
        hasCapability(tier, 'integration.version_diff') ? 'full' : 'latest_only',
      );
    }
  });

  it('never gates on the reader — the request carries no viewer axis at all', () => {
    // AECI-304 / §8.1(4): vendors pay, always. Viewer-pays is out of scope, and the
    // absence of a reader field is what keeps the answer URL-derived and the page
    // storable in the shared, URL-keyed edge cache.
    const request: VersionDiffRequest = { historical: true, pairVendorTiers: ['verified'] };
    expect(Object.keys(request).sort()).toEqual(['historical', 'pairVendorTiers']);
  });

  it('only ever returns a declared access level', () => {
    expect(VERSION_DIFF_ACCESS).toContain(
      canViewVersionDiff({ historical: true, pairVendorTiers: ['unclaimed'] }),
    );
  });
});
