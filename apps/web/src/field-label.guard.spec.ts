import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { resolveBinding, scopeFor } from './guard-allowlists/class-binding.harness';
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
 * AECI-1850: a form field label is the Label role, from `FIELD_LABEL_CLASS` or
 * `FIELD_LABEL_TYPE_CLASS` (`shared/form-field/form-field-classes.ts`). Before, the
 * label was the uppercase 12px bold overline, and five components carried a hand copy
 * of that string, so a change to the constant missed them. This guard fails when the
 * old recipe (`text-xs`, `font-bold` and `uppercase` in one class string) is written out
 * in public code, so a new hand copy cannot drift from the constant unseen.
 *
 * It reads every `.ts` and `.html` file in `src/app` outside `admin/`, `vendor/` (the
 * portal), `preview/`, `demo/` and `dev/`. Those keep their own labels until the portal
 * and admin page work. A class string is a quoted string or a `class="…"` attribute.
 *
 * AECI-2083: `admin/` and `vendor/` are read too, against a shrink-only allowlist
 * (`guard-allowlists/field-label.txt`, rules in `shrink-only.harness.ts`). There the
 * unit is the element: a `<label>` or `<legend>` whose own class sets type (a text
 * size, a font weight or `uppercase`) without being the Label role (`text-t-13` with
 * `font-semibold`). It reads the static `class` and a `[class]` binding to a constant
 * in the component or a sibling file. A constant imported from `shared/` (the
 * form-field and choice recipes) is taken as on-recipe and not read, and a binding it
 * cannot read, such as a method call, is not counted. A label with no type of its own,
 * such as `sr-only`, is not counted.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/src
const APP_DIR = join(SRC_DIR, 'app');
const NOT_PUBLIC = /^(admin|vendor|preview|demo|dev)(\/|$)/;

/**
 * Strings the guard accepts, each with its reason. Not a field label: the `aec-select`
 * option-group heading is a heading inside the listbox, out of scope for AECI-1850.
 */
const ALLOWED: Record<string, string> = {
  'shared/aec-select/aec-select.ts':
    'the option-group heading inside the listbox, not a field label (out of scope, AECI-1850)',
};

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

export function oldLabelRecipes(src: string): string[] {
  const found: string[] = [];
  for (const m of src.matchAll(/(['"`])([^'"`\n]*(?:\n[^'"`\n]*){0,3})\1/g)) {
    const tokens = m[2]!.split(/\s+/);
    if (
      tokens.includes('text-xs') &&
      tokens.includes('font-bold') &&
      tokens.includes('uppercase')
    ) {
      found.push(m[2]!.replace(/\s+/g, ' ').trim());
    }
  }
  return found;
}

describe('no hand copy of the old uppercase field label in public code (AECI-1850)', () => {
  it('finds none', () => {
    const found: string[] = [];
    for (const path of publicSources()) {
      const rel = relative(APP_DIR, path);
      const hits = oldLabelRecipes(readFileSync(path, 'utf8'));
      if (hits.length && !(rel in ALLOWED)) found.push(...hits.map((h) => `${rel}: ${h}`));
    }
    expect(found).toEqual([]);
  });

  it('each allowed file still holds the string it is allowed for', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(oldLabelRecipes(readFileSync(join(APP_DIR, rel), 'utf8')).length, rel).toBe(1);
    }
  });

  it('flags the old recipe in an attribute and a constant, and passes the Label role', () => {
    expect(
      oldLabelRecipes(
        [
          `<label class="block text-xs font-bold uppercase tracking-[0.08em]">A</label>`,
          `const X = 'text-xs font-bold tracking-[0.08em] text-(--text-secondary) uppercase';`,
          `const Y = 'block text-t-13 font-semibold tracking-[0.01em] text-(--text-secondary)';`,
        ].join('\n'),
      ),
    ).toHaveLength(2);
  });
});

/** A token that sets type: a text size, a font weight, or `uppercase`. */
const TYPE_TOKEN =
  /^(?:[a-z0-9-]+:)*(?:text-(?:xs|sm|base|lg|[2-9]?xl|t-\d+)|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|uppercase)$/;

/** True for a class string that sets its own type and is not the Label role. */
function offLabelRole(classes: string): boolean {
  const tokens = classes.split(/\s+/);
  const onRole = tokens.includes('text-t-13') && tokens.includes('font-semibold');
  return !onRole && tokens.some((t) => TYPE_TOKEN.test(t));
}

/** Labels and legends off the Label role in one portal or admin file (AECI-2083). */
export function portalAdminLabelCount(rel: string, src: string): number {
  const scope = scopeFor(join(APP_DIR, rel), src, /(^|\/)shared\//);
  let n = 0;
  for (const m of stripComments(src).matchAll(/<(?:label|legend)\b((?:[^>"]|"[^"]*")*)>/g)) {
    const attrs = m[1]!;
    const classes: string[] = [];
    const stat = attrs.match(/(?<![\w\].-])class="([^"]*)"/);
    if (stat) classes.push(stat[1]!);
    const bound = attrs.match(/\[class\]="([^"]*)"/);
    const value = bound ? resolveBinding(bound[1]!, scope) : null;
    if (value) classes.push(value);
    if (offLabelRole(classes.join(' '))) n++;
  }
  return n;
}

describe('portal and admin labels off the Label role only shrink (AECI-2083)', () => {
  const counts = countPerFile(portalAdminSources(), portalAdminLabelCount);

  it('matches guard-allowlists/field-label.txt', () => {
    expect(checkShrinkOnly(counts, readAllowlist('field-label'))).toEqual([]);
  });

  it('still finds offenders in both folders, so the scan is reading', () => {
    const totals = totalsByFolder(counts);
    expect(totals['admin']).toBeGreaterThan(0);
    expect(totals['vendor']).toBeGreaterThan(0);
  });

  it('counts hand-set label type, and passes the Label role, sr-only and shared constants', () => {
    const src = [
      `<label for="a" class="block text-xs font-bold uppercase tracking-[0.08em]">A</label>`,
      `<label for="b" [class]="labelClass">B</label>`,
      `<legend class="text-sm font-medium">C</legend>`,
      `<label for="d" class="sr-only">D</label>`,
      `<label for="e" class="block text-t-13 font-semibold tracking-[0.01em]">E</label>`,
      `<label for="f" [class]="shared">F</label>`,
      `<label [class]="rowClass(row)">G</label>`,
      `<!-- <label class="text-xs">a comment</label> -->`,
      `import { FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';`,
      `protected readonly labelClass = 'block text-xs font-medium text-(--text-secondary)';`,
      `protected readonly shared = FIELD_LABEL_CLASS;`,
    ].join('\n');
    expect(portalAdminLabelCount('vendor/components/x.ts', src)).toBe(3);
  });

  it('fails on a new offender and on a stale entry', () => {
    const rel = 'admin/x.html';
    const offender = countSource(
      portalAdminLabelCount,
      rel,
      `<label for="a" class="text-xs font-bold uppercase">A</label>`,
    );
    expect(checkShrinkOnly(offender, '')).toEqual([`${rel}: 1 found, 0 allowed (new offender)`]);
    const fixed = countSource(portalAdminLabelCount, rel, `<label for="a" [class]="label">A</label>`);
    expect(checkShrinkOnly(fixed, `${rel} 1`)).toEqual([
      `${rel}: now 0, delete its line (stale entry)`,
    ]);
  });
});
