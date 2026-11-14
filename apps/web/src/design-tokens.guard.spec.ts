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
 * `--border-*`, `--accent-*`, `--font-*`, `--status-*`, `--focus-*`, `--duration-*`,
 * `--ease-*`). Spartan/Tailwind preset internals
 * (`--radius`, `--spacing`, `--color-*`, `--tw-*`, …) are deliberately excluded —
 * they are defined outside `styles.css` and are not the bug class this guards.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/src
const STYLES_PATH = join(SRC_DIR, 'styles.css');
const SELF = fileURLToPath(import.meta.url);

const SCANNED_EXTENSIONS = ['.ts', '.html', '.css'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular']);

/** App design-token namespaces this guard governs. */
const GUARDED_PREFIXES = /^(surface|text|border|accent|font|status|focus|duration|ease|t)-/;

/**
 * AECI-1750: the role-named radius and shadow tokens. `--radius-sm|md|lg|xl|2xl…`
 * are Spartan's, defined outside `styles.css`, so the radius namespace is guarded
 * by name, not by prefix: a `--radius-<x>` or `--shadow-<x>` reference whose name
 * is neither Spartan's nor in this list is an undefined token.
 */
const ROLE_TOKENS = [
  'radius-mark',
  'radius-control',
  'radius-panel',
  'radius-card',
  'radius-pill',
  'shadow-card',
  'shadow-menu',
];
/** Tailwind's and Spartan's own names: defined outside `styles.css`, never a violation. */
const FRAMEWORK_TOKENS =
  /^(radius-(xs|sm|md|lg|xl|2xl|3xl|4xl)|shadow-(2xs|xs|sm|md|lg|xl|2xl|inner|none))$/;
/** The ruled recipes (DESIGN.md §4 "Shadow Vocabulary"), pinned exactly. */
const SHADOW_RECIPES: Record<string, string> = {
  'shadow-card': '0 1px 3px rgb(0 0 0 / 0.06), 0 16px 36px -16px rgb(0 0 0 / 0.24)',
  'shadow-menu': '0 8px 24px -4px rgb(0 0 0 / 0.12), 0 2px 8px -1px rgb(0 0 0 / 0.06)',
};
/** Ruled radius values (DESIGN.md §4 "Radius"). */
const RADIUS_VALUES: Record<string, string> = {
  'radius-mark': '0.5rem',
  'radius-control': '0.75rem',
  'radius-panel': '1rem',
  'radius-card': '1.5rem',
  'radius-pill': '9999px',
};
const ROLE_NAMESPACE = /^(radius|shadow)-/;

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

  it('declares every radius and shadow role token in :root with a real value, and exposes it in @theme inline (AECI-1750)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const theme = css.slice(css.indexOf('@theme inline {'));
    // The @theme self-reference `--x: var(--x)` is not a definition: only the
    // :root block counts, and its value must not be a var().
    const root = css.slice(css.indexOf(':root {'), css.indexOf('/* ─── Data-series'));
    for (const token of ROLE_TOKENS) {
      const decl = root.match(new RegExp(`^\\s*--${token}:\\s*([^;]+);`, 'm'))?.[1] ?? '';
      expect(decl, `--${token} must have a value in the :root block`).not.toBe('');
      expect(decl, `--${token} in :root must not be a var() reference`).not.toMatch(/^var\(/);
      expect(theme, `--${token} must be exposed in @theme inline`).toContain(
        `--${token}: var(--${token});`,
      );
    }
  });

  it('pins the radius values and the two shadow recipes exactly, in pure black (AECI-1750)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const root = css.slice(css.indexOf(':root {'), css.indexOf('/* ─── Data-series'));
    const valueOf = (name: string) =>
      root.match(new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm'))?.[1];
    for (const [name, value] of Object.entries(SHADOW_RECIPES)) {
      expect(valueOf(name), `--${name}`).toBe(value);
    }
    for (const [name, value] of Object.entries(RADIUS_VALUES)) {
      expect(valueOf(name)?.replace(/\s*\/\*.*$/, ''), `--${name}`).toBe(value);
    }
  });

  it('has no reference to an undefined radius or shadow role token (AECI-1750)', () => {
    const violations: { token: string; file: string }[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file === SELF) continue;
      for (const token of collectMatches(readFileSync(file, 'utf8'), REFERENCE_RE)) {
        if (!ROLE_NAMESPACE.test(token) || FRAMEWORK_TOKENS.test(token)) continue;
        if (!definedTokens.has(token)) {
          violations.push({ token: `--${token}`, file: file.slice(SRC_DIR.length + 1) });
        }
      }
    }
    expect(
      violations,
      `Undefined radius/shadow tokens referenced:\n${violations
        .map((v) => `  ${v.token} — ${v.file}`)
        .join('\n')}`,
    ).toEqual([]);
  });

  describe('motion tokens (AECI-1751)', () => {
    const css = readFileSync(STYLES_PATH, 'utf8');
    const theme = css.slice(css.indexOf('@theme inline {'));
    /** Values come from the mock-ups' default state (PLAN.md §4.6, clash 36). */
    const DURATIONS: Record<string, string> = {
      fast: '120ms',
      base: '180ms',
      slow: '280ms',
    };
    const EASING = 'cubic-bezier(0.2, 0.7, 0.2, 1)';

    it('defines the three durations and the easing with the ruled values', () => {
      for (const [name, value] of Object.entries(DURATIONS)) {
        expect(css).toMatch(new RegExp(`^\\s*--duration-${name}:\\s*${value};`, 'm'));
      }
      expect(css).toContain(`--ease-standard: ${EASING};`);
    });

    it('exposes every motion token through @theme inline, so the utilities exist', () => {
      for (const name of Object.keys(DURATIONS)) {
        expect(theme, `--transition-duration-${name}`).toContain(
          `--transition-duration-${name}: var(--duration-${name});`,
        );
      }
      expect(theme).toContain('--ease-standard: var(--ease-standard);');
    });

    it('defines every --duration-* / --ease-* token that @theme inline points at', () => {
      const exposed = [...theme.matchAll(/var\(--((?:duration|ease)-[\w-]+)\)/g)].map((m) => m[1]);
      expect(exposed.length).toBeGreaterThan(0);
      for (const token of exposed) {
        expect(definedTokens, `--${token} must be defined in styles.css`).toContain(token);
      }
    });

    it('collapses every transition and animation duration under reduced motion', () => {
      const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
      expect(start).toBeGreaterThan(-1);
      const block = css.slice(start, css.indexOf('\n}\n', start));
      expect(block).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{/);
      expect(block).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
      expect(block).toMatch(/transition-duration:\s*0\.01ms\s*!important/);
    });

    it('never feeds a duration token into a delay or a timer', () => {
      const offenders: string[] = [];
      for (const file of walk(SRC_DIR)) {
        if (file === SELF || file.endsWith('.spec.ts')) continue;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          if (!/var\(--duration-/.test(line)) continue;
          if (/(transition-delay|animation-delay|setTimeout)/.test(line)) {
            offenders.push(`${file.slice(SRC_DIR.length + 1)}: ${line.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
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
