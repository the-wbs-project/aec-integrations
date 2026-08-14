#!/usr/bin/env node
/**
 * Source-constraint guard for `apps/web/src` — the half of CLAUDE.md
 * §"Constraints that aren't negotiable" that ESLint structurally cannot see.
 *
 * Division of labour (AECI-549). ESLint owns the TypeScript AST: imports,
 * identifiers, member access, string and template literals. That covers `.ts`,
 * including inline component templates, because those are template literals.
 * It does NOT cover two places real violations hide:
 *
 *   1. Tailwind class strings in *external* `.html` templates. The Angular
 *      ESLint template processor parses them into a template AST and does not
 *      expose class names as lintable string literals.
 *   2. Selectors and at-rules in `.css`. Nothing in the toolchain lints CSS —
 *      there is no stylelint in this repo.
 *
 * A line scanner is the only thing that catches both. Each rule below therefore
 * declares the extensions it owns, and the dark-theme rules deliberately omit
 * `.ts` so they never double-report against the ESLint selectors in
 * `eslint.config.base.mjs`.
 *
 * Wired into `apps/web`'s `lint` script so it runs in CI via the root
 * `pnpm lint` → `pnpm -r run lint` chain.
 *
 * Escape hatch: put `constraints-guard-allow-next-line` in a comment on the
 * preceding line. Use it sparingly and say why — this exists so a comment that
 * legitimately *names* a banned pattern (documenting why it's banned) doesn't
 * make the file uneditable.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const ALLOW_MARKER = 'constraints-guard-allow-next-line';

const RULES = [
  {
    id: 'logical-properties',
    // AECI-153 — RTL safety. We launch en-US (LTR) only, but the "i18n from day
    // one" constraint means the app must stay RTL-ready: physical utilities
    // (`ml-*`, `mr-*`, `pl-*`, `pr-*`, `text-left`, `text-right`) render
    // incorrectly under an RTL locale, where the logical equivalents (`ms-*`,
    // `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`) flip correctly.
    //
    // Boundary-anchored so variant-prefixed utilities (`sm:mr-2`, `focus:ml-1`,
    // `hover:text-right`) match, while axis utilities (`mx-`/`px-`/`my-`/`py-`),
    // `text-center`, arbitrary values (`text-(--text-secondary)`), and
    // substrings inside unrelated words/vars (`transform`, `--text-primary`,
    // `(--border-...)`) do NOT.
    //
    // Positional `left-*`/`right-*` (inset) utilities are intentionally NOT
    // enforced — they have legitimate non-directional uses and were converted by
    // hand in the AECI-153 sweep. This rule enforces exactly the AC's token set.
    //
    // `.ts` is in scope here (unlike the dark-theme rules below) because ESLint
    // has no equivalent check for these — there is no `no-restricted-syntax`
    // selector for them in `eslint.config.base.mjs`.
    extensions: ['.ts', '.html'],
    pattern: /(^|[\s:"'`])(ml|mr|pl|pr)-|(^|[\s:"'`])text-(left|right)\b/,
    label: 'physical direction utility',
    hint:
      '  Use RTL-safe logical properties instead (AECI-153):\n' +
      '      ml-* / mr-*         →  ms-* / me-*\n' +
      '      pl-* / pr-*         →  ps-* / pe-*\n' +
      '      text-left / -right  →  text-start / text-end\n' +
      '  (mx-*/px-*/my-*/py-* and text-center are axis/neutral — leave them.)',
  },
  {
    id: 'no-dark-variant',
    // AECI-226 / AECI-549 — light only for Stage 1. Same boundary anchoring as
    // the ESLint selector in `eslint.config.base.mjs`: the leading class allows
    // a stacked variant colon (`md:dark:bg-x`), and the trailing `[a-z[(-]`
    // requires a real utility to follow, so prose ("light and dark: themes")
    // does not match. `.ts` is omitted — ESLint already owns it.
    extensions: ['.html', '.css'],
    pattern: /(^|[\s:"'`])dark:[a-z[(-]/,
    label: '`dark:` Tailwind variant',
    hint:
      '  Stage 1 ships a single light theme (AECI-226) — no `dark:` variants.\n' +
      '  Dark returns with the Stage 2 vendor portal as a semantic-token block,\n' +
      '  not as scattered utilities. See CLAUDE.md "Light only (Stage 1)".',
  },
  {
    id: 'no-dark-theme-css',
    // The CSS-side re-introduction vectors for a second theme: the `.theme-dark`
    // block itself, the Tailwind v4 `@custom-variant dark` re-declaration, a
    // system-preference media query, and `[data-theme=…]` attribute switching.
    extensions: ['.css', '.html'],
    pattern:
      /\.theme-dark\b|@custom-variant\s+dark\b|prefers-color-scheme\s*:\s*dark|\[data-theme[~^|$*]?=/,
    label: 'dark-theme selector / media query',
    hint:
      '  Stage 1 has one theme and no system-preference detection (AECI-226).\n' +
      '  No `.theme-dark` block, no `@custom-variant dark`, no\n' +
      '  `prefers-color-scheme: dark`, no `[data-theme]` switching.\n' +
      '  See CLAUDE.md "Light only (Stage 1)".',
  },
];

const ALL_EXTENSIONS = [...new Set(RULES.flatMap((r) => r.extensions))];

/** Recursively collect every file under a directory with a scanned extension. */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (ALL_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const violationsByRule = new Map();
for (const file of collectFiles(SRC_DIR)) {
  const applicable = RULES.filter((r) => r.extensions.some((ext) => file.endsWith(ext)));
  if (applicable.length === 0) continue;

  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (i > 0 && lines[i - 1].includes(ALLOW_MARKER)) return;
    for (const rule of applicable) {
      if (!rule.pattern.test(line)) continue;
      if (!violationsByRule.has(rule.id)) violationsByRule.set(rule.id, []);
      violationsByRule.get(rule.id).push({
        file: relative(REPO_ROOT, file),
        line: i + 1,
        text: line.trim(),
      });
    }
  });
}

if (violationsByRule.size > 0) {
  const total = [...violationsByRule.values()].reduce((n, v) => n + v.length, 0);
  console.error(
    `\n✖ check-source-constraints: ${total} violation${total === 1 ? '' : 's'} in apps/web/src.\n`,
  );
  for (const rule of RULES) {
    const hits = violationsByRule.get(rule.id);
    if (!hits) continue;
    console.error(`  [${rule.id}] ${hits.length} × ${rule.label}:`);
    for (const v of hits) {
      console.error(`    ${v.file}:${v.line}\n        ${v.text}`);
    }
    console.error(`\n${rule.hint}\n`);
  }
  process.exit(1);
}

console.log(`✓ check-source-constraints: ${RULES.length} rules clean across apps/web/src.`);
