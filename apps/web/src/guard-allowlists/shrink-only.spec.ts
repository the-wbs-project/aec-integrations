import { describe, expect, it } from 'vitest';

import {
  checkShrinkOnly,
  formatAllowlist,
  portalAdminSources,
  stripComments,
} from './shrink-only.harness';

/** AECI-2083: the allowlist rules every portal and admin guard shares. */
describe('shrink-only allowlist rules (AECI-2083)', () => {
  const counts = new Map([
    ['admin/a.html', 2],
    ['vendor/b.ts', 1],
  ]);

  it('passes when every count equals its line, and comments are ignored', () => {
    expect(checkShrinkOnly(counts, '# header\n\nadmin/a.html 2\nvendor/b.ts 1\n')).toEqual([]);
  });

  it('fails on a raised count, an unlisted file, a lowered count and a zero', () => {
    expect(checkShrinkOnly(new Map([['admin/a.html', 3]]), 'admin/a.html 2')).toEqual([
      'admin/a.html: 3 found, 2 allowed (new offender)',
    ]);
    expect(checkShrinkOnly(counts, 'admin/a.html 2')).toEqual([
      'vendor/b.ts: 1 found, 0 allowed (new offender)',
    ]);
    expect(checkShrinkOnly(new Map([['admin/a.html', 1]]), 'admin/a.html 2')).toEqual([
      'admin/a.html: now 1, lower its line from 2',
    ]);
    expect(checkShrinkOnly(new Map(), 'admin/a.html 2')).toEqual([
      'admin/a.html: now 0, delete its line (stale entry)',
    ]);
  });

  it('fails on a malformed, unsorted, duplicated or out-of-folder line', () => {
    expect(checkShrinkOnly(new Map(), 'admin/a.html')[0]).toMatch(/not "<path> <count>"/);
    expect(checkShrinkOnly(new Map(), 'admin/a.html 0')[0]).toMatch(/count of 1 or more/);
    expect(checkShrinkOnly(counts, 'vendor/b.ts 1\nadmin/a.html 2')).toEqual([
      'allowlist line 2: admin/a.html is out of order (it sorts before vendor/b.ts)',
    ]);
    expect(checkShrinkOnly(counts, 'admin/a.html 2\nadmin/a.html 2\nvendor/b.ts 1')).toEqual([
      'allowlist line 2: admin/a.html is listed twice',
    ]);
    expect(checkShrinkOnly(new Map([['home/x.ts', 1]]), 'home/x.ts 1')).toEqual([
      'allowlist line 1: home/x.ts is outside admin/ and vendor/',
    ]);
  });

  it('formats one sorted line per file', () => {
    expect(
      formatAllowlist(
        new Map([
          ['vendor/b.ts', 1],
          ['admin/a.html', 2],
        ]),
      ),
    ).toBe('admin/a.html 2\nvendor/b.ts 1');
  });

  it('blanks comments and keeps line numbers', () => {
    const src = 'a\n<!-- <svg>\n</svg> -->\n/* <button> */\n  // <svg>\nb';
    const out = stripComments(src);
    expect(out.split('\n')).toHaveLength(6);
    expect(out).not.toMatch(/svg|button/);
    expect(out.split('\n')[5]).toBe('b');
  });

  it('does not read a glob in a string as a comment', () => {
    const src = '<input accept="image/*" />\n<button type="button">A</button>\n/* x */';
    expect(stripComments(src)).toContain('<button type="button">');
  });

  it('reads both folders, and no spec files', () => {
    const files = portalAdminSources();
    expect(files.some((f) => f.startsWith('admin/'))).toBe(true);
    expect(files.some((f) => f.startsWith('vendor/'))).toBe(true);
    expect(files.filter((f) => f.endsWith('.spec.ts'))).toEqual([]);
  });
});
