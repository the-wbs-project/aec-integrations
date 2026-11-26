import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * AECI-2083: the shrink-only allowlists for the vendor portal and the admin console.
 *
 * The public site is clean on five rules: no dead utility on a heading, labels on the
 * Label role, the new radius tokens, `aec-icon` instead of an inline `<svg>`, and
 * `aecButton` on every button. The portal (`vendor/`) and the console (`admin/`) are
 * not clean yet. The redesign slices (AECI-1729) fix them file by file. Until then,
 * each guard keeps one allowlist file here: one line per offending file, its path from
 * `src/app` and its count today, sorted. A guard whose list empties loses it and holds
 * both folders at zero (the heading guard since AECI-1729, the label and inline-icon
 * guards since AECI-2132).
 *
 * The rule, for every guard:
 * - a listed file's count must equal its line. Above it is a new offender. Below it,
 *   lower the number on the line;
 * - a file not listed must count zero, so a new file starts clean;
 * - a file that reaches zero must lose its line. A stale line fails.
 *
 * One line per file keeps parallel slices out of each other's way: a slice only edits
 * or deletes the lines for the files it touched. Never add a line or raise a number.
 *
 * Test-only (a `.harness.ts` file stays out of the app build).
 */

export const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/web/src
export const APP_DIR = join(SRC_DIR, 'app');
const ALLOWLIST_DIR = join(SRC_DIR, 'guard-allowlists');

/** The folders the allowlists cover. */
export const PORTAL_ADMIN_FOLDERS = ['admin', 'vendor'] as const;

/**
 * Every `.ts` and `.html` source under `admin/` and `vendor/`, as a path from
 * `src/app`, in binary order. Specs are not sources. `skip` drops a subtree, such as
 * `admin/charts/` for the icon guard.
 */
export function portalAdminSources(skip?: RegExp): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(APP_DIR, path);
      if (skip?.test(rel)) continue;
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|html)$/.test(name) && !name.endsWith('.spec.ts')) out.push(rel);
    }
  };
  for (const folder of PORTAL_ADMIN_FOLDERS) walk(join(APP_DIR, folder));
  return out.sort(binary);
}

/** Paths are identifiers, so they sort by code unit, not by locale. */
export function binary(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function readSource(rel: string): string {
  return readFileSync(join(APP_DIR, rel), 'utf8');
}

/**
 * The source with its comments blanked: HTML comments, block comments that open a line
 * and whole-line `//` comments. Newlines stay, so a line number still points at the
 * right line. A comment that describes a `<button>` or an `<svg>` is not one. A block
 * comment must open its line so that a string such as `accept="image/*"` is not read
 * as the start of one.
 */
export function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Counts per file, for every file with at least one. */
export function countPerFile(
  files: readonly string[],
  count: (rel: string, src: string) => number,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const rel of files) {
    const n = count(rel, readSource(rel));
    if (n > 0) counts.set(rel, n);
  }
  return counts;
}

/** One synthetic file's count, as the map `checkShrinkOnly` reads. For the guard specs. */
export function countSource(
  count: (rel: string, src: string) => number,
  rel: string,
  src: string,
): Map<string, number> {
  const n = count(rel, src);
  return n > 0 ? new Map([[rel, n]]) : new Map();
}

export function readAllowlist(name: string): string {
  return readFileSync(join(ALLOWLIST_DIR, `${name}.txt`), 'utf8');
}

/**
 * Compares today's counts with an allowlist file and returns every problem, each
 * naming the fix. An empty list means the guard passes. `#` lines and blank lines are
 * comments.
 */
export function checkShrinkOnly(counts: ReadonlyMap<string, number>, allowlist: string): string[] {
  const problems: string[] = [];
  const allowed = new Map<string, number>();
  let previous = '';
  allowlist.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = `allowlist line ${i + 1}`;
    const m = line.match(/^(\S+) ([1-9]\d*)$/);
    if (!m) {
      problems.push(`${at}: "${line}" is not "<path> <count>" with a count of 1 or more`);
      return;
    }
    const [, path, n] = m;
    if (!PORTAL_ADMIN_FOLDERS.some((f) => path!.startsWith(`${f}/`))) {
      problems.push(`${at}: ${path} is outside admin/ and vendor/`);
    }
    if (allowed.has(path!)) problems.push(`${at}: ${path} is listed twice`);
    else if (binary(previous, path!) > 0) {
      problems.push(`${at}: ${path} is out of order (it sorts before ${previous})`);
    }
    previous = path!;
    allowed.set(path!, Number(n));
  });

  for (const [path, limit] of allowed) {
    const now = counts.get(path) ?? 0;
    if (now === 0) problems.push(`${path}: now 0, delete its line (stale entry)`);
    else if (now < limit) problems.push(`${path}: now ${now}, lower its line from ${limit}`);
    else if (now > limit) problems.push(`${path}: ${now} found, ${limit} allowed (new offender)`);
  }
  for (const [path, now] of counts) {
    if (!allowed.has(path)) problems.push(`${path}: ${now} found, 0 allowed (new offender)`);
  }
  return problems;
}

/** The allowlist body for a set of counts: sorted, one line per file. */
export function formatAllowlist(counts: ReadonlyMap<string, number>): string {
  return [...counts]
    .sort(([a], [b]) => binary(a, b))
    .map(([path, n]) => `${path} ${n}`)
    .join('\n');
}

/**
 * The fewest source files each folder held when the guards were written (admin 182,
 * vendor 132 on 2026-11-24). A scan that reads fewer has broken, and a guard that
 * reads nothing passes on nothing. A redesign moves files, it does not delete the
 * console, so this floor stays true when every count reaches zero.
 */
export const MIN_FILES: Readonly<Record<(typeof PORTAL_ADMIN_FOLDERS)[number], number>> = {
  admin: 120,
  vendor: 80,
};

/**
 * A guard that reads `[class]` bindings names each one it cannot read, with a reason,
 * so nothing is skipped silently. Returns a problem for an unreadable binding that is
 * not named and for a named one that is gone (delete its entry).
 */
export function checkUnreadable(
  found: readonly string[],
  named: Readonly<Record<string, string>>,
): string[] {
  return [
    ...found.filter((u) => !(u in named)).map((u) => `${u}: unreadable, name it with a reason`),
    ...Object.keys(named)
      .filter((k) => !found.includes(k))
      .map((k) => `${k}: no longer unreadable, delete its entry`),
  ];
}

/** Files per folder, for the floor check. */
export function filesByFolder(files: readonly string[]): Record<string, number> {
  const out: Record<string, number> = { admin: 0, vendor: 0 };
  for (const f of files) out[f.split('/')[0]!] = (out[f.split('/')[0]!] ?? 0) + 1;
  return out;
}
