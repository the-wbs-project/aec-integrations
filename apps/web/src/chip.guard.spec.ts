import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard for the one chip recipe (AECI-1763, DESIGN.md §5 Badges, clash 22).
 *
 * The recipe is plain CSS in `styles.css`, which jsdom does not load, so the
 * decisions that matter are pinned against the source text of its rules. Each
 * test would fail on a real regression: a rectangle chip, a shadow, a Clay fill,
 * a target under 24px, a missing focus ring or a missing forced-colours map.
 */
const CSS = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule for ${selector}`);
  return m[1] ?? '';
}

/** Every `.aec-chip` rule, as one string, so a rule-wide ban covers all tones. */
const ALL_CHIP_RULES = [...CSS.matchAll(/[^}\n]*aec-chip[^{]*\{[^}]*\}/g)]
  .map((m) => m[0])
  .join('\n');

describe('the chip recipe in styles.css', () => {
  it('is a full pill', () => {
    expect(rule('.aec-chip')).toContain('border-radius: var(--radius-pill)');
  });

  it('is bordered at 1px and takes no shadow anywhere', () => {
    expect(rule('.aec-chip')).toContain('border: 1px solid var(--border-default)');
    expect(ALL_CHIP_RULES).not.toMatch(/box-shadow/);
  });

  it('never takes Clay', () => {
    expect(ALL_CHIP_RULES).not.toMatch(/accent-secondary/);
  });

  it('sets the ruled weights: 400 default, 600 dense, 500 label', () => {
    expect(rule('.aec-chip')).toContain('font-weight: 400');
    expect(rule(".aec-chip[data-density='dense']")).toContain('font-weight: 600');
    expect(rule(".aec-chip[data-face='label']")).toContain('font-weight: 500');
  });

  it('gives an interactive chip a 24px target and a 3px ring at 3px offset', () => {
    const interactive = rule('a.aec-chip,\nbutton.aec-chip');
    expect(interactive).toContain('min-height: 1.5rem');
    const focus = rule('a.aec-chip:focus-visible,\nbutton.aec-chip:focus-visible');
    expect(focus).toContain('outline: 3px solid');
    expect(focus).toContain('outline-offset: 3px');
  });

  it('sets no cursor on a static chip, so it keeps the pointer of a link around it', () => {
    expect(rule('.aec-chip')).not.toMatch(/cursor/);
    // Hover is scoped to a and button only.
    expect(ALL_CHIP_RULES).not.toMatch(/(^|\n)\.aec-chip:hover/);
  });

  it('allows no radius but the pill on any chip rule', () => {
    const radii = [...ALL_CHIP_RULES.matchAll(/border-(?:\w+-)*radius:\s*([^;]+);/g)].map(
      (m) => m[1],
    );
    expect(radii.length).toBeGreaterThan(0);
    for (const r of radii) expect(r).toBe('var(--radius-pill)');
  });

  it('gaps the icon 8px on the default chip and 4px on dense', () => {
    expect(rule('.aec-chip')).toContain('gap: 0.5rem');
    expect(rule(".aec-chip[data-density='dense']")).toContain('gap: 0.25rem');
  });

  it('keeps a selected filter chip on the Forest wash with a Forest edge', () => {
    const wash = rule(".aec-chip[data-tone='wash']");
    expect(wash).toContain('background-color: var(--accent-primary-soft)');
    expect(wash).toContain('border-color: var(--accent-primary)');
  });

  it('maps a pressed chip to the system selection pair in forced-colours mode', () => {
    expect(CSS).toMatch(
      /@media \(forced-colors: active\) \{\s*button\.aec-chip\[aria-pressed='true'\] \{[^}]*Highlight[^}]*HighlightText/,
    );
  });
});
