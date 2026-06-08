#!/usr/bin/env node
/**
 * AECI-153 — RTL-safety guard. Fails the build if any *physical* direction
 * Tailwind utility creeps back into `apps/web/src`. We launch en-US (LTR) only,
 * but the "i18n from day one" constraint means the app must stay RTL-ready:
 * physical utilities (`ml-*`, `mr-*`, `pl-*`, `pr-*`, `text-left`, `text-right`)
 * render incorrectly under an RTL locale, where the logical equivalents
 * (`ms-*`, `me-*`, `ps-*`, `pe-*`, `text-start`, `text-end`) flip correctly.
 *
 * Why a grep guard and not an ESLint `no-restricted-syntax` rule: most of these
 * utilities live in external `.html` templates (and backtick-literal inline
 * templates), which the Angular ESLint template processor doesn't lint as
 * class-name strings. A line scanner over both `.ts` and `.html` is the only
 * thing that catches all of them. Wired into `apps/web`'s `lint` script so it
 * runs in CI via the root `pnpm lint` → `pnpm -r run lint` chain.
 *
 * Positional `left-*`/`right-*` (inset) utilities are intentionally NOT enforced
 * here — they have legitimate non-directional uses and were converted by hand
 * in the AECI-153 sweep. This guard enforces exactly the AC's token set.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Boundary-anchored so variant-prefixed utilities (`sm:mr-2`, `focus:ml-1`,
// `hover:text-right`) match, while axis utilities (`mx-`/`px-`/`my-`/`py-`),
// `text-center`, arbitrary values (`text-(--text-secondary)`), and substrings
// inside unrelated words/vars (`transform`, `--text-primary`, `(--border-...)`)
// do NOT. The leading class is whitespace / variant-colon / quote / backtick /
// start-of-line.
const PHYSICAL_UTILITY = /(^|[\s:"'`])(ml|mr|pl|pr)-|(^|[\s:"'`])text-(left|right)\b/;

/** Recursively collect every `.ts` / `.html` file under a directory. */
function collectFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.html')) {
      out.push(full);
    }
  }
  return out;
}

const violations = [];
for (const file of collectFiles(SRC_DIR)) {
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    if (PHYSICAL_UTILITY.test(line)) {
      violations.push({ file: relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(
    `\n✖ check-logical-properties: ${violations.length} physical direction utilit${
      violations.length === 1 ? 'y' : 'ies'
    } found in apps/web/src.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n      ${v.text}`);
  }
  console.error(
    '\n  Use RTL-safe logical properties instead (AECI-153):\n' +
      '      ml-* / mr-*        →  ms-* / me-*\n' +
      '      pl-* / pr-*        →  ps-* / pe-*\n' +
      '      text-left / -right  →  text-start / text-end\n' +
      '  (mx-*/px-*/my-*/py-* and text-center are axis/neutral — leave them.)\n',
  );
  process.exit(1);
}

console.log('✓ check-logical-properties: no physical direction utilities in apps/web/src.');
