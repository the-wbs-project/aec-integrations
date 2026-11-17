import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard test (AECI-1804): the one prose style for every build-time Markdown page
 * (`/docs/*`, `/legal/*`, `/accessibility`, `/methodology`) sits on the type ramp.
 *
 * Every `font-size` in an `.aec-prose` rule must read a ramp token (`--t-*`,
 * DESIGN.md §3). The one exception is inline code at `0.875em`, relative on
 * purpose so it scales with the heading or sentence around it (AECI-1749). The
 * body is the Body role, `--t-16` at 1.6, and the serif `h2` and `h3` stay at or
 * above the Serif-Floor (`--t-20`). The docs article lost its denser variant
 * (`.aec-docs-prose`), so the class must not come back in either the CSS or a
 * template.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC_DIR, 'styles.css'), 'utf8');

/** Each rule whose selector list names `.aec-prose`, with its declarations. */
function proseRules(): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  for (const match of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim();
    if (selector.includes('.aec-prose')) rules.push({ selector, body: match[2] });
  }
  return rules;
}

function declaration(selector: string, property: string): string | undefined {
  const rule = proseRules().find((entry) => entry.selector === selector);
  return rule?.body.match(new RegExp(`(?:^|;|\\s)${property}:\\s*([^;]+);`))?.[1].trim();
}

describe('the prose style (AECI-1804)', () => {
  it('finds the prose rules', () => {
    expect(proseRules().length).toBeGreaterThan(10);
  });

  it('sizes every prose element with a ramp token, inline code excepted', () => {
    for (const { selector, body } of proseRules()) {
      for (const size of body.matchAll(/font-size:\s*([^;]+);/g)) {
        const value = size[1].trim();
        if (selector === '.aec-prose code') {
          expect(value, selector).toBe('0.875em');
        } else {
          expect(value, selector).toMatch(/^var\(--t-[a-z0-9]+\)$/);
        }
      }
    }
  });

  it('sets the body at the Body role', () => {
    expect(declaration('.aec-prose', 'font-size')).toBe('var(--t-16)');
    expect(declaration('.aec-prose', 'line-height')).toBe('1.6');
  });

  it('keeps the serif headings on the ramp, at or above the Serif-Floor', () => {
    expect(declaration('.aec-prose h2', 'font-size')).toBe('var(--t-24)');
    expect(declaration('.aec-prose h3', 'font-size')).toBe('var(--t-20)');
    expect(declaration('.aec-prose h4,\n.aec-prose h5,\n.aec-prose h6', 'font-family')).toBe(
      'var(--font-body)',
    );
  });

  it('has no second, denser docs variant', () => {
    expect(css).not.toContain('.aec-docs-prose');
  });
});
