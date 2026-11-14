import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard for the one bar meter recipe (AECI-1767, DESIGN.md §5 Meter, clash 19).
 * The recipe is CSS in the component's `styles`, which jsdom does not apply, so
 * the decisions are pinned against the source text. It must not return to
 * `styles.css`, so no page pays for it until it uses the meter.
 */
const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'meter.ts'), 'utf8');
/** The component's own CSS, between the backticks after `styles:`. */
const CSS = SRC.split('styles: `')[1]!.split('`,')[0]!;

const METER_RULES = [...CSS.matchAll(/[^}\n]*aec-meter[^{]*\{[^}]*\}/g)]
  .map((m) => m[0])
  .join('\n');

describe('the meter recipe in meter.ts', () => {
  it('lives in the component, not in the global stylesheet', () => {
    const global = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../../styles.css'),
      'utf8',
    );
    expect(global).not.toContain('aec-meter');
  });

  it('is 6px high with a pill end on a sunken track and a Forest fill', () => {
    expect(METER_RULES).toContain('height: 0.375rem');
    expect(METER_RULES).toContain('border-radius: var(--radius-pill)');
    expect(METER_RULES).toContain('background-color: var(--surface-sunken)');
    expect(METER_RULES).toContain('background-color: var(--accent-primary)');
  });

  it('allows Clay deep only, never plain Clay, for the onboarding series', () => {
    expect(METER_RULES).toContain('var(--accent-secondary-deep)');
    expect(METER_RULES).not.toMatch(/var\(--accent-secondary\)/);
  });

  it('has no gradient, no animation and no transition', () => {
    expect(METER_RULES).not.toMatch(/gradient|animation|transition/);
  });

  it('maps to system colours in forced-colours mode so the bar survives', () => {
    expect(CSS).toMatch(
      /@media \(forced-colors: active\) \{\s*\.aec-meter-track \{[^}]*CanvasText[^}]*\}\s*\.aec-meter-fill \{[^}]*Highlight/,
    );
  });
});
