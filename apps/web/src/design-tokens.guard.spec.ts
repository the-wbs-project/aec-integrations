import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guard test: every app-namespace design token referenced in the source tree
 * must be defined in `styles.css`.
 *
 * Motivation (AECI-93): all three index-row cards referenced
 * `hover:bg-(--surface-muted)`, but `--surface-muted` was never defined in
 * `styles.css`. Tailwind's `bg-(--var)` arbitrary utility silently resolves an
 * undefined custom property to nothing, so the hover/focus highlight rendered
 * transparent in both themes — a defect no type-check or lint caught. This test
 * fails fast on any `(--token)` reference with no matching definition, closing
 * the whole class of bug.
 *
 * Scope: only the app's own design-token namespaces (`--surface-*`, `--text-*`,
 * `--border-*`, `--accent-*`, `--font-*`, `--status-*`, `--focus-*`). Spartan/Tailwind preset internals
 * (`--radius`, `--spacing`, `--color-*`, `--tw-*`, …) are deliberately excluded —
 * they are defined outside `styles.css` and are not the bug class this guards.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/src
const STYLES_PATH = join(SRC_DIR, 'styles.css');
const SELF = fileURLToPath(import.meta.url);

const SCANNED_EXTENSIONS = ['.ts', '.html', '.css'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular']);

/** App design-token namespaces this guard governs. */
const GUARDED_PREFIXES = /^(surface|text|border|accent|font|status|focus|t)-/;

/** Matches a CSS custom-property *declaration* — `--name:` on the left side. */
const DECLARATION_RE = /--([\w-]+)\s*:/g;

/**
 * Matches a custom-property *reference* wrapped in parens: both Tailwind
 * arbitrary utilities (`bg-(--surface-muted)`) and CSS `var(--surface-muted)`.
 */
const REFERENCE_RE = /\(--([\w-]+)\)/g;

function collectMatches(content: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(regex)) {
    out.push(match[1]);
  }
  return out;
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      files.push(...walk(join(dir, entry.name)));
    } else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      files.push(join(dir, entry.name));
    }
  }
  return files;
}

describe('design tokens', () => {
  const definedTokens = new Set(collectMatches(readFileSync(STYLES_PATH, 'utf8'), DECLARATION_RE));

  it('defines every surface token used by the index-row cards (AECI-93 regression)', () => {
    for (const token of ['surface-base', 'surface-raised', 'surface-sunken', 'surface-muted']) {
      expect(definedTokens, `--${token} must be defined in styles.css`).toContain(token);
    }
  });

  it('has no reference to an undefined app-namespace token', () => {
    const violations: { token: string; file: string }[] = [];

    for (const file of walk(SRC_DIR)) {
      if (file === SELF) continue; // don't scan this guard's own example patterns
      const refs = collectMatches(readFileSync(file, 'utf8'), REFERENCE_RE);
      for (const token of refs) {
        if (GUARDED_PREFIXES.test(token) && !definedTokens.has(token)) {
          violations.push({ token: `--${token}`, file: file.slice(SRC_DIR.length + 1) });
        }
      }
    }

    expect(
      violations,
      `Undefined design tokens referenced (define them in styles.css):\n${violations
        .map((v) => `  ${v.token} — ${v.file}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  describe('the type ramp (AECI-1748, DESIGN.md §3)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const RAMP = [
      't-12',
      't-13',
      't-14',
      't-16',
      't-20',
      't-24',
      't-36',
      't-fig',
      't-statement',
      't-display',
    ];
    const FLUID = new Set(['t-36', 't-fig', 't-statement', 't-display']);
    const TAILWIND_STEPS = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'];

    /** The value of a custom-property declaration, or undefined. */
    function valueOf(name: string): string | undefined {
      return css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))?.[1].trim();
    }

    it('defines all ten ramp tokens', () => {
      for (const token of RAMP) {
        expect(definedTokens, `--${token} must be defined in styles.css`).toContain(token);
      }
    });

    it('writes each fluid step as a rem clamp with a rem-plus-vw middle term (WCAG 1.4.4)', () => {
      for (const token of FLUID) {
        expect(valueOf(token), `--${token}`).toMatch(
          /^clamp\([\d.]+rem,\s*[\d.]+vw \+ [\d.]+rem,\s*[\d.]+rem\)$/,
        );
      }
    });

    // WCAG 1.4.4: text must reach 200%. Browser zoom shrinks the CSS viewport and grows
    // the rem, so a vw term grows less than the zoom. Safari stops at 300%, so every
    // fluid step must reach twice its 100% size by 300% zoom at every window width.
    it('doubles every fluid step by 300% zoom at every window width from 320 to 4000px', () => {
      const ROOT_PX = 16;
      for (const token of FLUID) {
        const parts = valueOf(token)?.match(
          /^clamp\(([\d.]+)rem,\s*([\d.]+)vw \+ ([\d.]+)rem,\s*([\d.]+)rem\)$/,
        );
        expect(parts, `--${token}`).toBeTruthy();
        const [min, vw, rem, max] = parts!.slice(1).map(Number);
        /** Rendered size in device px for a window `width` device px wide at `zoom`. */
        const size = (width: number, zoom: number): number => {
          const cssWidth = width / zoom;
          const css = Math.min(
            max * ROOT_PX,
            Math.max(min * ROOT_PX, (vw * cssWidth) / 100 + rem * ROOT_PX),
          );
          return css * zoom;
        };
        for (let width = 320; width <= 4000; width += 10) {
          expect(
            size(width, 3),
            `--${token} at ${width}px: ${size(width, 1).toFixed(1)}px at 100% zoom`,
          ).toBeGreaterThanOrEqual(2 * size(width, 1) - 0.01);
        }
      }
    });

    it('maps each Tailwind step to the token in the DESIGN.md §3 table', () => {
      const expected: Record<string, string> = {
        xs: 't-12',
        sm: 't-14',
        base: 't-16',
        lg: 't-20',
        xl: 't-20',
        '2xl': 't-24',
        '3xl': 't-36',
        '4xl': 't-36',
        // The portal glance figure is the only live non-heading text-5xl: a Figure.
        '5xl': 't-fig',
      };
      for (const [step, token] of Object.entries(expected)) {
        expect(valueOf(`text-${step}`), `--text-${step}`).toBe(`var(--${token})`);
      }
    });

    it('keeps the fixed steps in rem', () => {
      for (const token of RAMP.filter((t) => !FLUID.has(t))) {
        expect(valueOf(token), `--${token}`).toMatch(/^[\d.]+rem$/);
      }
    });

    it('resolves every Tailwind text-* size to a ramp token', () => {
      for (const step of [...TAILWIND_STEPS, '6xl', '7xl', '8xl', '9xl']) {
        const value = valueOf(`text-${step}`);
        const token = value?.match(/^var\(--(t-[\w]+)\)$/)?.[1];
        expect(token !== undefined && RAMP.includes(token), `--text-${step} is "${value}"`).toBe(
          true,
        );
      }
    });
  });
});
