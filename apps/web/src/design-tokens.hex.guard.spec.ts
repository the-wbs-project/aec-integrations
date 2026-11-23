import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard test (AECI-1747): every colour token in `styles.css` renders the hex its
 * comment documents, and every alpha token states and matches its alpha.
 *
 * Why: Forest, Forest hover, Clay and Bone drifted. Their OKLCH values rendered
 * #213928, #345D40, #ED9A71 and #F3F1E6 while DESIGN.md, the brand guide and the
 * approved mock-ups documented #1E3A2F, #2E5C45, #E89668 and #F5F2EA. Nothing
 * compared the two, so the drift sat unseen. This converts each OKLCH value to
 * sRGB (Ottosson's OKLab matrices) and requires an exact hex match.
 *
 * The strict form is enforced, not assumed: a token that does not read
 * `--name: oklch(N% C H); /* #HEX *\/` fails the "strict form" test instead of
 * being skipped by the hex check.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(SRC_DIR, 'styles.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('/* ─── Data-series'));

const TOKEN_RE =
  /^\s*--([\w-]+):\s*(oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\))\s*;\s*\/\*\s*(#[0-9A-Fa-f]{6})\b/gm;
const ALPHA_RE =
  /^\s*--([\w-]+):\s*oklch\(([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\/\s*(\d+)%\)\s*;(\s*\/\*(.*?)\*\/)?/gm;
/** `--x: var(--y); /* #HEX *\/`: an alias that must keep the target's hex. */
const ALIAS_RE = /^\s*--([\w-]+):\s*var\(--([\w-]+)\)\s*;\s*\/\*\s*(#[0-9A-Fa-f]{6})\b/gm;
const STATED_ALPHA_RE = /\bat (\d+)%/;

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

describe('design tokens render their documented hex (AECI-1747)', () => {
  const tokens = [...rootBlock.matchAll(TOKEN_RE)].map((m) => ({
    name: m[1],
    l: Number(m[3]),
    c: Number(m[4]),
    h: Number(m[5]),
    hex: m[6].toUpperCase(),
  }));
  const byName = new Map(tokens.map((t) => [t.name, t]));

  it('finds the colour tokens it is meant to check', () => {
    expect(tokens.length).toBeGreaterThanOrEqual(28);
    for (const required of [
      'accent-primary',
      'accent-primary-hover',
      'accent-secondary',
      'accent-warm',
      'surface-hero-panel',
      'surface-footer',
      'border-field',
      'surface-sunken',
      'text-secondary',
    ]) {
      expect(byName.has(required), required).toBe(true);
    }
  });

  it('keeps the form-control edge at 3:1 on every ground a control sits on (AECI-1764)', () => {
    const lum = (hex: string) => {
      const ch = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
      const [r, g, b] = ch.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const edge = byName.get('border-field')!.hex;
    for (const ground of ['surface-base', 'surface-raised', 'surface-sunken', 'accent-warm']) {
      expect(ratio(edge, byName.get(ground)!.hex), ground).toBeGreaterThanOrEqual(3);
    }
    // The ground DESIGN.md records as failing: a control never sits on the hero panel.
    expect(ratio(edge, byName.get('surface-hero-panel')!.hex)).toBeLessThan(3);
  });

  it('no form control reads the retired --border-input edge (AECI-1764)', () => {
    const rule = css.slice(
      css.indexOf('.aec-field-control {'),
      css.indexOf('/* The inline field error'),
    );
    expect(rule).toContain('border-color: var(--border-field)');
    expect(rule).not.toContain('--border-input');
  });

  it('gives every oklch() token the strict opaque or alpha form', () => {
    // Every `--x: oklch(` must match the opaque pattern (`N% C H); /* #HEX */`)
    // or the alpha pattern (`N% C H / N%); /* ... at N% */`). A bare-number
    // lightness, a decimal alpha (`/ 0.4`) or a missing comment matches neither
    // and fails here instead of being skipped by the checks below.
    const declared = [...rootBlock.matchAll(/^\s*--([\w-]+):\s*oklch\(/gm)].map((m) => m[1]);
    const strict = new Set([
      ...tokens.map((t) => t.name),
      ...[...rootBlock.matchAll(ALPHA_RE)].map((m) => m[1]),
    ]);
    expect(declared.filter((n) => !strict.has(n))).toEqual([]);
  });

  it('renders the documented hex exactly, for every token', () => {
    const wrong = tokens
      .map((t) => ({ name: t.name, documented: t.hex, renders: oklchToHex(t.l, t.c, t.h) }))
      .filter((t) => t.documented !== t.renders);
    expect(wrong).toEqual([]);
  });

  it('keeps each var() alias pointing at a defined token with the same hex', () => {
    const aliases = [...rootBlock.matchAll(ALIAS_RE)];
    expect(aliases.length).toBeGreaterThanOrEqual(2);
    const bad = aliases
      .filter((m) => byName.get(m[2])?.hex !== m[3].toUpperCase())
      .map((m) => m[1]);
    expect(bad).toEqual([]);
  });

  it('states the alpha in the comment and matches it to the value', () => {
    const alphas = [...rootBlock.matchAll(ALPHA_RE)];
    expect(alphas.length).toBeGreaterThanOrEqual(8);
    const bad = alphas.filter((m) => {
      const stated = (m[7] ?? '').match(STATED_ALPHA_RE);
      return !stated || stated[1] !== m[5];
    });
    expect(bad.map((m) => m[1])).toEqual([]);
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
        /^\s*--((?:surface|border|text|accent|status|focus)-[\w-]+):\s*(?:oklch|var)\(/gm,
      ),
    ].map((m) => m[1]);
    const missing = rootNames.filter((n) => !theme.includes(`--color-${n}: var(--${n});`));
    expect(missing).toEqual([]);
  });
});
