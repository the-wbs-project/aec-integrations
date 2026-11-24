/**
 * Types for `check-zod-free-routes.mjs` (AECI-2033).
 *
 * The check stays plain `.mjs` so it runs with bare `node` after a build. This
 * declaration lets `src/zod-free-routes.spec.ts` import it under `tsc --noEmit`.
 * Importing the module does not read `dist/` or call `process.exit`.
 */

/** The slice of the esbuild metafile the check reads. */
export interface ZodCheckMetafile {
  readonly outputs: Readonly<
    Record<
      string,
      {
        readonly entryPoint?: string;
        readonly imports?: readonly { readonly path: string; readonly kind: string }[];
        readonly inputs: Readonly<Record<string, unknown>>;
      }
    >
  >;
}

export interface ZodCheckResult {
  /** Routes with no chunk in the build. The list is stale. */
  readonly missing: string[];
  /** Routes that reach the zod chunk, each with the chunk path that does it. */
  readonly failures: { readonly route: string; readonly path: string[] }[];
}

export declare const ZOD_FREE_ROUTES: readonly string[];

export declare function findZodRoutes(
  metafile: ZodCheckMetafile,
  routes: readonly string[],
): ZodCheckResult;
