import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard test (AECI-1747): every colour token in `styles.css` that documents a
 * hex in its trailing comment must render that hex.
 *
 * Why: Forest, Forest hover, Clay and Bone drifted. Their OKLCH values rendered
 * #213928, #345D40, #ED9A71 and #F3F1E6 while DESIGN.md, the brand guide and the
 * approved mock-ups documented #1E3A2F, #2E5C45, #E89668 and #F5F2EA. Nothing
 * compared the two, so the drift sat unseen. This converts each OKLCH value to
 * sRGB (Ottosson's OKLab matrices) and requires an exact hex match.
 *
 * Alpha tokens (`oklch(... / N%)`) are skipped: their comment names the base
 * colour, not a rendered hex. Their colour part is checked against the opaque
 * token it is built from.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC_DIR, 'styles.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('/* ─── Data-series'));

const TOKEN_RE =
  /^\s*--([\w-]+):\s*(oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\))\s*;\s*\/\*\s*(#[0-9A-Fa-f]{6})\b/gm;
const ALPHA_RE = /^\s*--([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\/\s*(\d+)%\)\s*;/gm;

function oklchToHex(lPct: number, c: number, hDeg: number): string {
  const L = lPct / 100;
  const a = c * Math.cos((hDeg * Math.PI) / 180);
  const b = c * Math.sin((hDeg * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const enc = (v: number) =>
    255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.abs(v) ** (1 / 2.4) - 0.055);
  return (
    '#' +
    lin
      .map((v) =>
        Math.max(0, Math.min(255, Math.round(enc(v))))
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  );
}

/**
 * Three shipped tokens render one sRGB step (1/255 on a channel) away from their
 * documented hex because their OKLCH was rounded to four places: surface-sunken
 * and surface-muted render #F4F4F6 for #F4F4F5, text-secondary renders #51515A
 * for #52525B. The change is imperceptible and AECI-1747 leaves those values
 * alone. Every other token must match exactly.
 */
const ONE_STEP_LEGACY = new Set(['surface-sunken', 'surface-muted', 'text-secondary']);

function withinOneStep(a: string, b: string): boolean {
  return [1, 3, 5].every(
    (i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)) <= 1,
  );
}

describe('design tokens render their documented hex (AECI-1747)', () => {
  const tokens = [...rootBlock.matchAll(TOKEN_RE)].map((m) => ({
    name: m[1],
    l: Number(m[3]),
    c: Number(m[4]),
    h: Number(m[5]),
    hex: m[6].toUpperCase(),
  }));

  it('finds the colour tokens it is meant to check', () => {
    expect(tokens.length).toBeGreaterThanOrEqual(28);
    const names = tokens.map((t) => t.name);
    for (const required of [
      'accent-primary',
      'accent-primary-hover',
      'accent-secondary',
      'accent-warm',
      'surface-hero-panel',
      'surface-footer',
      'border-field',
    ]) {
      expect(names).toContain(required);
    }
  });

  it('renders the hex in every comment', () => {
    const wrong = tokens
      .map((t) => ({ name: t.name, documented: t.hex, renders: oklchToHex(t.l, t.c, t.h) }))
      .filter((t) =>
        ONE_STEP_LEGACY.has(t.name)
          ? !withinOneStep(t.documented, t.renders)
          : t.documented !== t.renders,
      );
    expect(wrong).toEqual([]);
  });

  it('builds every alpha token from an opaque token of the same colour', () => {
    const opaque = new Set(tokens.map((t) => `${t.l}|${t.c}|${t.h}`));
    const orphans = [...rootBlock.matchAll(ALPHA_RE)]
      .filter((m) => !opaque.has(`${Number(m[2])}|${Number(m[3])}|${Number(m[4])}`))
      .map((m) => m[1]);
    expect(orphans).toEqual([]);
  });

  it('exposes every colour token through @theme inline', () => {
    const theme = css.slice(css.indexOf('@theme inline {'));
    const rootNames = [
      ...rootBlock.matchAll(
        /^\s*--((?:surface|border|text|accent|status|focus)-[\w-]+):\s*oklch\(/gm,
      ),
    ].map((m) => m[1]);
    const missing = rootNames.filter((n) => !theme.includes(`--color-${n}: var(--${n});`));
    expect(missing).toEqual([]);
  });
});
