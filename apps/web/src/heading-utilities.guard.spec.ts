import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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

function safeRead(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Where to look for a name: the component's own sources, then each file it imports
 * from by a relative path (one level), so an imported constant such as
 * `BROWSE_HEADER_CLASS` resolves too.
 */
interface Scope {
  sources: readonly string[];
  importFile: (name: string) => string;
}

/** A string literal that may span lines: '…', "…" or a template with no `${}`. */
const LITERAL = String.raw`'([^']*)'|"([^"]*)"|\`([^\`$]*)\``;

function literalAt(text: string): string | null {
  const m = text.match(new RegExp(`^\\s*(?:${LITERAL})`));
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : null;
}

/** The string a name holds: a literal, another constant, or a constant it imports. */
function resolveName(name: string, scope: Scope, depth = 0): string | null {
  if (depth > 3) return null;
  for (const src of scope.sources) {
    const assign = src.match(new RegExp(`\\b${name}\\s*(?::[^=;]+)?=\\s*`));
    if (!assign) continue;
    const rest = src.slice(assign.index! + assign[0].length);
    const literal = literalAt(rest);
    if (literal !== null) return literal;
    const alias = rest.match(/^([A-Za-z_$][\w$]*)\s*;/);
    if (alias) return resolveName(alias[1]!, scope, depth + 1);
  }
  const imported = scope.importFile(name);
  return imported
    ? resolveName(name, { sources: [imported], importFile: () => '' }, depth + 1)
    : null;
}

/** The object literal a name holds (`const X = { … }`), followed through an alias. */
function resolveObject(name: string, scope: Scope, depth = 0): string | null {
  if (depth > 3) return null;
  for (const src of scope.sources) {
    const assign = src.match(new RegExp(`\\b${name}\\s*(?::[^=;]+)?=\\s*`));
    if (!assign) continue;
    const rest = src.slice(assign.index! + assign[0].length);
    if (rest.startsWith('{')) return rest.slice(0, rest.indexOf('}') + 1);
    const alias = rest.match(/^([A-Za-z_$][\w$]*)\s*;/);
    if (alias) return resolveObject(alias[1]!, scope, depth + 1);
  }
  const imported = scope.importFile(name);
  return imported
    ? resolveObject(name, { sources: [imported], importFile: () => '' }, depth + 1)
    : null;
}

/**
 * The class string a `[class]` binding produces, or null when it cannot be read
 * statically. Reads string literals, names (`headingClass`), member reads
 * (`headerClass.title`) and `+` concatenations of those. A call (`titleClass()`), a
 * ternary or a template with `${}` is not read.
 */
export function resolveBinding(expr: string, scope: Scope): string | null {
  const parts = expr.split('+').map((p) => p.trim());
  const out: string[] = [];
  for (const part of parts) {
    const literal = literalAt(part);
    if (literal !== null && literalAt(part)!.length + 2 === part.length) {
      out.push(literal);
      continue;
    }
    const member = part.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/);
    if (member) {
      const obj = resolveObject(member[1]!, scope);
      const prop = obj?.match(new RegExp(`\\b${member[2]}\\s*:\\s*(?:${LITERAL})`));
      if (!prop) return null;
      out.push(prop[1] ?? prop[2] ?? prop[3] ?? '');
      continue;
    }
    if (/^[A-Za-z_$][\w$]*$/.test(part)) {
      const value = resolveName(part, scope);
      if (value === null) return null;
      out.push(value);
      continue;
    }
    return null;
  }
  return out.join(' ');
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
    const dead = classes
      .join(' ')
      .split(/\s+/)
      .filter((t) => DEAD_UTILITY.test(t));
    if (dead.length) scan.found.push(`${file}:${line} <${tag}> ${dead.join(' ')}`);
  }
  return scan;
}

/** A component's sources, and a reader for the files it imports by relative path. */
function scopeFor(path: string, src: string): Scope {
  // An external template binds names its component class defines.
  const companion = path.endsWith('.html') ? safeRead(path.replace(/\.html$/, '.ts')) : '';
  const sources = [src, companion];
  return {
    sources,
    importFile: (name) => {
      for (const s of sources) {
        const imp = s.match(
          new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'(\\.[^']+)'`),
        );
        if (imp) return safeRead(join(dirname(path), `${imp[1]}.ts`));
      }
      return '';
    },
  };
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
