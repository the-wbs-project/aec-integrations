import { describe, expect, it } from 'vitest';

import { AEC_ICONS } from './app/shared/icon/icon-registry';
import {
  MIN_FILES,
  countPerFile,
  countSource,
  filesByFolder,
  portalAdminSources,
  stripComments,
} from './guard-allowlists/shrink-only.harness';

/**
 * AECI-2083: no inline icon `<svg>` in the vendor portal or the admin console. Every UI
 * icon renders through `aec-icon` (`DESIGN.md` §5 "Icons"), and since AECI-2083 the
 * registry holds every glyph these two folders drew inline. The count is every `<svg` in
 * a file, comments aside. `admin/charts/` is not read: its hand-rolled SVG charts are
 * data, not icons.
 *
 * AECI-2132: the last offender (`vendor-contest-form.ts`) moved to `aec-icon`, so its
 * shrink-only allowlist emptied and `guard-allowlists/inline-icon-svg.txt` was deleted.
 * Both folders now hold zero, with no exceptions (the heading guard's pattern, AECI-1729).
 */

const SKIP = /^admin\/charts(\/|$)/;

/** Inline `<svg>` elements in one portal or admin file. */
export function inlineSvgCount(_rel: string, src: string): number {
  return [...stripComments(src).matchAll(/<svg\b/g)].length;
}

describe('portal and admin draw no inline icon svg (AECI-2083, AECI-2132)', () => {
  const files = portalAdminSources(SKIP);
  const counts = countPerFile(files, inlineSvgCount);

  it('finds none in the portal or the console (no exceptions)', () => {
    expect([...counts]).toEqual([]);
  });

  it('reads both folders, so it cannot pass on an empty scan, and never admin/charts', () => {
    const perFolder = filesByFolder(files);
    expect(perFolder['admin']).toBeGreaterThan(MIN_FILES.admin);
    expect(perFolder['vendor']).toBeGreaterThan(MIN_FILES.vendor);
    expect(files.filter((p) => SKIP.test(p))).toEqual([]);
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

  it('counts a new offender, so the no-exceptions check fails on it', () => {
    const rel = 'admin/x.html';
    expect([...countSource(inlineSvgCount, rel, `<svg viewBox="0 0 24 24"></svg>`)]).toEqual([
      [rel, 1],
    ]);
    expect([...countSource(inlineSvgCount, rel, `<aec-icon name="x" decorative />`)]).toEqual([]);
  });
});
