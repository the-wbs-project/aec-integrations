import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1765): the card edge and the grid cap live in the stylesheet, which
 * jsdom does not apply. The edge must come from an UNLAYERED rule, because the
 * unlayered `* { border-color }` rule beats every layered utility. This reads the
 * stylesheet and the recipe as text.
 */
const SRC = join(process.cwd(), 'src');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const recipe = readFileSync(join(SRC, 'app/shared/card/card.ts'), 'utf8');

function depthAt(offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return depth;
}

function rule(selector: string): { body: string; at: number } {
  const re = new RegExp(`^${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m || m.index === undefined) throw new Error(`${selector} not found in styles.css`);
  return { body: m[1], at: m.index };
}

describe('card styles (AECI-1765)', () => {
  it('draws the transparent 1px edge from an unlayered rule that follows the * rule', () => {
    const { body, at } = rule('.aec-card');
    expect(depthAt(at)).toBe(0);
    expect(body).toMatch(/border-color:\s*transparent/);
    expect(at).toBeGreaterThan(css.indexOf('* {'));
  });

  it('never sets a border colour through a utility, which could not apply', () => {
    expect(recipe).not.toMatch(/['\s:]border-\(--/);
  });

  it('caps the card grid at three columns, with a 24px gap', () => {
    const cols = [
      ...css.matchAll(/\.aec-card-grid\s*\{[^}]*grid-template-columns:\s*([^;]+);/g),
    ].map((m) => m[1]);
    expect(cols.length).toBe(3);
    const counts = cols.map((c) => Number(c.match(/repeat\((\d+)/)?.[1] ?? 1));
    expect(Math.max(...counts)).toBe(3);
    expect(rule('.aec-card-grid').body).toMatch(/gap:\s*1\.5rem/);
  });

  it('the nested recipe carries no shadow and the lift is motion-safe only', () => {
    const nested = recipe.match(/const CARD_NESTED = '([^']+)'/)?.[1] ?? '';
    expect(nested).not.toContain('shadow');
    const lift = recipe.match(/const CARD_INTERACTIVE =\s*'([^']+)'/)?.[1] ?? '';
    expect(lift).toContain('motion-safe:hover:-translate-y-1');
    expect(lift).not.toMatch(/(^|\s)(hover|active):/);
  });
});
