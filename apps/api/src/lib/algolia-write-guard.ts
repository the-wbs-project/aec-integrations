/**
 * Local Algolia write guard (AECI-1268).
 *
 * The per-PR preview tier retired on 2026-10-10, and with it the `preview_*`
 * index set that local runs used to ride. A local run (`ENV` = `development`, or
 * unset) now folds onto `staging_*` (`indexPrefixForEnv` in `@aeci/shared/algolia`)
 * so local `/search` has real data to read.
 *
 * Reading staging is fine. Writing it is not: one Algolia application backs every
 * tier, the management key in `.dev.vars` reaches every index, and a local promote,
 * owner write, sync cron or drift sweep would otherwise mutate the indexes staging
 * serves. So every Worker path that mutates an index asks this module first. On a
 * local run the answer is "no", logged once per isolate, unless the developer
 * opts in explicitly with `ALGOLIA_ALLOW_LOCAL_WRITES=true` in `apps/api/.dev.vars`.
 *
 * "Local" is decided by allowlist, not denylist: only the three deployed tiers may
 * write. A stale `ENV=preview` left in a `.dev.vars`, or any other unknown label,
 * is treated as local too.
 *
 * Mutation sites that consult this guard:
 *   - `runAlgoliaSync` (the daily sync cron, `scheduled.ts`)
 *   - the orphan-sweep half of `runAlgoliaDrift` (`scheduled.ts`). The drift
 *     MEASUREMENT half only reads, so it still runs.
 *   - the promote post-commit `algolia-sync` hook (`routes/promote.ts`)
 *   - `syncOwnerWriteSearch` (`routes/integration-retire-write.ts`), the shared
 *     tail of every vendor/admin owner write (retire, edit, create, contest
 *     accept, field override, evidenced-pair edit)
 *
 * Not covered, by design: the operator scripts (`scripts/algolia/*.mjs`,
 * `apps/api/scripts/*.ts`) and `apps/datatool` all take an explicit named tier
 * and never resolve to `development`.
 */

/** The `.dev.vars` key that opts a local run into Algolia writes. */
export const ALGOLIA_LOCAL_WRITE_OPT_IN = 'ALGOLIA_ALLOW_LOCAL_WRITES';

/** The tiers allowed to write their own index set without an opt-in. */
const DEPLOYED_TIERS: ReadonlySet<string> = new Set(['staging', 'demo', 'production']);

/** The slice of the Worker `Env` the guard reads. */
export interface AlgoliaWriteGuardEnv {
  ENV?: string;
  ALGOLIA_ALLOW_LOCAL_WRITES?: string;
}

let warned = false;

/**
 * True when this run may mutate Algolia indexes: a deployed tier, or a local run
 * whose `ALGOLIA_ALLOW_LOCAL_WRITES` is exactly `"true"`.
 */
export function algoliaWritesAllowed(env: AlgoliaWriteGuardEnv): boolean {
  if (env.ENV !== undefined && DEPLOYED_TIERS.has(env.ENV)) return true;
  return env.ALGOLIA_ALLOW_LOCAL_WRITES === 'true';
}

/**
 * The guard as call sites use it. Returns `true` when the write may proceed. On a
 * blocked local run it returns `false` and logs ONE warning per isolate, naming
 * the first site that was refused and the opt-in, so the no-op is never silent
 * and never noisy.
 */
export function guardAlgoliaWrite(env: AlgoliaWriteGuardEnv, site: string): boolean {
  if (algoliaWritesAllowed(env)) return true;
  if (!warned) {
    warned = true;
    console.warn(
      `algolia-write-guard: skipped ${site}. A local run (ENV=${env.ENV ?? 'unset'}) ` +
        `reads staging_* but never writes it. Set ${ALGOLIA_LOCAL_WRITE_OPT_IN}=true in ` +
        `apps/api/.dev.vars to write staging_* on purpose. Further skips are not logged.`,
    );
  }
  return false;
}

/** Test seam: re-arm the once-per-isolate warning. */
export function resetAlgoliaWriteGuardWarning(): void {
  warned = false;
}
