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

/** The string an identifier holds in these sources, following one constant. */
function resolveIdent(name: string, sources: readonly string[], depth = 0): string | null {
  for (const src of sources) {
    const literal = src.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`));
    if (literal) return literal[1];
    const alias = src.match(new RegExp(`\\b${name}\\s*=\\s*([A-Z][A-Z0-9_]*)\\s*;`));
    if (alias && depth < 1) return resolveIdent(alias[1], sources, depth + 1);
  }
  return null;
}

export function deadHeadingUtilities(file: string, src: string, companion = ''): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(/<(h[123])\b([^>]*)>/g)) {
    const [, tag, attrs] = m;
    const line = src.slice(0, m.index).split('\n').length;
    const classes: string[] = [];
    const stat = attrs.match(/(?<![\w\].-])class="([^"]*)"/);
    if (stat) classes.push(stat[1]);
    const bound = attrs.match(/\[class\]="([A-Za-z_$][\w$]*)"/);
    if (bound) {
      const value = resolveIdent(bound[1], [src, companion]);
      if (value !== null) classes.push(value);
    }
    const dead = classes
      .join(' ')
      .split(/\s+/)
      .filter((t) => DEAD_UTILITY.test(t));
    if (dead.length) found.push(`${file}:${line} <${tag}> ${dead.join(' ')}`);
  }
  return found;
}

describe('public h1, h2 and h3 carry no utility the heading rule overrides (AECI-1847)', () => {
  it('finds none in public code', () => {
    const found: string[] = [];
    for (const path of publicSources()) {
      const src = readFileSync(path, 'utf8');
      // An external template binds names its component class defines.
      const companion = path.endsWith('.html') ? safeRead(path.replace(/\.html$/, '.ts')) : '';
      found.push(...deadHeadingUtilities(relative(SRC_DIR, path), src, companion));
    }
    expect(found).toEqual([]);
  });

  it('flags a static class, a bound literal and a constant, and leaves a span alone', () => {
    const src = [
      `<h2 class="mt-4 text-2xl font-normal text-(--text-primary)">A</h2>`,
      `<h3 [class]="headingClass">B</h3>`,
      `<h1 [class]="title">C</h1>`,
      `<h2><span class="text-t-36 leading-[1.1]">D</span></h2>`,
      `<h2 class="aec-overline text-(--text-secondary)">E</h2>`,
    ].join('\n');
    const companion = [
      `protected readonly headingClass =\n    'font-display text-xl tracking-tight';`,
      `const TITLE = 'mt-4 md:text-4xl';`,
      `protected readonly title = TITLE;`,
    ].join('\n');
    expect(deadHeadingUtilities('x.html', src, companion)).toEqual([
      'x.html:1 <h2> text-2xl font-normal',
      'x.html:2 <h3> text-xl tracking-tight',
      'x.html:3 <h1> md:text-4xl',
    ]);
  });
});
