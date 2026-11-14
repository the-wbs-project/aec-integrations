import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1758): the shared button's edge only renders if its colour comes
 * from an UNLAYERED rule. The unlayered `* { border-color }` rule in `styles.css`
 * beats every layered utility, so a `border-(--border-strong)` utility on the
 * secondary button silently paints `--border-default` instead. This happened to
 * the old `BUTTON_SECONDARY_CLASS`. jsdom cannot see cascade layers, so this
 * reads the stylesheet and the recipe as text.
 */
const SRC = join(process.cwd(), 'src');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const recipe = readFileSync(join(SRC, 'app/shared/button/button.ts'), 'utf8');

/** Brace depth at an offset: 0 means a top-level, unlayered rule. */
function depthAt(offset: number): number {
  let depth = 0;
  for (let i = 0; i < offset; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  return depth;
}

function ruleBody(selector: string): { body: string; at: number } {
  const re = new RegExp(`^${selector.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`, 'm');
  const m = css.match(re);
  if (!m || m.index === undefined) throw new Error(`${selector} not found in styles.css`);
  return { body: m[1], at: m.index };
}

describe('shared button styles (AECI-1758)', () => {
  it('draws every variant with a transparent 1px edge from an unlayered rule', () => {
    const { body, at } = ruleBody('.aec-btn');
    expect(depthAt(at)).toBe(0);
    expect(body).toMatch(/border-color:\s*transparent/);
  });

  it('draws the secondary edge in --border-strong, after the base rule so it wins', () => {
    const base = ruleBody('.aec-btn');
    const secondary = ruleBody('.aec-btn-secondary');
    expect(depthAt(secondary.at)).toBe(0);
    expect(secondary.body).toMatch(/border-color:\s*var\(--border-strong\)/);
    expect(secondary.at).toBeGreaterThan(base.at);
    expect(secondary.at).toBeGreaterThan(css.indexOf('* {'));
  });

  it('never sets a border colour through a utility, which could not apply', () => {
    expect(recipe).not.toMatch(/['\s:]border-\(--/);
  });

  it('defines the danger hover fill as a token', () => {
    expect(css).toMatch(/--status-error-hover:\s*oklch\([^)]+\);\s*\/\*\s*#8C1D18/);
    expect(recipe).toContain('hover:bg-(--status-error-hover)');
  });
});
