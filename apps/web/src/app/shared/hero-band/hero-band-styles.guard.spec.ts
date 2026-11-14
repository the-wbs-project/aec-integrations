import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Guard (AECI-1766): the hero glow, the Bone focus ring and the forced-colours
 * boundary live in `styles.css`, which jsdom does not apply. This reads the
 * stylesheet as text so a regression fails here, not only in the browser.
 */
const SRC = join(process.cwd(), 'src');
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');

function rule(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`${selector} not found in styles.css`);
  return css.slice(start, css.indexOf('\n}', start));
}

describe('hero band styles (AECI-1766)', () => {
  it('builds the glow from the two alpha tokens and nothing else', () => {
    const glow = rule('.aec-hero-band');
    expect(glow).toContain('radial-gradient(');
    expect(glow).toContain('var(--surface-hero-glow)');
    expect(glow).toContain('var(--surface-hero-glow-soft)');
    expect(glow).not.toMatch(/#[0-9a-f]{3,8}\b|color-mix|oklch\(|rgb\(|blur|filter/i);
    expect(glow.match(/radial-gradient\(/g)).toHaveLength(2);
    expect(glow).not.toMatch(/linear-gradient|conic-gradient/);
  });

  it('keeps the glow clear of the top edge so the header seam is flat', () => {
    // The second length is the VERTICAL radius, and the stop at 70% puts the edge
    // of the glow 392px from its centre (0.7 x 560). The centre is held at least
    // 392px down, so the glow is fully transparent on the band's top row.
    const glow = rule('.aec-hero-band');
    expect(glow).toMatch(/900px 560px at 78% max\(42%, 392px\)/);
    expect(0.7 * 560).toBe(392);
    expect(glow).toMatch(/transparent 70%/);
  });

  /** The `@layer base` block that holds the band's ring and link rules. */
  function baseBlock(): string {
    const at = css.indexOf('@layer base {\n  .aec-hero-band');
    expect(at).toBeGreaterThan(0);
    return css.slice(at, css.indexOf('\n}\n', at));
  }

  it('sets the Bone ring colour, width and offset once, in the base layer', () => {
    const block = baseBlock();
    expect(block).toMatch(
      /\.aec-hero-band :where\(a, button, input, select, textarea, summary, \[tabindex\]\):focus-visible \{[^}]*outline-width: 3px;[^}]*outline-offset: 3px;[^}]*outline-color: var\(--focus-ring-on-brand\)/,
    );
    // No unlayered ring rule: it would beat a caller's plain utility.
    const unlayered = css.replace(block, '');
    expect(unlayered).not.toMatch(/\.aec-hero-band[^{]*:focus-visible[^{]*\{[^}]*outline:/);
  });

  it('makes a plain link Bone and underlines it on hover, in the base layer', () => {
    const block = baseBlock();
    expect(block).toMatch(/\.aec-hero-band a \{\s*color: var\(--text-on-brand\)/);
    // The base-layer `a:hover` rule is as specific, so hover must set Bone again.
    expect(block).toMatch(
      /\.aec-hero-band a:hover \{\s*color: var\(--text-on-brand\);\s*text-decoration-line: underline/,
    );
  });

  it('gives a chip in the band the Bone ring, after the chip rule that would beat it', () => {
    const chip = css.indexOf('a.aec-chip:focus-visible,\nbutton.aec-chip:focus-visible {');
    const inBand = css.indexOf('.aec-hero-band a.aec-chip:focus-visible');
    expect(chip).toBeGreaterThan(0);
    expect(inBand).toBeGreaterThan(chip);
    expect(css.slice(inBand, css.indexOf('}', inBand))).toContain(
      'outline-color: var(--focus-ring-on-brand)',
    );
  });

  it('quotes the glow contrast figures that DESIGN.md quotes', () => {
    const glow = css.slice(css.indexOf('/* The Forest hero band'), css.indexOf('.aec-hero-band {'));
    for (const figure of ['7.75:1', '5.59:1', '7.34:1', '5.29:1', '6.87:1', '4.96:1']) {
      expect(glow, figure).toContain(figure);
    }
  });

  it('keeps a boundary and drops the glow under forced colours', () => {
    const at = css.indexOf('@media (forced-colors: active) {\n  .aec-hero-band');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf('\n}\n', at));
    expect(block).toContain('background-image: none');
    expect(block).toMatch(/border-block: 1px solid CanvasText/);
    expect(block).toMatch(/\.aec-hero-panel \{\s*border: 1px solid CanvasText/);
  });

  it('gives the Bone band a system-colour edge under forced colours only', () => {
    const at = css.indexOf('@media (forced-colors: active) {\n  .aec-bone-band');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf('\n}\n', at));
    expect(block).toMatch(/border-block: 1px solid CanvasText/);
    expect(css).not.toMatch(/^\.aec-bone-band \{/m);
  });

  it('defines the glow tokens at the ruled alphas', () => {
    expect(css).toMatch(/--surface-hero-glow:\s*oklch\(43\.47% 0\.0641 160\.3 \/ 75%\)/);
    expect(css).toMatch(/--surface-hero-glow-soft:\s*oklch\(43\.47% 0\.0641 160\.3 \/ 45%\)/);
  });

  it('is unlayered, so it is not flattened by a utility layer', () => {
    const at = css.indexOf('.aec-hero-band {');
    let depth = 0;
    for (let i = 0; i < at; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') depth--;
    }
    expect(depth).toBe(0);
  });
});
