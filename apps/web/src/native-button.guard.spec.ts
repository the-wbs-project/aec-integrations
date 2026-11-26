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
 * AECI-2083: hand-written `<button>` elements in the vendor portal and the admin console
 * only shrink. The shared button is the `aecButton` directive (`shared/button/button.ts`,
 * `DESIGN.md` §5 "Buttons"). The count is every `<button>` start tag in a file that does
 * not carry `aecButton`, comments aside, against `guard-allowlists/native-button.txt`
 * (rules in `guard-allowlists/shrink-only.harness.ts`). Some of these may stay native for
 * a reason (a tab, a switch, a disclosure). A slice that keeps one says why in the issue
 * and leaves its count on the line.
 */

/** `<button>` start tags without `aecButton` in one portal or admin file. */
export function nativeButtonCount(_rel: string, src: string): number {
  let n = 0;
  for (const m of stripComments(src).matchAll(/<button\b((?:[^>"]|"[^"]*")*)>/g)) {
    if (!/(?:^|\s)aecButton(?=[\s=>]|$)/.test(m[1]!)) n++;
  }
  return n;
}

describe('portal and admin buttons not on aecButton only shrink (AECI-2083)', () => {
  const files = portalAdminSources();
  const counts = countPerFile(files, nativeButtonCount);

  it('matches guard-allowlists/native-button.txt', () => {
    expect(checkShrinkOnly(counts, readAllowlist('native-button'))).toEqual([]);
  });

  it('reads both folders, so it cannot pass on an empty scan', () => {
    const perFolder = filesByFolder(files);
    expect(perFolder['admin']).toBeGreaterThan(MIN_FILES.admin);
    expect(perFolder['vendor']).toBeGreaterThan(MIN_FILES.vendor);
  });

  it('counts each button without aecButton, and skips comments', () => {
    const src = [
      `<button type="button" class="rounded border px-3">A</button>`,
      `<button\n  type="button"\n  aecButton\n  variant="secondary"\n>B</button>`,
      `<button aecButton="primary" type="submit">C</button>`,
      `<button type="button" [attr.data-x]="a > b">D</button>`,
      `<!-- <button type="button">a comment</button> -->`,
      `<a aecButton href="/x">E</a>`,
    ].join('\n');
    expect(nativeButtonCount('vendor/x.ts', src)).toBe(2);
  });

  it('fails on a new offender and on a stale entry', () => {
    const rel = 'vendor/x.ts';
    const offender = countSource(nativeButtonCount, rel, `<button type="button">A</button>`);
    expect(checkShrinkOnly(offender, '')).toEqual([`${rel}: 1 found, 0 allowed (new offender)`]);
    const fixed = countSource(nativeButtonCount, rel, `<button aecButton type="button">A</button>`);
    expect(checkShrinkOnly(fixed, `${rel} 1`)).toEqual([
      `${rel}: now 0, delete its line (stale entry)`,
    ]);
  });
});
