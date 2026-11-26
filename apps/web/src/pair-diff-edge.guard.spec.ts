import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard from the AECI-1798 review. It reads the source, because the bug it prevents is
 * invisible to a component test: the cascade decides the edge colour.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, 'styles.css'), 'utf8');

/** Brace depth at `index`, ignoring comments. 0 means the rule is unlayered. */
function depthAt(source: string, index: number): number {
  const code = source.slice(0, index).replace(/\/\*[\s\S]*?\*\//g, '');
  let depth = 0;
  for (const ch of code) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

function rule(selector: string): { body: string; depth: number } {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThan(-1);
  return { body: css.slice(start, css.indexOf('}', start)), depth: depthAt(css, start) };
}

describe('the pair page version-diff row edge', () => {
  it('colours the added edge Forest from an unlayered rule', () => {
    const r = rule('.aec-diff-added');
    expect(r.depth).toBe(0);
    expect(r.body).toContain('border-inline-start-color: var(--accent-primary)');
  });

  it('colours the removed edge with the strong border, unlayered too', () => {
    const r = rule('.aec-diff-removed');
    expect(r.depth).toBe(0);
    expect(r.body).toContain('border-inline-start-color: var(--border-strong)');
  });
});
