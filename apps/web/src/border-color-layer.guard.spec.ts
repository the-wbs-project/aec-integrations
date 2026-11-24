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

const isUniversal = (selector: string): boolean =>
  selector.split(',').some((s) => /^\*?(::?[a-z-]+)?$/.test(s.trim()) && s.trim() !== '');

const setsBorderColour = (body: string): boolean =>
  /(^|[;\s])border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color\s*:/.test(body);

const inLayer = (r: Rule): boolean => r.context.some((c) => /^@layer\s/.test(c));

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
      'an unlayered `* { border-color }` beats every border-colour utility; put it in @layer base',
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
