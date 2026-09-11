/**
 * Color-literal patterns (AECI-597) — the single source for the §20
 * "tokens, not literals" ban, shared by BOTH enforcement layers.
 *
 * ANGULAR_STYLE_GUIDE.md §20 bans hex, `rgb()`/`hsl()`/`oklch()`, and named
 * Tailwind color classes in components. AECI-549 deferred mechanizing it on two
 * measured false-positive classes; both are defeated below.
 *
 * WHY THIS FILE EXISTS AT ALL. The `dark:` constraint is spelled twice — once as
 * `DARK_VARIANT` in `eslint.config.base.mjs` and once in
 * `apps/web/scripts/check-source-constraints.mjs` — and nothing stops the two
 * drifting. The connector-lane `mechanism_kind` vocabulary reached SIX
 * independent spellings, two of which degrade silently, before AECI-735 added
 * lockstep tests. Colors get one definition instead, imported by:
 *
 *   - `eslint.config.base.mjs`                    → `.ts`, incl. inline templates
 *   - `apps/web/scripts/check-source-constraints.mjs` → `.html` and `.css`
 *   - `apps/web/src/source-constraints.spec.ts`   → the tests
 *
 * WHERE THIS FILE MUST LIVE. Repo root, `.mjs`, zero dependencies. Both are
 * load-bearing:
 *   - Root, because the line scanner walks `apps/web/src` and each package's
 *     ESLint run has its own basePath — a root file is outside every scanned
 *     tree, so these patterns cannot flag their own source.
 *   - Zero deps, because the scanner runs as a separate `node` process after
 *     `eslint .`; importing `eslint.config.base.mjs` would make it load
 *     typescript-eslint and angular-eslint for four regexes.
 *
 * PATTERNS ARE SOURCE STRINGS, NOT RegExp LITERALS. ESLint consumes them inside
 * esquery selectors (`Literal[value=/…/]`), the scanner consumes them as
 * `new RegExp(...)`. Same convention as `DARK_VARIANT`. Two consequences:
 *   - A literal backtick cannot appear inside a `String.raw` template, so the
 *     boundary classes spell it `\x60`.
 *   - `/` is written `\/` so it cannot terminate an esquery regex early.
 *
 * SCOPE: apps/web only. `apps/api/src/lib/{email,analytics-digest}.ts` hold 13
 * hex literals that are CORRECT — email clients do not support CSS custom
 * properties — and `apps/datatool/src/ui.ts` holds 28 more in an internal ops
 * Worker with no design system to migrate to. Neither needs an exemption
 * because neither is in reach: the ESLint half lives in `angularBase` (consumed
 * only by `apps/web/eslint.config.mjs`) and the scanner walks `apps/web/src`.
 * Do NOT move these into `CONSTRAINT_SYNTAX_SOURCE_ONLY` — that tier reaches
 * all four packages and would need 41 exemptions on day one.
 */

/**
 * Hex colors: `#RGB`, `#RRGGBB`, `#RRGGBBAA`.
 *
 * Longest-first alternation so `#EA4335` matches as six digits, not three.
 *
 * The `{4}` (`#RGBA`) branch is DELIBERATELY ABSENT, and that single omission is
 * what makes this rule usable. `#RGBA` has zero occurrences in the repo, and it
 * is exactly the shape of an issue or purchase-order reference — `PO #4471`,
 * `drizzle-orm #2226`, `#4522`. Without it, `#4471` cannot match at all: the
 * three-digit branch tries `#447` and the trailing guard rejects it because the
 * next character `1` is itself a hex digit. Restoring `{4}` re-opens that whole
 * class; don't, without re-measuring.
 *
 * The trailing `(?![0-9a-zA-Z_-])` guard is what AECI-549's deferral note asked
 * for. It kills the id-selector class: every id in this codebase is namespaced
 * `aec-`, and `a`/`e`/`c` are all hex digits, so `#aec-facet-panel` and
 * `#aec-user-menu-pending` would otherwise match on `#aec`.
 *
 * The leading `(?<!&)` guard kills HTML numeric entities. The trailing guard
 * alone only reaches the four-digit-and-longer ones — `&#10003;` fails because
 * `#100` is followed by `0` — but it excludes hex digits, NOT `;`, so a
 * THREE-digit entity completes the three-digit branch and matches. `&#160;`
 * (non-breaking space), `&#169;` and `&#215;` are all that shape. None is in
 * the tree today, which is why this reads as belt-and-braces; the first `&#160;`
 * written into a template would otherwise be reported as a hex colour. `&#`
 * never precedes a real colour literal, so the guard costs no coverage.
 *
 * KNOWN RESIDUALS, none present on the base branch and none preventable by
 * pattern without giving up real coverage:
 *
 *   1. An identifier spelled from only a-f — `#decade`, `#faced`, `#added` — as
 *      a fragment anchor, an element id, or an SVG `url(#id)` reference. Every
 *      `#name` token and every `url(#…)` in shipped `apps/web/src` was
 *      enumerated: the only all-hex hits are real colors, and there are no SVG
 *      id references at all.
 *   2. A THREE-DIGIT issue or PR reference — `(#328)`, `#510`. The four-digit
 *      form is handled by dropping `{4}`; the three-digit form cannot be,
 *      because `#000` and `#123` are legal colors with the same shape. The ones
 *      that exist live in `apps/web/e2e/` and `apps/api/`, neither of which this
 *      rule reaches.
 *
 * For either, use the guard's `constraints-guard-allow-next-line` escape hatch
 * (or `eslint-disable-next-line` on the `.ts` side) and say why.
 */
export const HEX_COLOR = String.raw`(?<!&)#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})(?![0-9a-zA-Z_-])`;

/**
 * CSS color functions. `lab()` and `lch()` are deliberately NOT in the list:
 * both are unused here and both are the tail of ordinary identifiers
 * (`collab(`), which would cost false positives for no coverage.
 *
 * THE PURE-BLACK CARVE-OUT IS REQUIRED, not a convenience. `DESIGN.md` §Shadows
 * specifies `rgb(0 0 0 / 0.18)` as the canonical Modal/Dialog shadow, and two
 * templates ship exactly that inside Tailwind arbitrary values
 * (`admin/reviews/review-queue.html`, `requests/request-drawer.html`), as does
 * the CDK backdrop in `styles.css`. The lookahead permits all-zero RGB channels
 * and nothing else, so `rgb(255 0 0)` is still caught.
 *
 * The separator class accepts space, underscore, and comma because Tailwind
 * arbitrary values encode spaces as underscores: `rgb(0_0_0/0.18)`.
 *
 * `(?<![A-Za-z])` rather than `\b`, and this matters: inside
 * `shadow-[0_16px_48px_-8px_rgb(...)]` the preceding character is `_`, which is
 * a word character — `\b` would not match there, silently exempting every
 * Tailwind arbitrary shadow from the rule. A letter lookbehind still keeps
 * `parseRgb(`-style identifiers clean.
 */
export const COLOR_FUNCTION = String.raw`(?<![A-Za-z])(?:rgba?|hsla?|oklch|oklab)\((?!\s*0[\s_,]+0[\s_,]+0\s*[\/,)])`;

/**
 * Tailwind's default palette used directly (`bg-zinc-100`, `text-slate-500`).
 *
 * Zero occurrences today, so this lands as a pure regression guard: the app uses
 * the paren-shortcut token form (`text-(--text-secondary)`) in ~4,850 places.
 *
 * Boundary-anchored exactly like `DARK_VARIANT`: start-of-line, whitespace, a
 * variant colon (so `hover:bg-zinc-100` matches), quote, or backtick.
 */
export const TAILWIND_PALETTE = String.raw`(^|[\s:"'\x60])(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to|decoration|shadow|accent|caret|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|950|[1-9]00)(?![0-9a-zA-Z-])`;

/**
 * The named-color classes `white` and `black`.
 *
 * `--surface-base` IS `#FFFFFF` (`styles.css`), so `text-white` was never an
 * unavoidable literal — just an inconsistency with the 64 sites already using
 * `text-(--surface-base)`. AECI-597 migrated the eight that existed.
 *
 * `bg-transparent` / `border-transparent` are deliberately NOT banned: they are
 * keywords with no token equivalent.
 *
 * The trailing guard keeps the opacity-modifier form in scope — `text-white/80`
 * is still a violation, because `/` is not in the excluded class.
 */
export const NAMED_COLOR_CLASS = String.raw`(^|[\s:"'\x60])(?:bg|text|border|ring|outline|fill|stroke|divide|from|via|to|decoration|caret|placeholder)-(?:white|black)(?![0-9a-zA-Z-])`;

/**
 * Files allowed to spell a color literal, by repo-relative path.
 *
 * Kept to two, and both are principled rather than grandfathered:
 *
 *  - `styles.css` is the TOKEN DEFINITION SITE. Colors are defined in exactly
 *    one place and that place has to write them down — the 17 `oklch()` tokens,
 *    their documented `/* #HEX *\/` cross-references, and the eight
 *    `--chart-series-*` values that `DESIGN.md` keeps outside `@theme inline`
 *    on purpose so they can never become Tailwind utilities.
 *  - `login.html` carries the Google "G" mark. Its four fills are fixed by the
 *    Sign-in-with-Google branding guidelines; recoloring them to `currentColor`
 *    would violate the terms. The reasoning is already recorded beside the
 *    assertion in `login.component.spec.ts`.
 *
 * Test files need no entry: the ESLint half sits in the `ignores: TEST_FILES`
 * block, and the scanner does not read `.ts` at all.
 */
export const COLOR_LITERAL_ALLOW = {
  hex: ['apps/web/src/styles.css', 'apps/web/src/app/auth/login.html'],
  colorFunction: ['apps/web/src/styles.css'],
};
