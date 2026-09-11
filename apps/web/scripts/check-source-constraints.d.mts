/**
 * Types for `check-source-constraints.mjs` (AECI-549; colour rules AECI-597).
 *
 * The guard stays plain `.mjs` because `apps/web`'s `lint` script runs it with
 * bare `node`, no build step. This sibling declaration exists so
 * `apps/web/src/source-constraints.spec.ts` can import `RULES` and `scanFile`
 * under `tsc --noEmit` without an implicit `any`.
 *
 * Only the exported surface is described. The CLI walk (`main()`) runs on direct
 * invocation and is deliberately not exported — importing the module must not
 * scan the tree or call `process.exit`.
 */

/** One constraint the line scanner enforces on a file type ESLint cannot read. */
export interface SourceConstraintRule {
  /** Stable name, shown in the report and asserted by the spec. */
  readonly id: string;
  /** Suffixes this rule owns. Matched with `String.endsWith`, not globs. */
  readonly extensions: readonly string[];
  /** One non-global RegExp, tested per line. */
  readonly pattern: RegExp;
  /** Short noun phrase for the report header. */
  readonly label: string;
  /** Remediation text, printed once per violating rule. */
  readonly hint: string;
  /**
   * Repo-relative paths exempt from THIS rule only. Per-rule rather than
   * per-file on purpose: `styles.css` is exempt from the colour rules because it
   * is the token definition site, but stays fully covered by the dark-theme
   * rules.
   */
  readonly allow?: readonly string[];
}

/** A single line that matched a rule. */
export interface SourceConstraintViolation {
  readonly ruleId: string;
  readonly file: string;
  /** 1-indexed. */
  readonly line: number;
  readonly text: string;
}

export const RULES: readonly SourceConstraintRule[];

/**
 * Scan one file's contents. Pure — the CLI and the spec call the same function,
 * so the tests exercise the real matching rather than a copy of it.
 *
 * @param repoRelativePath used for both the extension check and the `allow` match
 */
export function scanFile(
  repoRelativePath: string,
  contents: string,
): readonly SourceConstraintViolation[];
