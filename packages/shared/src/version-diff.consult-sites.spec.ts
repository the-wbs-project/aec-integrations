/**
 * §9.3's structural invariant: **`canViewVersionDiff` has exactly TWO consult sites
 * repo-wide** (AECI-303 AC5 / AECI-304 / `docs/STAGE_2_ATTESTATIONS_SPEC.md` §9.3).
 *
 * This is an INVARIANT test — it encodes a decision, not behaviour, and must not be
 * deleted without reopening the spec.
 *
 * The point of the rule is auditability. `STAGE_2_SPEC.md` §2.2 requires entitlements
 * to be "data, not code branches scattered across the app", and the failure mode it
 * guards against is real: a third consult somewhere in the render path is how a
 * paywall silently starts covering the LATEST view, which §8.1(4) says must always be
 * free and full-fidelity. Two sites can be re-read in a minute; five cannot.
 *
 * The two are `resolveDiffAccess` (`apps/api/src/lib/pair-version-diff.ts` — a
 * deliberate wrapper, because both the pair read and the timeline read need the
 * answer and two direct calls would make three sites) and the web pair resolver's
 * `gateHistoricalDepth`.
 *
 * Matched on the CALL form `canViewVersionDiff(`, not the bare identifier: several
 * modules legitimately name the seam in prose (`drizzle-helpers.ts`,
 * `routes/integrations.ts`), and a doc comment referring to it is not a consult.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = packages/shared. */
const REPO_ROOT = join(process.cwd(), '..', '..');

/** Every source tree that could reach the seam. */
const SCANNED_TREES = [
  join('apps', 'api', 'src'),
  join('apps', 'web', 'src'),
  join('packages', 'shared', 'src'),
] as const;

/** The seam's own definition — not a consult. */
const DEFINITION = join('packages', 'shared', 'src', 'version-diff.ts');

/** A call, not a mention. */
const CONSULT = /canViewVersionDiff\s*\(/;

/** The sanctioned two, as repo-relative POSIX paths. */
const SANCTIONED = [
  'apps/api/src/lib/pair-version-diff.ts',
  'apps/web/src/app/products/products-pair.resolver.ts',
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    // Specs exercise the seam by design; the rule is about shipped source.
    if (entry.name.endsWith('.spec.ts')) continue;
    out.push(full);
  }
  return out;
}

const SOURCE_FILES = SCANNED_TREES.flatMap((tree) => walk(join(REPO_ROOT, tree))).filter(
  (file) => relative(REPO_ROOT, file) !== DEFINITION,
);

describe('§9.3 — the entitlement seam has exactly two consult sites', () => {
  it('scans a non-empty tree (guards against a walk that silently found nothing)', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(100);
  });

  it('is consulted only by the API wrapper and the web pair resolver', () => {
    const consultSites = SOURCE_FILES.filter((file) =>
      CONSULT.test(readFileSync(file, 'utf8')),
    ).map((file) => relative(REPO_ROOT, file).split(sep).join('/'));

    expect(
      consultSites.sort(),
      'canViewVersionDiff must be consulted in exactly two places (STAGE_2_ATTESTATIONS_SPEC.md ' +
        '§9.3 / AECI-303 AC5). A third consult is how a paywall starts leaking onto the LATEST ' +
        'view, which §8.1(4) requires to stay free and full-fidelity. Route new callers through ' +
        '`resolveDiffAccess` (apps/api) or `gateHistoricalDepth` (apps/web) instead.',
    ).toEqual([...SANCTIONED].sort());
  });

  it('the match would actually catch a violation (guards against a vacuous regex)', () => {
    expect(CONSULT.test('const a = canViewVersionDiff({ historical, pairVendorTiers: [] });')).toBe(
      true,
    );
    // A doc comment naming the seam is not a consult.
    expect(
      CONSULT.test(' * routed through `resolveDiffAccess` rather than canViewVersionDiff'),
    ).toBe(false);
  });
});
