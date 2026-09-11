/**
 * Types for `eslint.color-patterns.mjs` (AECI-597).
 *
 * The module stays plain `.mjs` because ESLint flat config and the line scanner
 * both load it directly at runtime, with no build step between. This sibling
 * declaration exists only so `apps/web/src/source-constraints.spec.ts` can
 * import it under `tsc --noEmit` without an implicit `any`.
 *
 * Patterns are REGEX SOURCE STRINGS, not RegExp objects: ESLint interpolates
 * them into esquery selectors (`Literal[value=/.../]`) while the scanner wraps
 * them in `new RegExp(...)`. See the module header for the full rationale.
 */

/** Hex colours: `#RGB`, `#RRGGBB`, `#RRGGBBAA`. `#RGBA` is deliberately absent. */
export const HEX_COLOR: string;

/** `rgb()`/`rgba()`/`hsl()`/`hsla()`/`oklch()`/`oklab()`, excluding pure black. */
export const COLOR_FUNCTION: string;

/** Tailwind's default palette used directly, e.g. `bg-zinc-100`. */
export const TAILWIND_PALETTE: string;

/** The `white` / `black` named colour classes. `transparent` stays allowed. */
export const NAMED_COLOR_CLASS: string;

/** Repo-relative paths exempt from a given colour rule. */
export const COLOR_LITERAL_ALLOW: {
  readonly hex: readonly string[];
  readonly colorFunction: readonly string[];
};
