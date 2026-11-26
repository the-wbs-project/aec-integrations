import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  conditionalClasses,
  resolveBinding,
  scopeFor,
  type Scope,
} from './guard-allowlists/class-binding.harness';
import {
  MIN_FILES,
  checkUnreadable,
  countPerFile,
  countSource,
  filesByFolder,
  portalAdminSources,
  readSource,
  stripComments,
} from './guard-allowlists/shrink-only.harness';

/**
 * AECI-1847: the Unlayered-Heading Rule (`DESIGN.md` §3). The `h1`, `h2` and `h3`
 * rules in `styles.css` sit outside any `@layer` and set the family, weight, size,
 * line height and letter spacing. Tailwind's utilities are in `@layer utilities`, so
 * a size, weight, leading or tracking utility written on the heading element itself
 * never renders. This guard fails on one in public code, so the template says what
 * the page shows. To size a heading, put the utility on an inner `<span>`.
 *
 * What it reads: every `<h1>`, `<h2>` and `<h3>` in `src/app` outside `admin/`,
 * `vendor/` (the portal), `preview/`, `demo/` and `dev/`. It checks the static
 * `class="…"` and a `[class]="name"` binding whose `name` is a string literal in the
 * same component, directly or through one constant. A binding it cannot resolve (a
 * `computed()`, a concatenation, an import) is skipped, not guessed. It has no false
 * positive, because every listed utility on these three elements is dead.
 *
 * AECI-2083: `admin/` and `vendor/` are read too. They were on a shrink-only
 * allowlist until the redesign slices emptied it, and since AECI-1729 they hold the
 * public rule with no exceptions. Comments are not read there. An unreadable binding fails
 * until it is named in `PORTAL_ADMIN_UNREADABLE`, and a `[class.x]` binding counts its
 * class. The binding reader lives in `guard-allowlists/class-binding.harness.ts`.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/src
const APP_DIR = join(SRC_DIR, 'app');
const NOT_PUBLIC = /^(admin|vendor|preview|demo|dev)(\/|$)/;

/** Size, weight, leading and tracking utilities, with any variant prefix. */
const DEAD_UTILITY =
  /^(?:[a-z0-9-]+:)*(?:text-(?:xs|sm|base|lg|[2-9]?xl|t-[a-z0-9-]+|\[(?!--|#)[^\]]+\])|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[\d+\])|leading-\S+|tracking-\S+)$/;

function publicSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (NOT_PUBLIC.test(relative(APP_DIR, path))) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts')) out.push(path);
    }
  };
  walk(APP_DIR);
  return out;
}

export interface HeadingScan {
  scanned: number;
  found: string[];
  unresolved: string[];
}

export function deadHeadingUtilities(
  file: string,
  src: string,
  scope: Scope = { sources: [src], importFile: () => '' },
): HeadingScan {
  const scan: HeadingScan = { scanned: 0, found: [], unresolved: [] };
  for (const m of src.matchAll(/<(h[123])\b((?:[^>"]|"[^"]*")*)>/g)) {
    const [, tag, attrs] = m;
    scan.scanned++;
    const line = src.slice(0, m.index).split('\n').length;
    const classes: string[] = [];
    const stat = attrs!.match(/(?<![\w\].-])class="([^"]*)"/);
    if (stat) classes.push(stat[1]!);
    const bound = attrs!.match(/\[class\]="([^"]*)"/);
    if (bound) {
      const value = resolveBinding(bound[1]!, scope);
      if (value === null) scan.unresolved.push(`${file} <${tag}> [class]="${bound[1]}"`);
      else classes.push(value);
    }
    // AECI-2083: a `[class.text-xl]="…"` binding can add the class, so it counts.
    classes.push(...conditionalClasses(attrs!));
    const dead = classes
      .join(' ')
      .split(/\s+/)
      .filter((t) => DEAD_UTILITY.test(t));
    if (dead.length) scan.found.push(`${file}:${line} <${tag}> ${dead.join(' ')}`);
  }
  return scan;
}

/**
 * Bindings the guard cannot read, each named with its reason. A new unreadable binding
 * on a public heading fails the test until it is listed here, so nothing is skipped
 * silently. `DESIGN.md` §3 names these as outside the guard.
 */
const UNREADABLE: Record<string, string> = {};

/** The guard reads about 200 public headings. Fewer means the scan broke. */
const MIN_HEADINGS = 150;

describe('public h1, h2 and h3 carry no utility the heading rule overrides (AECI-1847)', () => {
  const scans = publicSources().map((path) => {
    const src = readFileSync(path, 'utf8');
    return deadHeadingUtilities(relative(SRC_DIR, path), src, scopeFor(path, src));
  });

  it('finds none in public code', () => {
    expect(scans.flatMap((s) => s.found)).toEqual([]);
  });

  it('scans enough headings that it cannot pass on an empty read', () => {
    const scanned = scans.reduce((n, s) => n + s.scanned, 0);
    expect(scanned).toBeGreaterThan(MIN_HEADINGS);
  });

  it('reads every class binding on a public heading, or names it in UNREADABLE', () => {
    const unresolved = scans.flatMap((s) => s.unresolved);
    expect(unresolved.filter((u) => !(u in UNREADABLE))).toEqual([]);
    expect(Object.keys(UNREADABLE).filter((k) => !unresolved.includes(k))).toEqual([]);
  });

  it('flags a static class, a bound literal, a constant, a concatenation and a member read', () => {
    const src = [
      `<h2 class="mt-4 text-2xl font-normal text-(--text-primary)">A</h2>`,
      `<h3 [class]="headingClass">B</h3>`,
      `<h1 [class]="title">C</h1>`,
      `<h2><span class="text-t-36 leading-[1.1]">D</span></h2>`,
      `<h2 class="aec-overline text-(--text-secondary)">E</h2>`,
      `<h3\n  [class]="headingClass + ' mt-3'"\n>F</h3>`,
      `<h1 [class]="headerClass.title">G</h1>`,
      `<h1 [class]="titleClass()">H</h1>`,
    ].join('\n');
    const companion = [
      `protected readonly headingClass =\n    'font-display text-xl tracking-tight';`,
      `const TITLE = 'mt-4 md:text-4xl';`,
      `protected readonly title = TITLE;`,
      `protected readonly headerClass = HEADER;`,
    ].join('\n');
    const imported = `export const HEADER = {\n  title: 'mt-4 text-3xl',\n  lede: 'mt-3',\n} as const;`;
    const scan = deadHeadingUtilities('x.html', src, {
      sources: [src, companion],
      importFile: (name) => (name === 'HEADER' ? imported : ''),
    });
    expect(scan.found).toEqual([
      'x.html:1 <h2> text-2xl font-normal',
      'x.html:2 <h3> text-xl tracking-tight',
      'x.html:3 <h1> md:text-4xl',
      'x.html:6 <h3> text-xl tracking-tight',
      'x.html:9 <h1> text-3xl',
    ]);
    expect(scan.unresolved).toEqual(['x.html <h1> [class]="titleClass()"']);
    expect(scan.scanned).toBe(8);
  });
});

/** The scan of one portal or admin file, comments aside (AECI-2083). */
function portalAdminHeadingScan(rel: string, src: string): HeadingScan {
  return deadHeadingUtilities(rel, stripComments(src), scopeFor(join(APP_DIR, rel), src));
}

/** Headings with a dead utility in one portal or admin file (AECI-2083). */
export function portalAdminHeadingCount(rel: string, src: string): number {
  return portalAdminHeadingScan(rel, src).found.length;
}

/**
 * Portal and admin heading bindings the guard cannot read, each with its reason
 * (AECI-2083). A new one fails until it is named here. Empty today.
 */
const PORTAL_ADMIN_UNREADABLE: Record<string, string> = {};

/*
 * AECI-1729: the portal and admin slices emptied the shrink-only allowlist, so the
 * cleanup slice deleted `guard-allowlists/heading-utilities.txt`. The portal and the
 * console now hold the public rule: no exceptions.
 */
describe('portal and admin headings carry no dead utility (AECI-2083, AECI-1729)', () => {
  const files = portalAdminSources();
  const counts = countPerFile(files, portalAdminHeadingCount);

  it('finds none in the portal or the console (no exceptions)', () => {
    expect([...counts]).toEqual([]);
  });

  it('reads both folders, so it cannot pass on an empty scan', () => {
    const perFolder = filesByFolder(files);
    expect(perFolder['admin']).toBeGreaterThan(MIN_FILES.admin);
    expect(perFolder['vendor']).toBeGreaterThan(MIN_FILES.vendor);
  });

  it('reads every class binding on a portal or admin heading, or names it', () => {
    const unresolved = files.flatMap(
      (rel) => portalAdminHeadingScan(rel, readSource(rel)).unresolved,
    );
    expect(checkUnreadable(unresolved, PORTAL_ADMIN_UNREADABLE)).toEqual([]);
  });

  it('counts each heading with a dead utility, and skips comments', () => {
    const src = [
      `<h2 class="font-display text-xl font-semibold">A</h2>`,
      `<h3 class="mt-2">B</h3>`,
      `<h3 class="text-sm">C</h3>`,
      `<h3 [class.font-bold]="strong">D</h3>`,
      `<!-- <h2 class="text-xl">a comment</h2> -->`,
    ].join('\n');
    expect(portalAdminHeadingCount('vendor/x.html', src)).toBe(3);
  });

  it('counts a new offender, so the no-exceptions check fails on it', () => {
    const rel = 'vendor/x.html';
    expect([...countSource(portalAdminHeadingCount, rel, `<h2 class="text-xl">A</h2>`)]).toEqual([
      [rel, 1],
    ]);
    expect([...countSource(portalAdminHeadingCount, rel, `<h2>A</h2>`)]).toEqual([]);
  });

  it('fails on an unreadable binding that is not named, and on a stale name', () => {
    const scan = portalAdminHeadingScan('vendor/x.html', `<h2 [class]="titleClass()">A</h2>`);
    expect(checkUnreadable(scan.unresolved, {})).toEqual([
      'vendor/x.html <h2> [class]="titleClass()": unreadable, name it with a reason',
    ]);
    expect(checkUnreadable([], { 'vendor/x.html <h2> [class]="t()"': 'why' })).toEqual([
      'vendor/x.html <h2> [class]="t()": no longer unreadable, delete its entry',
    ]);
  });
});
