/**
 * Coverage for the pair version-selection plumbing (AECI-303 / §9).
 *
 * The rules themselves are proved in `packages/shared/src/version-diff.spec.ts`.
 * What this file guards is the *resolution*: which row a query param lands on, when
 * the diff applies at all, which side a stamp belongs to, and the gate's clamp.
 * All of it is pure, so none of it needs the D1 harness.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveDiffAccess,
  resolveVersionSelection,
  type ResolveVersionSelectionInput,
  type VersionRow,
} from './pair-version-diff';

const CONTEXT_PRODUCT = 'ctx-product';
const OTHER_PRODUCT = 'oth-product';

function row(
  id: string,
  productId: string,
  label: string,
  sortKey: number,
  releasedAt: string | null = null,
): VersionRow {
  return { id, productId, label, releasedAt, sortKey, createdAt: '2026-01-01T00:00:00.000Z' };
}

// Ascending, as `VERSION_ORDER` hands them over. 2026.9 before 2026.10.
const P1 = row('p1', CONTEXT_PRODUCT, '2026.1', 20_260_000_100_000);
const P9 = row('p9', CONTEXT_PRODUCT, '2026.9', 20_260_000_900_000);
const P10 = row('p10', CONTEXT_PRODUCT, '2026.10', 20_260_001_000_000);
const R4 = row('r4', OTHER_PRODUCT, 'v4', 40_000_000_000, '2026-01-15');
const R5 = row('r5', OTHER_PRODUCT, 'v5', 50_000_000_000);

const ALL = [P1, P9, P10, R4, R5];

/** May be `null` — for the cases that assert the diff does not apply. */
function resolveMaybe(overrides: Partial<ResolveVersionSelectionInput> = {}) {
  return resolveVersionSelection({
    versionRows: ALL,
    contextProductId: CONTEXT_PRODUCT,
    otherProductId: OTHER_PRODUCT,
    contextParam: undefined,
    otherParam: undefined,
    viewerTier: null,
    hasVersionStamps: true,
    ...overrides,
  });
}

/** For the cases where the diff applies — fails loudly if it does not. */
function resolve(overrides: Partial<ResolveVersionSelectionInput> = {}) {
  const resolved = resolveMaybe(overrides);
  if (resolved === null) throw new Error('expected the version diff to apply for this fixture');
  return resolved;
}

describe('resolveVersionSelection — when the diff applies', () => {
  it('is null when neither product has a release', () => {
    expect(resolveMaybe({ versionRows: [] })).toBeNull();
  });

  it('is null when releases exist but no attestation is stamped', () => {
    // Both products can have releases while nothing on THIS pair varies by them.
    // Selectors that cannot change anything are worse than no selectors.
    expect(resolveMaybe({ hasVersionStamps: false })).toBeNull();
  });

  it('applies when only ONE product has releases', () => {
    const resolved = resolve({ versionRows: [P1, P9, P10] });
    expect(resolved.diff.other_versions).toEqual([]);
    // The side with no releases has no selection, and is vacuously satisfied.
    expect(resolved.diff.selected.other).toBeNull();
    expect(resolved.selected.other).toBeNull();
  });
});

describe('resolveVersionSelection — label resolution', () => {
  it('defaults each side to its LATEST release', () => {
    // Latest is the greatest under the ordering, not the last-inserted and not the
    // newest `released_at` (which is nullable).
    expect(resolve().diff.selected).toEqual({ context: '2026.10', other: 'v5' });
  });

  it('matches an exact label', () => {
    expect(resolve({ contextParam: '2026.9' }).diff.selected.context).toBe('2026.9');
  });

  it('trims surrounding whitespace before matching', () => {
    expect(resolve({ contextParam: '  2026.9  ' }).diff.selected.context).toBe('2026.9');
  });

  it('degrades an unknown label to latest', () => {
    expect(resolve({ contextParam: 'nope' }).diff.selected.context).toBe('2026.10');
  });

  it('degrades an empty or whitespace-only param to latest', () => {
    expect(resolve({ contextParam: '' }).diff.selected.context).toBe('2026.10');
    expect(resolve({ contextParam: '   ' }).diff.selected.context).toBe('2026.10');
  });

  it('degrades an over-long param to latest without scanning for it', () => {
    // `label` is capped at 60 chars, so a longer value cannot match a row —
    // rejecting it early stops a hostile 10 KB param minting a junk cache entry.
    expect(resolve({ contextParam: 'x'.repeat(61) }).diff.selected.context).toBe('2026.10');
  });

  it('is case-SENSITIVE — the unique index has no NOCASE collation', () => {
    // A digit-free label derives sort_key 0, so it sorts FIRST. The rows arrive
    // already ordered by `VERSION_ORDER`, so the fixture must respect that — the
    // resolver reads "latest" as the last element rather than re-sorting.
    const rows = [row('pl', CONTEXT_PRODUCT, 'LTS', 0), ...ALL];
    expect(resolve({ versionRows: rows, contextParam: 'LTS' }).diff.selected.context).toBe('LTS');
    // A case-insensitive match could be ambiguous, and ambiguity here silently
    // shows the reader a different diff.
    expect(resolve({ versionRows: rows, contextParam: 'lts' }).diff.selected.context).toBe(
      '2026.10',
    );
  });

  it('resolves 2026.10 as latest, not 2026.9 — the lexical trap', () => {
    expect(resolve().diff.selected.context).toBe('2026.10');
  });
});

describe('resolveVersionSelection — is_default', () => {
  it('is true with no params', () => {
    expect(resolve().diff.is_default).toBe(true);
  });

  it('is true when the params happen to name the latest of each side', () => {
    expect(resolve({ contextParam: '2026.10', otherParam: 'v5' }).diff.is_default).toBe(true);
  });

  it('is false for a genuine historical selection', () => {
    expect(resolve({ contextParam: '2026.9' }).diff.is_default).toBe(false);
  });

  it('is true when a bogus label DEGRADED to latest', () => {
    // It follows the resolution, not the request: the page serves canonical content,
    // so the resolver must leave it indexable and let the query-stripped canonical
    // dedupe the URL.
    expect(resolve({ contextParam: 'nope' }).diff.is_default).toBe(true);
  });
});

describe('resolveVersionSelection — the previous version pair', () => {
  it('steps both sides back one release at latest × latest', () => {
    expect(resolve().diff.previous).toEqual({ context: '2026.9', other: 'v4' });
  });

  it('holds a side that cannot step back', () => {
    expect(resolve({ otherParam: 'v4' }).diff.previous).toEqual({
      context: '2026.9',
      other: 'v4',
    });
  });

  it('is null at the earliest pair on both sides', () => {
    expect(resolve({ contextParam: '2026.1', otherParam: 'v4' }).diff.previous).toBeNull();
  });
});

describe('resolveVersionSelection — the wire shape', () => {
  it('lists each product ascending, with the label and released_at only', () => {
    const diff = resolve().diff;
    expect(diff.context_versions).toEqual([
      { label: '2026.1', released_at: null },
      { label: '2026.9', released_at: null },
      { label: '2026.10', released_at: null },
    ]);
    // No `id`, no `sort_key`: the API resolved every comparison, so the browser has
    // nothing to compare — and exposing sort_key would invite it to.
    expect(diff.other_versions[0]).toEqual({ label: 'v4', released_at: '2026-01-15' });
  });

  it('leaves counts at zero for the mapper to fill', () => {
    // Only the mapper has seen the claims.
    expect(resolve().diff.counts).toEqual({ added: 0, removed: 0 });
  });
});

describe('resolveVersionSelection — versionLabel', () => {
  it('resolves an id on either side to its label', () => {
    const resolved = resolve();
    expect(resolved.versionLabel('p9')).toBe('2026.9');
    expect(resolved.versionLabel('r4')).toBe('v4');
  });

  it('is undefined for null and for an unresolvable id', () => {
    // Absent, never `null` — that is what keeps an unstamped attestation
    // serialising exactly as it did before AECI-303.
    const resolved = resolve();
    expect(resolved.versionLabel(null)).toBeUndefined();
    expect(resolved.versionLabel('deleted-version')).toBeUndefined();
  });
});

describe('resolveVersionSelection — claimWindows', () => {
  const resolved = () => resolve();

  it('is empty for an unstamped attestation', () => {
    expect(
      resolved().claimWindows({ introducedVersionId: null, deprecatedVersionId: null }),
    ).toEqual([]);
  });

  it('derives the side from the stamped PRODUCT, not the attestation slot', () => {
    // No `aeci`-slot special case is needed, and the rule keeps working if §8.2's
    // authority boundary ever widens.
    expect(
      resolved().claimWindows({ introducedVersionId: 'p1', deprecatedVersionId: null }),
    ).toEqual([
      { side: 'context', introduced: expect.objectContaining({ id: 'p1' }), deprecated: null },
    ]);
    expect(
      resolved().claimWindows({ introducedVersionId: 'r4', deprecatedVersionId: null }),
    ).toEqual([
      { side: 'other', introduced: expect.objectContaining({ id: 'r4' }), deprecated: null },
    ]);
  });

  it('folds both bounds into ONE window when they share a side', () => {
    const windows = resolved().claimWindows({
      introducedVersionId: 'p1',
      deprecatedVersionId: 'p10',
    });
    expect(windows).toHaveLength(1);
    expect(windows[0]!.side).toBe('context');
    expect(windows[0]!.introduced?.id).toBe('p1');
    expect(windows[0]!.deprecated?.id).toBe('p10');
  });

  it('carries a lone deprecated bound with an open introduced bound', () => {
    const windows = resolved().claimWindows({
      introducedVersionId: null,
      deprecatedVersionId: 'p10',
    });
    expect(windows).toEqual([
      { side: 'context', introduced: null, deprecated: expect.objectContaining({ id: 'p10' }) },
    ]);
  });

  it('IGNORES an unresolvable id, keeping the claim on the always-present baseline', () => {
    // Reachable when `ON DELETE SET NULL` has degraded a stamp. Fail-open toward
    // present: the alternative is silently hiding a real flow.
    expect(
      resolved().claimWindows({ introducedVersionId: 'deleted', deprecatedVersionId: null }),
    ).toEqual([]);
  });

  it('splits two bounds that land on DIFFERENT sides into one window each', () => {
    // Impossible under §8.2 (`resolveVersionStamps` rejects a stamp against the
    // counterparty's release history), but handled totally rather than throwing.
    const windows = resolved().claimWindows({
      introducedVersionId: 'p1',
      deprecatedVersionId: 'r5',
    });
    expect(windows).toEqual([
      { side: 'context', introduced: expect.objectContaining({ id: 'p1' }), deprecated: null },
      { side: 'other', introduced: null, deprecated: expect.objectContaining({ id: 'r5' }) },
    ]);
  });
});

describe('resolveDiffAccess — the single API consult of the seam', () => {
  it('is `full` for the latest view regardless of tier (§8.1(4))', () => {
    expect(resolveDiffAccess(false, null)).toBe('full');
    expect(resolveDiffAccess(false, 'unclaimed')).toBe('full');
  });

  it('is `full` for a historical view today — the seam defaults open (§9.3)', () => {
    expect(resolveDiffAccess(true, null)).toBe('full');
  });
});

describe('resolveVersionSelection — the gate clamp', () => {
  it('reports diff_access on the payload rather than branching', () => {
    // `STAGE_2_SPEC.md` §2.2: entitlements are data. The render path switches on
    // this one enum; nothing else in the response encodes the gate.
    expect(resolve({ contextParam: '2026.9' }).diff.diff_access).toBe('full');
  });

  it('treats any raw param as historical, before any degrade', () => {
    // A reader who typed a label is asking for history whether or not it resolves,
    // so the gate's input must not depend on catalog state it cannot see. With the
    // seam open today both answer `full`; the assertion pins the INPUT, which is
    // what AECI-304 will branch on.
    expect(resolve({ contextParam: 'nope' }).diff.diff_access).toBe('full');
    expect(resolve({ contextParam: 'nope' }).diff.is_default).toBe(true);
  });
});
