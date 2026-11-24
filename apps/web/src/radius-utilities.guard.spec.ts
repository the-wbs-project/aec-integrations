import { describe, expect, it } from 'vitest';

import {
  checkShrinkOnly,
  countPerFile,
  countSource,
  portalAdminSources,
  readAllowlist,
  stripComments,
  totalsByFolder,
} from './guard-allowlists/shrink-only.harness';

/**
 * AECI-2083: the old radius utilities in the vendor portal and the admin console only
 * shrink. The redesign set five radius tokens (`DESIGN.md` §4 "Radius"): mark, control,
 * panel, card and pill. The old ones are the `--radius-sm|md|lg` arbitrary values and
 * Tailwind's own `rounded-sm|md|lg|xl`, with any variant prefix. The count is every
 * occurrence in a file, comments aside, against `guard-allowlists/radius-utilities.txt`
 * (rules in `guard-allowlists/shrink-only.harness.ts`).
 */

const OLD_RADIUS =
  /(?<![\w-])(?:[a-z0-9-]+:)*rounded-(?:\(--radius-(?:sm|md|lg)\)|(?:sm|md|lg|xl)(?![\w-]))/g;

/** Old radius utilities in one portal or admin file. */
export function oldRadiusCount(_rel: string, src: string): number {
  return [...stripComments(src).matchAll(OLD_RADIUS)].length;
}

describe('portal and admin old radius utilities only shrink (AECI-2083)', () => {
  const counts = countPerFile(portalAdminSources(), oldRadiusCount);

  it('matches guard-allowlists/radius-utilities.txt', () => {
    expect(checkShrinkOnly(counts, readAllowlist('radius-utilities'))).toEqual([]);
  });

  it('still finds offenders in both folders, so the scan is reading', () => {
    const totals = totalsByFolder(counts);
    expect(totals['admin']).toBeGreaterThan(0);
    expect(totals['vendor']).toBeGreaterThan(0);
  });

  it('counts the old utilities and passes the new tokens', () => {
    const src = [
      `<div class="rounded-(--radius-md) border md:rounded-lg">A</div>`,
      `const X = 'rounded-sm rounded-xl hover:rounded-md';`,
      `<div class="rounded-card rounded-control rounded-full rounded-lg-ish rounded-t-lg">B</div>`,
      `<div class="rounded-(--radius-card) rounded-xl2">C</div>`,
      `/* rounded-lg in a comment */`,
    ].join('\n');
    expect(oldRadiusCount('vendor/x.ts', src)).toBe(5);
  });

  it('fails on a new offender and on a stale entry', () => {
    const rel = 'vendor/x.ts';
    const offender = countSource(oldRadiusCount, rel, `<div class="rounded-lg">A</div>`);
    expect(checkShrinkOnly(offender, '')).toEqual([`${rel}: 1 found, 0 allowed (new offender)`]);
    const fixed = countSource(oldRadiusCount, rel, `<div class="rounded-card">A</div>`);
    expect(checkShrinkOnly(fixed, `${rel} 1`)).toEqual([
      `${rel}: now 0, delete its line (stale entry)`,
    ]);
  });
});
