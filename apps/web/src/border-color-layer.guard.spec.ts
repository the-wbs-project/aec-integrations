import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-2088): the global default border colour lives in `@layer base`.
 *
 * An unlayered rule beats every layered rule, whatever its specificity. While the
 * `* { border-color }` rule sat outside any layer, every Tailwind border-colour
 * utility (`border-(--x)`, `divide-(--x)`, `border-transparent`) lost to it, in
 * every component. A component test cannot see this, because the cascade decides
 * the colour, so this spec reads the source.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'styles.css'), 'utf8');

interface Rule {
  /** The selector list, whitespace collapsed. */
  selector: string;
  body: string;
  /** The enclosing at-rule preludes, outermost first (`@layer base`, `@media …`). */
  context: string[];
}

/** Every style rule in the sheet, with the at-rules that enclose it. */
function rules(source: string): Rule[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  const stack: string[] = [];
  let start = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === ';' && stack.length === 0) start = i + 1;
    if (ch === '{') {
      const prelude = code.slice(start, i).trim().replace(/\s+/g, ' ');
      if (prelude.startsWith('@')) {
        stack.push(prelude);
        start = i + 1;
        continue;
      }
      const end = code.indexOf('}', i);
      out.push({ selector: prelude, body: code.slice(i + 1, end), context: [...stack] });
      i = end;
      start = end + 1;
      continue;
    }
    if (ch === '}') {
      stack.pop();
      start = i + 1;
    }
  }
  return out;
}

/** Split on separators that are not inside parentheses (`:not(a, b)` stays whole). */
function splitTopLevel(list: string, sep: RegExp): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && sep.test(ch)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/**
 * True when one complex selector's subject (its last compound) matches any element:
 * `*`, `*::before`, a bare `::before`, `:where(*)`, `:is(*)`, `*:not(.x)`, `html *`,
 * `body > *`. `:root` or `.x` is not universal.
 */
function subjectIsUniversal(complex: string): boolean {
  const subject = splitTopLevel(complex, /[\s>+~]/).at(-1) ?? '';
  if (/^(::[a-z-]+)+$/.test(subject)) return true;
  const bare = subject
    .replace(/:(where|is)\(\s*\*\s*\)/g, '*')
    .replace(/::?[a-z-]+(\((?:[^()]|\([^()]*\))*\))?/g, '');
  return bare === '*';
}

const isUniversal = (selector: string): boolean =>
  splitTopLevel(selector, /,/).some(subjectIsUniversal);

/** `border-color`, a per-side colour, or a `border` shorthand (which always sets one). */
const setsBorderColour = (body: string): boolean =>
  /(^|[;\s])border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?\s*:/.test(body);

const inLayer = (r: Rule): boolean => r.context.some((c) => /^@layer\s/.test(c));

describe('the universal-selector and border-colour matchers', () => {
  it.each([
    '*',
    '*::before',
    '::after',
    ':where(*)',
    ':is(*)',
    '*:not(.aec-card)',
    'html *',
    'body > *',
    '.x, *::after',
  ])('treats `%s` as universal', (selector) => {
    expect(isUniversal(selector)).toBe(true);
  });

  it.each([':root', '.aec-nav-tab', 'table', 'a:hover', ':where(.x)', '* .x', ':not(*, .x) .y'])(
    'does not treat `%s` as universal',
    (selector) => {
      expect(isUniversal(selector)).toBe(false);
    },
  );

  it.each([
    'border-color: red;',
    'border-top-color: red;',
    'border-inline-start-color: red;',
    'border: 1px solid red;',
    'border-bottom: 1px solid;',
    'border-block: 0 solid;',
  ])('sees a border colour in `%s`', (body) => {
    expect(setsBorderColour(body)).toBe(true);
  });

  it.each(['border-width: 1px;', 'border-style: solid;', 'border-radius: 4px;', 'outline: 0;'])(
    'sees no border colour in `%s`',
    (body) => {
      expect(setsBorderColour(body)).toBe(false);
    },
  );
});

describe('the global border colour (AECI-2088)', () => {
  const all = rules(css);

  it('finds the style rules at all (the parser is not silently empty)', () => {
    expect(all.length).toBeGreaterThan(100);
  });

  it('sets no border colour on the universal selector outside a cascade layer', () => {
    const offenders = all.filter(
      (r) => isUniversal(r.selector) && setsBorderColour(r.body) && !inLayer(r),
    );
    expect(
      offenders.map((r) => r.selector),
      'an unlayered universal border colour (or `border` shorthand) beats every border-colour utility; put it in @layer base',
    ).toEqual([]);
  });

  it('keeps the default border colour in @layer base, on every box preflight resets', () => {
    const base = all.filter(
      (r) =>
        r.context.at(-1) === '@layer base' &&
        r.body.includes('border-color: var(--border-default)'),
    );
    const selectors = base.flatMap((r) => r.selector.split(',').map((s) => s.trim()));
    for (const s of ['*', '::before', '::after', '::backdrop', '::file-selector-button']) {
      expect(selectors, s).toContain(s);
    }
    // Preflight's `table { border-color: inherit }` outranks `*` inside the layer.
    expect(selectors, 'table').toContain('table');
  });
});
