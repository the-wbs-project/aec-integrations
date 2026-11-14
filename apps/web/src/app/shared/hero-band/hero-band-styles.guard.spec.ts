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

  it('keeps the glow clear of the top edge so the header seam has no step', () => {
    // The first centre is held at least 200px down. 70% of the 280px half-height
    // is 196px, so the glow is fully transparent at y=0.
    expect(rule('.aec-hero-band')).toMatch(/at 78% max\(42%, 200px\)/);
  });

  it('draws every focus ring in the band as Bone, 3px at 3px', () => {
    const ring = rule('.aec-hero-band :focus-visible');
    expect(ring).toContain('outline: 3px solid var(--focus-ring-on-brand)');
    expect(ring).toContain('outline-offset: 3px');
  });

  it('keeps a boundary and drops the glow under forced colours', () => {
    const at = css.indexOf('@media (forced-colors: active) {\n  .aec-hero-band');
    expect(at).toBeGreaterThan(0);
    const block = css.slice(at, css.indexOf('\n}\n', at));
    expect(block).toContain('background-image: none');
    expect(block).toMatch(/border-block: 1px solid CanvasText/);
    expect(block).toMatch(/\.aec-hero-panel \{\s*border: 1px solid CanvasText/);
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
