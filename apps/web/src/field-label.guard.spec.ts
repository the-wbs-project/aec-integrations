import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

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
 * AECI-2003 adds a second check: a `<label>` with a static `class="…"`, or a literal
 * `labelClass="…"` binding, that is weight 600 but not 13px. The sign-in email label, the
 * search box label and the pair finder labels were hand copies at 14px until then.
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

/**
 * Files the 14px check accepts, each with its reason. `logo-input` mounts only in the
 * vendor portal and admin (`vendor-logo-field`, `admin-logo-editor`), so it waits for the
 * portal and admin page work, as their own labels do.
 */
const HAND_LABEL_ALLOWED: Record<string, string> = {
  'shared/logo-input/logo-input.ts':
    'portal and admin only; waits for the portal and admin page work (AECI-2003)',
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

/**
 * A `<label>` static class, or a literal `labelClass` binding, at weight 600 without the
 * Label role's 13px. A bound `[class]` or `[labelClass]` is the constant, so it passes.
 */
export function handLabelRecipes(src: string): string[] {
  const found: string[] = [];
  const classes = [
    ...src.matchAll(/<label\b[^>]*?\sclass="([^"]*)"/g),
    ...src.matchAll(/(?<![[\w-])labelClass="([^"]*)"/g),
  ];
  for (const m of classes) {
    const tokens = m[1]!.split(/\s+/);
    if (tokens.includes('font-semibold') && !tokens.includes('text-t-13')) {
      found.push(m[1]!.replace(/\s+/g, ' ').trim());
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

describe('no hand-written 14px field label in public code (AECI-2003)', () => {
  it('finds none', () => {
    const found: string[] = [];
    for (const path of publicSources()) {
      const rel = relative(APP_DIR, path);
      const hits = handLabelRecipes(readFileSync(path, 'utf8'));
      if (hits.length && !(rel in HAND_LABEL_ALLOWED)) {
        found.push(...hits.map((h) => `${rel}: ${h}`));
      }
    }
    expect(found).toEqual([]);
  });

  it('each allowed file still holds the label it is allowed for', () => {
    for (const rel of Object.keys(HAND_LABEL_ALLOWED)) {
      expect(handLabelRecipes(readFileSync(join(APP_DIR, rel), 'utf8')).length, rel).toBe(1);
    }
  });

  it('flags a static label class and a literal labelClass, and passes the constants', () => {
    expect(
      handLabelRecipes(
        [
          `<label\n  for="x"\n  class="block text-t-14 font-semibold text-(--text-primary)"\n>A</label>`,
          `<aec-search-autocomplete labelClass="mb-2 block text-sm font-semibold" />`,
          `<label for="y" class="block text-t-13 font-semibold tracking-[0.01em]">B</label>`,
          `<label for="z" [class]="labelClass">C</label>`,
          `<aec-search-autocomplete [labelClass]="labelClass" />`,
          `<label for="w" class="sr-only">D</label>`,
        ].join('\n'),
      ),
    ).toHaveLength(2);
  });
});
