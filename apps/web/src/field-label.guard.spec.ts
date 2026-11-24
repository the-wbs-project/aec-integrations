import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  conditionalClasses,
  resolveBinding,
  scopeFor,
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

/*
 * AECI-2083: the portal and admin labels. They were on a shrink-only allowlist
 * (`guard-allowlists/field-label.txt`) until AECI-2132 converted the last offender,
 * `vendor-contest-form.ts`, and deleted the emptied file. Both folders now hold zero,
 * with no exceptions (the heading guard's pattern, AECI-1729). This block sits apart
 * from the public guard on purpose, so parallel edits to either merge cleanly.
 *
 * The unit is the element: a `<label>` or `<legend>` whose own class sets type (a text
 * size, a font weight or `uppercase`) without being the Label role (`text-t-13` with
 * `font-semibold`). It reads the static `class`, `[class.x]` bindings, and a `[class]`
 * binding to a constant in the component or a sibling file. A constant imported from
 * `shared/` (the form-field and choice recipes) counts as on-recipe. A `[class]` binding
 * it cannot read fails until it is named in `PORTAL_ADMIN_UNREADABLE`. Not counted: a
 * label with no type of its own (`sr-only`), and a label for a checkbox or radio, which
 * wraps the input or points at it with `for` in the same template. Its text is an
 * option, body text, not the field Label role (ruled 2026-11-24).
 */

/** A token that sets type: a text size, a font weight, or `uppercase`. */
const TYPE_TOKEN =
  /^(?:[a-z0-9-]+:)*(?:text-(?:xs|sm|base|lg|[2-9]?xl|t-\d+)|font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black)|uppercase)$/;

/** True for a class string that sets its own type and is not the Label role. */
function offLabelRole(classes: string): boolean {
  const tokens = classes.split(/\s+/);
  const onRole = tokens.includes('text-t-13') && tokens.includes('font-semibold');
  return !onRole && tokens.some((t) => TYPE_TOKEN.test(t));
}

const CHOICE_INPUT = /<input\b(?:[^>"]|"[^"]*")*\btype="(?:checkbox|radio)"(?:[^>"]|"[^"]*")*>/g;

/** True when the label wraps a checkbox or radio, or names one with `for`. */
function labelsAChoice(attrs: string, body: string, src: string): boolean {
  if (/<input\b(?:[^>"]|"[^"]*")*\btype="(?:checkbox|radio)"/.test(body)) return true;
  const target =
    attrs.match(/(?<![\w\].-])for="([^"]+)"/)?.[1] ??
    attrs.match(/\[(?:attr\.)?for\]="([^"]+)"/)?.[1];
  if (!target) return false;
  return [...src.matchAll(CHOICE_INPUT)].some((m) => {
    const id =
      m[0].match(/(?<![\w\].-])id="([^"]+)"/)?.[1] ??
      m[0].match(/\[(?:attr\.)?id\]="([^"]+)"/)?.[1];
    return id === target;
  });
}

export interface LabelScan {
  found: number;
  unresolved: string[];
}

function portalAdminLabelScan(rel: string, src: string): LabelScan {
  const scope = scopeFor(join(APP_DIR, rel), src, /(^|\/)shared\//);
  const clean = stripComments(src);
  const scan: LabelScan = { found: 0, unresolved: [] };
  for (const m of clean.matchAll(/<(label|legend)\b((?:[^>"]|"[^"]*")*)>/g)) {
    const [, tag, attrs] = m;
    const start = m.index + m[0].length;
    const end = clean.indexOf(`</${tag}`, start);
    const body = clean.slice(start, end < 0 ? undefined : end);
    if (tag === 'label' && labelsAChoice(attrs!, body, clean)) continue;
    const classes: string[] = [...conditionalClasses(attrs!)];
    const stat = attrs!.match(/(?<![\w\].-])class="([^"]*)"/);
    if (stat) classes.push(stat[1]!);
    const bound = attrs!.match(/\[class\]="([^"]*)"/);
    if (bound) {
      const value = resolveBinding(bound[1]!, scope);
      if (value === null) scan.unresolved.push(`${rel} <${tag}> [class]="${bound[1]}"`);
      else classes.push(value);
    }
    if (offLabelRole(classes.join(' '))) scan.found++;
  }
  return scan;
}

/** Labels and legends off the Label role in one portal or admin file (AECI-2083). */
export function portalAdminLabelCount(rel: string, src: string): number {
  return portalAdminLabelScan(rel, src).found;
}

/**
 * Portal and admin label bindings the guard cannot read, each with its reason. Empty
 * today: the two `rowLabelClass(…)` rows in `vendor-product-create.ts` and
 * `vendor-product-facet-editor.ts` wrap a checkbox, so they are not read at all.
 */
const PORTAL_ADMIN_UNREADABLE: Record<string, string> = {};

describe('portal and admin labels are on the Label role (AECI-2083, AECI-2132)', () => {
  const files = portalAdminSources();
  const counts = countPerFile(files, portalAdminLabelCount);

  it('finds none off the Label role in the portal or the console (no exceptions)', () => {
    expect([...counts]).toEqual([]);
  });

  it('reads both folders, so it cannot pass on an empty scan', () => {
    const perFolder = filesByFolder(files);
    expect(perFolder['admin']).toBeGreaterThan(MIN_FILES.admin);
    expect(perFolder['vendor']).toBeGreaterThan(MIN_FILES.vendor);
  });

  it('reads every class binding on a portal or admin label, or names it', () => {
    const unresolved = files.flatMap(
      (rel) => portalAdminLabelScan(rel, readSource(rel)).unresolved,
    );
    expect(checkUnreadable(unresolved, PORTAL_ADMIN_UNREADABLE)).toEqual([]);
  });

  it('counts hand-set label type, and passes the Label role, sr-only and shared constants', () => {
    const src = [
      `<label for="a" class="block text-xs font-bold uppercase tracking-[0.08em]">A</label>`,
      `<label for="b" [class]="labelClass">B</label>`,
      `<legend class="text-sm font-medium">C</legend>`,
      `<label for="d" class="sr-only">D</label>`,
      `<label for="e" class="block text-t-13 font-semibold tracking-[0.01em]">E</label>`,
      `<label for="f" [class]="shared">F</label>`,
      `<label for="g" class="block" [class.font-bold]="strong">G</label>`,
      `<!-- <label class="text-xs">a comment</label> -->`,
      `import { FIELD_LABEL_CLASS } from '../../shared/form-field/form-field-classes';`,
      `protected readonly labelClass = 'block text-xs font-medium text-(--text-secondary)';`,
      `protected readonly shared = FIELD_LABEL_CLASS;`,
    ].join('\n');
    expect(portalAdminLabelCount('vendor/components/x.ts', src)).toBe(4);
  });

  it('passes a label that wraps a checkbox or radio, or names one with for', () => {
    const src = [
      `<label class="flex items-center gap-2 text-sm"><input type="checkbox" /> Keep</label>`,
      `<label class="text-sm"><input\n  type="radio"\n  name="r"\n/> One</label>`,
      `<input id="c1" type="checkbox" /><label for="c1" class="text-sm">Both</label>`,
      `<input [id]="'x-' + r.id" type="radio" /><label [for]="'x-' + r.id" class="text-sm">X</label>`,
      `<input id="t1" type="text" /><label for="t1" class="text-sm">Name</label>`,
    ].join('\n');
    expect(portalAdminLabelCount('admin/x.html', src)).toBe(1);
  });

  it('counts a new offender, so the no-exceptions check fails on it', () => {
    const rel = 'admin/x.html';
    expect([
      ...countSource(
        portalAdminLabelCount,
        rel,
        `<label for="a" class="text-xs font-bold uppercase">A</label>`,
      ),
    ]).toEqual([[rel, 1]]);
    expect([
      ...countSource(portalAdminLabelCount, rel, `<label for="a" class="sr-only">A</label>`),
    ]).toEqual([]);
  });

  it('reads a member of an imported object whose property names a constant (AECI-1729)', () => {
    // `CONSOLE_FILTER.label` holds `CONSOLE_LABEL_CLASS`, a name, not a literal. The
    // guard follows it into console-filter.ts's own import, so a filter `<label>` can
    // bind `f.label` instead of a second alias of the same string.
    const page = [
      `import { CONSOLE_FILTER } from '../console/console-filter';`,
      `protected readonly f = CONSOLE_FILTER;`,
      `<label for="a" [class]="f.label">A</label>`,
    ].join('\n');
    const scan = portalAdminLabelScan('admin/traffic/x.ts', page);
    expect(scan).toEqual({ found: 0, unresolved: [] });
    // A property naming a shared recipe counts as on-recipe.
    const corrections = [
      `import { FIELD_OVERRIDE_CLASSES } from './admin-field-corrections';`,
      `protected readonly c = FIELD_OVERRIDE_CLASSES;`,
      `<label for="a" [class]="c.label">A</label>`,
    ].join('\n');
    expect(portalAdminLabelScan('admin/vendors/x.ts', corrections)).toEqual({
      found: 0,
      unresolved: [],
    });
  });

  it('fails on an unreadable binding that is not named, and on a stale name', () => {
    const scan = portalAdminLabelScan('admin/x.html', `<label [class]="cls()">A</label>`);
    expect(checkUnreadable(scan.unresolved, {})).toEqual([
      'admin/x.html <label> [class]="cls()": unreadable, name it with a reason',
    ]);
  });
});

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
