import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  COLOR_FUNCTION,
  COLOR_LITERAL_ALLOW,
  HEX_COLOR,
  NAMED_COLOR_CLASS,
  TAILWIND_PALETTE,
} from '../../../eslint.color-patterns.mjs';
import { RULES, scanFile } from '../scripts/check-source-constraints.mjs';

/**
 * AECI-597 — the first test the line scanner has ever had.
 *
 * `check-source-constraints.mjs` is the second half of the enforcement split
 * described in `ANGULAR_STYLE_GUIDE.md` §24: ESLint owns `.ts`, this guard owns
 * the external `.html` and `.css` that ESLint structurally cannot read. Since
 * AECI-549 it has run on every `pnpm lint` and in CI with nothing checking that
 * its patterns still match what they claim to. The colour rules made that
 * untenable — they carry a lookahead, a lookbehind and two allow-listed files,
 * and every failure mode is SILENT: a pattern that stops matching still exits 0
 * and still prints "rules clean".
 *
 * Companion to `eslint-config.spec.ts`, which covers the same four colour
 * patterns on the ESLint side through the real resolved config. Both read from
 * `eslint.color-patterns.mjs`, which is the single definition — see the header
 * there for why that file exists rather than a second copy of each regex.
 *
 * The near-miss corpus below is not invented. Every string is lifted from the
 * tree as it stood when the rule landed, and each one is a case AECI-549 cited
 * when it recorded the rule as "feasible but not yet false-positive-free".
 */

// Vitest runs with cwd = apps/web (see vitest.config.ts).
const REPO_ROOT = join(process.cwd(), '..', '..');

/** Scan a single line as if it were the whole file. */
function hits(path: string, line: string): string[] {
  return scanFile(path, line).map((v) => v.ruleId);
}

const HTML = 'apps/web/src/app/some/component.html';
const CSS = 'apps/web/src/app/some/component.css';

describe('rule table', () => {
  it('declares the seven rules by stable id', () => {
    expect(RULES.map((r) => r.id)).toEqual([
      'logical-properties',
      'no-dark-variant',
      'no-dark-theme-css',
      'no-hex-color',
      'no-color-function',
      'no-tailwind-palette',
      'no-named-color-class',
    ]);
  });

  it('keeps the colour rules off `.ts`, so ESLint stays the sole owner there', () => {
    // Both layers matching the same file would double-report every violation.
    // It is also what keeps the two JSDoc blocks that document a token's hex
    // legal: comments are not AST nodes, so ESLint never sees them, but a line
    // scanner would.
    for (const id of ['no-hex-color', 'no-color-function', 'no-tailwind-palette']) {
      expect(RULES.find((r) => r.id === id)?.extensions).not.toContain('.ts');
    }
    expect(
      hits('apps/web/src/app/reviews/review-stars.ts', ' * (Goldenrod #DAA520 — the fill)'),
    ).toEqual([]);
  });
});

describe('colour rules fire on deliberate violations', () => {
  it('catches hex in markup and in CSS', () => {
    expect(hits(HTML, '<svg fill="#EA4335" />')).toContain('no-hex-color');
    expect(hits(CSS, '  color: #fff;')).toContain('no-hex-color');
    expect(hits(CSS, '  color: #1E3A2FCC;')).toContain('no-hex-color');
  });

  it('catches rgb/hsl/oklch that is not pure black', () => {
    expect(hits(CSS, '  color: rgb(255 0 0);')).toContain('no-color-function');
    expect(hits(CSS, '  color: hsl(210 40% 50%);')).toContain('no-color-function');
    expect(hits(CSS, '  --x: oklch(31.92% 0.0436 152.32);')).toContain('no-color-function');
    // The Tailwind arbitrary-value form. A `\b` anchor would MISS this: the
    // preceding `_` is a word character, so every arbitrary shadow would have
    // been silently exempt.
    expect(hits(HTML, '<div class="shadow-[0_4px_8px_rgb(255_0_0)]"></div>')).toContain(
      'no-color-function',
    );
  });

  it('catches raw palette classes and named colour classes', () => {
    expect(hits(HTML, '<div class="p-4 bg-zinc-100"></div>')).toContain('no-tailwind-palette');
    expect(hits(HTML, '<div class="hover:text-slate-500"></div>')).toContain('no-tailwind-palette');
    expect(hits(HTML, '<div class="border-gray-200 ring-red-950"></div>')).toContain(
      'no-tailwind-palette',
    );
    expect(hits(HTML, '<p class="bg-(--accent-primary) text-white">x</p>')).toContain(
      'no-named-color-class',
    );
    expect(hits(HTML, '<p class="text-white/80">x</p>')).toContain('no-named-color-class');
  });
});

describe('colour rules stay quiet on the near-misses that deferred them', () => {
  it('ignores id selectors whose name happens to be hex — the `#aec-` namespace', () => {
    // Every id in this app is namespaced `aec-`, and a/e/c are all hex digits.
    expect(
      hits(HTML, '<div id="aec-facet-panel" aria-labelledby="#aec-facet-label"></div>'),
    ).toEqual([]);
    expect(hits(CSS, '#aec-user-menu-pending { display: none; }')).toEqual([]);
  });

  it('ignores four-digit references and HTML numeric entities', () => {
    expect(hits(HTML, '<span>PO #4471, USD 5k/yr</span>')).toEqual([]);
    expect(hits(HTML, '<span aria-hidden="true">&#10003;</span>')).toEqual([]);
    // Three-digit entities need the leading `(?<!&)` guard, not the trailing
    // one: it excludes hex digits but not `;`, so `#160` completes on its own.
    expect(hits(HTML, '<span>10&#160;&#215;&#160;4&#169;</span>')).toEqual([]);
  });

  it('ignores the DESIGN.md pure-black shadow recipe in both spellings', () => {
    expect(hits(CSS, '  background-color: rgb(0 0 0 / 0.5);')).toEqual([]);
    expect(
      hits(
        HTML,
        '<div class="shadow-[0_16px_48px_-8px_rgb(0_0_0/0.18),0_4px_16px_-2px_rgb(0_0_0/0.10)]"></div>',
      ),
    ).toEqual([]);
  });

  it('ignores the sanctioned token vocabulary and the transparent keywords', () => {
    expect(hits(HTML, '<p class="bg-(--surface-raised) text-(--text-secondary)">x</p>')).toEqual(
      [],
    );
    expect(hits(HTML, '<p class="text-(--surface-base)/80">x</p>')).toEqual([]);
    expect(hits(HTML, '<p class="border border-transparent bg-transparent">x</p>')).toEqual([]);
    expect(hits(HTML, '<svg stroke="currentColor" fill="none"></svg>')).toEqual([]);
    expect(hits(HTML, '<a href="#main" class="text-3xl">Skip to content</a>')).toEqual([]);
  });
});

describe('allow list', () => {
  it('exempts styles.css and login.html from exactly the rules named', () => {
    const styles = COLOR_LITERAL_ALLOW.hex[0];
    const login = COLOR_LITERAL_ALLOW.hex[1];

    expect(hits(styles, '  --chart-series-1: #2a78d6;')).toEqual([]);
    expect(hits(styles, '  --surface-base: oklch(100% 0 0);')).toEqual([]);
    expect(hits(login, '<path fill="#EA4335" />')).toEqual([]);

    // login.html is exempt from hex ONLY — it is still covered by everything else.
    expect(hits(login, '<div class="bg-zinc-100"></div>')).toContain('no-tailwind-palette');
    expect(hits(login, '  color: rgb(255 0 0);')).toContain('no-color-function');
  });

  it('leaves the exempt files fully covered by the dark-theme rules', () => {
    // The exemption is per-RULE, not per-file, precisely so this holds. A
    // file-level skip would silently drop the AECI-226 light-only guard from the
    // one stylesheet most able to reintroduce a second theme.
    const styles = COLOR_LITERAL_ALLOW.hex[0];
    expect(hits(styles, '.theme-dark { --surface-base: #000; }')).toContain('no-dark-theme-css');
    expect(hits(styles, '@custom-variant dark (&:where(.dark, .dark *));')).toContain(
      'no-dark-theme-css',
    );
    expect(
      hits(COLOR_LITERAL_ALLOW.hex[1], '<div class="dark:bg-(--surface-base)"></div>'),
    ).toContain('no-dark-variant');
  });

  it('every allow-listed file exists and still contains what it is exempted for', () => {
    // An exemption nobody checks becomes a permanent hole the day the reason for
    // it is deleted. These assertions fail if the Google mark is ever recoloured
    // or the chart palette moves, which is the moment to drop the entry.
    const expectations: Array<[readonly string[], string, string]> = [
      [COLOR_LITERAL_ALLOW.hex, HEX_COLOR, 'hex'],
      [COLOR_LITERAL_ALLOW.colorFunction, COLOR_FUNCTION, 'colorFunction'],
    ];
    for (const [paths, pattern, name] of expectations) {
      for (const path of paths) {
        const full = join(REPO_ROOT, path);
        expect(existsSync(full), `${name} allow-lists a missing file: ${path}`).toBe(true);
        expect(
          new RegExp(pattern).test(readFileSync(full, 'utf8')),
          `${path} no longer needs its ${name} exemption — remove it`,
        ).toBe(true);
      }
    }
  });
});

describe('pre-existing rules (back-filled coverage — these had no test before)', () => {
  it('catches physical direction utilities but not axis or logical ones', () => {
    // The scanner reads `.ts` for this rule and has no test exemption, so a spec
    // that NAMES the banned utility in order to prove it is caught trips it.
    // That is exactly the case the escape hatch exists for — and these are its
    // first uses in the tree, which also makes them the proof that it works.
    // constraints-guard-allow-next-line: fixture must contain the banned utility
    expect(hits(HTML, '<div class="ml-2 sm:mr-4"></div>')).toContain('logical-properties');
    // constraints-guard-allow-next-line: fixture must contain the banned utility
    expect(hits(HTML, '<div class="text-left"></div>')).toContain('logical-properties');
    expect(hits(HTML, '<div class="mx-2 py-4 text-center ms-1 pe-3"></div>')).toEqual([]);
    expect(hits(HTML, '<p class="text-(--text-secondary)">x</p>')).toEqual([]);
  });

  it('catches `dark:` variants and dark-theme CSS, but not prose', () => {
    expect(hits(HTML, '<div class="p-4 dark:bg-(--surface-base)"></div>')).toContain(
      'no-dark-variant',
    );
    expect(hits(HTML, '<div class="md:dark:hidden"></div>')).toContain('no-dark-variant');
    expect(hits(CSS, '@media (prefers-color-scheme: dark) { :root { color: red } }')).toContain(
      'no-dark-theme-css',
    );
    expect(hits(CSS, '[data-theme="dark"] { color: red }')).toContain('no-dark-theme-css');
    expect(hits(HTML, '<p>Light and dark: a short history of themes.</p>')).toEqual([]);
  });
});

describe('escape hatch', () => {
  it('suppresses the following line only', () => {
    const file = [
      '<!-- constraints-guard-allow-next-line: documenting the banned form -->',
      '<div class="bg-zinc-100"></div>',
      '<div class="bg-slate-200"></div>',
    ].join('\n');
    const found = scanFile(HTML, file);
    expect(found.map((v) => v.line)).toEqual([3]);
  });
});

describe('pattern exports stay in sync with the rule table', () => {
  it('each colour rule uses the shared pattern, not a local copy', () => {
    const byId = Object.fromEntries(RULES.map((r) => [r.id, r.pattern.source]));
    expect(byId['no-hex-color']).toBe(new RegExp(HEX_COLOR).source);
    expect(byId['no-color-function']).toBe(new RegExp(COLOR_FUNCTION).source);
    expect(byId['no-tailwind-palette']).toBe(new RegExp(TAILWIND_PALETTE).source);
    expect(byId['no-named-color-class']).toBe(new RegExp(NAMED_COLOR_CLASS).source);
  });
});
