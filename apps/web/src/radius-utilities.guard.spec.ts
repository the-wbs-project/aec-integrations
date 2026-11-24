import { describe, expect, it } from 'vitest';

import {
  MIN_FILES,
  checkShrinkOnly,
  countPerFile,
  countSource,
  filesByFolder,
  portalAdminSources,
  readAllowlist,
  stripComments,
} from './guard-allowlists/shrink-only.harness';

/**
 * AECI-2083: the old radius utilities in the vendor portal and the admin console only
 * shrink. The redesign set five radius tokens (`DESIGN.md` §4 "Radius"): mark, control,
 * panel, card and pill. The old ones are the `--radius-sm|md|lg` arbitrary values,
 * Tailwind's own `rounded-sm|md|lg|xl`, and any arbitrary `rounded-[…]`, each with any
 * variant prefix and on any side or corner (`rounded-e-(--radius-sm)`, `rounded-t-lg`,
 * `rounded-tl-md`). An arbitrary value under `admin/charts/` is exempt: the hand-rolled
 * SVG charts draw their bars at a 2px corner. The count is every occurrence in a file,
 * comments aside, against `guard-allowlists/radius-utilities.txt` (rules in
 * `guard-allowlists/shrink-only.harness.ts`).
 */

const OLD_RADIUS =
  /(?<![\w-])(?:[a-z0-9-]+:)*rounded(?:-(?:ss|se|es|ee|tl|tr|bl|br|ts|te|bs|be|[setblrxy]))?-(?:\(--radius-(?:sm|md|lg)\)|(?:sm|md|lg|xl)(?![\w-])|\[[^\]\s]+\])/g;

const CHARTS = /^admin\/charts\//;

/** Old radius utilities in one portal or admin file. */
export function oldRadiusCount(rel: string, src: string): number {
  return [...stripComments(src).matchAll(OLD_RADIUS)].filter(
    (m) => !(CHARTS.test(rel) && m[0].includes('[')),
  ).length;
}

describe('portal and admin old radius utilities only shrink (AECI-2083)', () => {
  const files = portalAdminSources();
  const counts = countPerFile(files, oldRadiusCount);

  it('matches guard-allowlists/radius-utilities.txt', () => {
    expect(checkShrinkOnly(counts, readAllowlist('radius-utilities'))).toEqual([]);
  });

  it('reads both folders, so it cannot pass on an empty scan', () => {
    const perFolder = filesByFolder(files);
    expect(perFolder['admin']).toBeGreaterThan(MIN_FILES.admin);
    expect(perFolder['vendor']).toBeGreaterThan(MIN_FILES.vendor);
  });

  it('counts the old utilities on every side and corner, and passes the new tokens', () => {
    const src = [
      `<div class="rounded-(--radius-md) border md:rounded-lg">A</div>`,
      `const X = 'rounded-sm rounded-xl hover:rounded-md';`,
      `<div class="rounded-t-lg rounded-e-(--radius-sm) rounded-tl-md rounded-r-[4px]">B</div>`,
      `<div class="rounded-[2px]">C</div>`,
      `<div class="rounded-card rounded-control rounded-full rounded-lg-ish rounded-t-card">D</div>`,
      `<div class="rounded-(--radius-card) rounded-xl2 rounded-s-full">E</div>`,
      `/* rounded-lg in a comment */`,
    ].join('\n');
    expect(oldRadiusCount('vendor/x.ts', src)).toBe(10);
  });

  it('exempts an arbitrary value under admin/charts/ only', () => {
    const src = `<rect class="rounded-[2px]" /><div class="rounded-lg"></div>`;
    expect(oldRadiusCount('admin/charts/x.ts', src)).toBe(1);
    expect(oldRadiusCount('admin/overview/x.ts', src)).toBe(2);
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
