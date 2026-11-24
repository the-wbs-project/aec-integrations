import { describe, expect, it } from 'vitest';

import { AEC_ICONS } from './app/shared/icon/icon-registry';
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
 * AECI-2083: inline icon `<svg>` elements in the vendor portal and the admin console
 * only shrink. Every UI icon renders through `aec-icon` (`DESIGN.md` §5 "Icons"), and
 * since AECI-2083 the registry holds every glyph these two folders draw inline. The
 * count is every `<svg` in a file, comments aside, against
 * `guard-allowlists/inline-icon-svg.txt` (rules in `guard-allowlists/shrink-only.harness.ts`).
 * `admin/charts/` is not read: its hand-rolled SVG charts are data, not icons.
 */

const SKIP = /^admin\/charts(\/|$)/;

/** Inline `<svg>` elements in one portal or admin file. */
export function inlineSvgCount(_rel: string, src: string): number {
  return [...stripComments(src).matchAll(/<svg\b/g)].length;
}

describe('portal and admin inline icon svg only shrinks (AECI-2083)', () => {
  const counts = countPerFile(portalAdminSources(SKIP), inlineSvgCount);

  it('matches guard-allowlists/inline-icon-svg.txt', () => {
    expect(checkShrinkOnly(counts, readAllowlist('inline-icon-svg'))).toEqual([]);
  });

  it('still finds offenders in both folders, and never reads admin/charts', () => {
    const totals = totalsByFolder(counts);
    expect(totals['admin']).toBeGreaterThan(0);
    expect(totals['vendor']).toBeGreaterThan(0);
    expect([...counts.keys()].filter((p) => SKIP.test(p))).toEqual([]);
  });

  it('holds the two glyphs the portal drew that the registry lacked', () => {
    expect(Object.keys(AEC_ICONS)).toEqual(expect.arrayContaining(['check-circle', 'exclamation']));
  });

  it('counts each svg element, and skips comments and aec-icon', () => {
    const src = [
      `<svg class="size-4" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6" /></svg>`,
      `<svg\n  aria-hidden="true"\n  viewBox="0 0 24 24"\n></svg>`,
      `<aec-icon name="check" decorative />`,
      `<!-- <svg viewBox="0 0 24 24"></svg> -->`,
      `/** An inline <svg> was here. */`,
    ].join('\n');
    expect(inlineSvgCount('vendor/x.ts', src)).toBe(2);
  });

  it('fails on a new offender and on a stale entry', () => {
    const rel = 'admin/x.html';
    const offender = countSource(inlineSvgCount, rel, `<svg viewBox="0 0 24 24"></svg>`);
    expect(checkShrinkOnly(offender, '')).toEqual([`${rel}: 1 found, 0 allowed (new offender)`]);
    const fixed = countSource(inlineSvgCount, rel, `<aec-icon name="x" decorative />`);
    expect(checkShrinkOnly(fixed, `${rel} 1`)).toEqual([
      `${rel}: now 0, delete its line (stale entry)`,
    ]);
  });
});
