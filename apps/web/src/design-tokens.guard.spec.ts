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
 * `--border-*`, `--accent-*`, `--font-*`). Spartan/Tailwind preset internals
 * (`--radius`, `--spacing`, `--color-*`, `--tw-*`, …) are deliberately excluded —
 * they are defined outside `styles.css` and are not the bug class this guards.
 */

const SRC_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/src
const STYLES_PATH = join(SRC_DIR, 'styles.css');
const SELF = fileURLToPath(import.meta.url);

const SCANNED_EXTENSIONS = ['.ts', '.html', '.css'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.angular']);

/** App design-token namespaces this guard governs. */
const GUARDED_PREFIXES = /^(surface|text|border|accent|font)-/;

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
});
