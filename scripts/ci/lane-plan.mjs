#!/usr/bin/env node
/**
 * Decides which CI lane a deploy.yml run takes, and which workspace packages it covers.
 *
 *   full  every push, every PR into `main`, and any PR into `batch/**` that touches a
 *         root-level file, deletes any file, or hits a planning error. Runs exactly
 *         what the lane ran before this script existed.
 *   lite  a PR into `batch/**` whose changes sit inside `apps/<x>/` or `packages/<x>/`
 *         (or are Markdown). Lint, typecheck and unit tests run only for the changed
 *         packages plus their dependents (pnpm `...[<base>]`) and their hidden readers
 *         (HIDDEN_READERS below). E2E is skipped.
 *
 * The batch-branch procedure that uses the lite lane is docs/CICD_PLAN.md §10a.
 *
 * Every deploy.yml job that needs the answer runs this script itself, so no required
 * check ever depends on another job's outputs. A job whose `needs:` failed is SKIPPED,
 * and GitHub counts a skipped required check as passing. Running the plan in-job means
 * a broken plan can never make a job silently green. A git or pnpm error while planning
 * the lite lane falls back to the full lane with a warning annotation. Any file deletion
 * (including the old side of a rename) also takes the full lane.
 *
 * Inputs (env): EVENT_NAME (github.event_name), BASE_REF (github.base_ref).
 * The PR checkout must be the merge ref with fetch-depth >= 2, so HEAD^1 is the base tip.
 *
 * Outputs (appended to $GITHUB_OUTPUT, all strings):
 *   lane         full | lite
 *   api          true when the apps/api unit job has work
 *   web          true when apps/web is in scope (gates the SSR build in the lite lane)
 *   rest         true when the non-api unit job has work
 *   lint_filter  pnpm filter args for lint + typecheck in the lite lane ("" = none)
 *   rest_filter  pnpm filter args for the non-api unit job
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const API_PACKAGE = '@aeci/api';
export const WEB_PACKAGE = '@aeci/web';

/** A path the lite lane may scope by package. Anything else forces the full lane. */
const PACKAGE_PATH = /^(apps|packages)\/[^/]+\//;

/**
 * Returns the files that force the full lane. Markdown outside a package changes no
 * lint, typecheck or unit outcome: the lite lint still runs the CLAUDE.md size gate,
 * the NOTIFICATIONS.md drift check and a whole-repo Prettier check. Every other
 * root-level file (lockfile, root package.json, tsconfig, ESLint or Prettier config,
 * .github/**, scripts/**, docs/*.json read by the API specs) can change any package.
 */
export function rootLevelFiles(changedFiles) {
  return changedFiles.filter((f) => f !== '' && !PACKAGE_PATH.test(f) && !f.endsWith('.md'));
}

/**
 * Hidden readers: specs that read another package's files by relative path. pnpm only
 * sees declared dependencies, so these edges are added by hand. Each entry maps a
 * changed-path prefix to the packages whose specs read under it.
 *
 *   docs/                  apps/api's notifications registry spec asserts every
 *                          `docs/X.md §Y` pointer resolves to a real heading.
 *   apps/datatool/         apps/agent/src/access.spec.ts byte-compares its access.ts
 *                          with the datatool copy. apps/api imports and scans datatool
 *                          source (algolia-builder-parity, count-lockstep,
 *                          review-reply-ranking-firewall).
 *   apps/agent/            apps/api's count-lockstep spec scans agent source.
 *   apps/api/migrations/   apps/datatool and apps/agent apply the api migrations in
 *                          their test D1 (src/test/d1.ts).
 *   apps/api/src/,         packages/shared's version-diff consult-sites spec scans
 *   apps/web/src/          both trees.
 *   apps/api/eslint.config apps/web/src/eslint-config.spec.ts resolves apps/api's ESLint
 *                          config for api fixture files. Editing those fixtures cannot
 *                          change the resolved config, and deleting one forces the full
 *                          lane, so the config file is the only edge.
 *
 * A new spec that reads across packages needs a row here, or the lite lane will skip it.
 */
export const HIDDEN_READERS = [
  ['docs/', [API_PACKAGE]],
  ['apps/datatool/', ['@aeci/agent', API_PACKAGE]],
  ['apps/agent/', [API_PACKAGE]],
  ['apps/api/migrations/', ['@aeci/datatool', '@aeci/agent']],
  ['apps/api/src/', ['@aeci/shared']],
  ['apps/web/src/', ['@aeci/shared']],
  ['apps/api/eslint.config', [WEB_PACKAGE]],
];

/** Adds every hidden reader of a changed path to the affected set, keeping order. */
export function withHiddenReaders(affected, changedFiles) {
  const out = [...affected];
  for (const [prefix, readers] of HIDDEN_READERS) {
    if (!changedFiles.some((f) => f.startsWith(prefix))) continue;
    for (const name of readers) if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Parses `git diff --name-status --no-renames` output into { status, path } rows.
 * `--no-renames` reports a rename as a D of the old path plus an A of the new one, so
 * the losing side is never hidden.
 */
export function parseNameStatus(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status.trim(), path: rest.join('\t') };
    });
}

const filterArgs = (names) => names.flatMap((n) => ['--filter', n]).join(' ');

/** The full lane: every package, exactly as before. */
export function fullPlan() {
  return {
    lane: 'full',
    api: 'true',
    web: 'true',
    rest: 'true',
    lint_filter: '',
    // Every workspace project except apps/api and the root. The root must be excluded
    // by name: its own `test:unit` script recurses into every package, apps/api included.
    rest_filter: filterArgs([`!${API_PACKAGE}`, '!{.}']),
  };
}

/** The lite lane, from the affected workspace package names (root already removed). */
export function litePlan(affected) {
  const rest = affected.filter((n) => n !== API_PACKAGE);
  return {
    lane: 'lite',
    api: String(affected.includes(API_PACKAGE)),
    web: String(affected.includes(WEB_PACKAGE)),
    rest: String(rest.length > 0),
    lint_filter: filterArgs(affected),
    rest_filter: filterArgs(rest),
  };
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function affectedPackages(since, rootName) {
  const out = execFileSync(
    'pnpm',
    ['ls', '--recursive', '--depth', '-1', '--json', '--filter', `...[${since}]`],
    { encoding: 'utf8' },
  );
  return JSON.parse(out)
    .map((p) => p.name)
    .filter((n) => n !== rootName);
}

const realDeps = {
  git,
  affectedPackages,
  rootName: () => JSON.parse(readFileSync('package.json', 'utf8')).name,
};

/**
 * The lite-lane decision. Throws on any git or pnpm failure; `plan()` turns a throw
 * into the full lane.
 */
function planBatchPr(deps) {
  // The pull_request checkout is a merge commit: parent 1 is the base tip, parent 2 the
  // PR head. Anything else means we cannot trust the diff, so run everything.
  try {
    deps.git('rev-parse', '--verify', '--quiet', 'HEAD^2');
  } catch {
    return { plan: fullPlan(), why: 'HEAD is not a PR merge commit' };
  }

  const rows = parseNameStatus(deps.git('diff', '--name-status', '--no-renames', 'HEAD^1', 'HEAD'));

  // A deletion can remove a whole package, or a file another package reads. pnpm's
  // `...[<base>]` filter only knows packages that still exist in the working tree, so
  // it cannot see that losing side. Any deletion therefore runs everything.
  const deleted = rows.filter((r) => r.status.startsWith('D')).map((r) => r.path);
  if (deleted.length > 0) {
    return { plan: fullPlan(), why: `files deleted: ${deleted.join(', ')}` };
  }

  const changed = rows.map((r) => r.path);
  const forcing = rootLevelFiles(changed);
  if (forcing.length > 0) {
    return { plan: fullPlan(), why: `root-level files changed: ${forcing.join(', ')}` };
  }

  const affected = withHiddenReaders(deps.affectedPackages('HEAD^1', deps.rootName()), changed);
  return { plan: litePlan(affected), why: `affected packages: ${affected.join(', ') || 'none'}` };
}

/**
 * Returns { plan, why, warning? }. A planning error in the lite branch never fails the
 * job: it falls back to the full lane and sets `warning`, which main() prints as a
 * `::warning::` annotation (docs/CICD_PLAN.md §10a).
 */
export function plan(env, deps = realDeps) {
  const isBatchPr = env.EVENT_NAME === 'pull_request' && (env.BASE_REF ?? '').startsWith('batch/');
  if (!isBatchPr) return { plan: fullPlan(), why: 'not a PR into batch/**' };

  try {
    return planBatchPr(deps);
  } catch (err) {
    const message = String(err?.message ?? err).split('\n')[0];
    return {
      plan: fullPlan(),
      why: 'planning failed, falling back to the full lane',
      warning: `lane-plan could not plan the lite lane, so this run takes the full lane: ${message}`,
    };
  }
}

function main() {
  const { plan: result, why, warning } = plan(process.env);
  if (warning) console.log(`::warning::${warning}`);
  const lines = Object.entries(result).map(([k, v]) => `${k}=${v}`);
  console.log(`lane-plan: ${result.lane} (${why})`);
  for (const line of lines) console.log(`  ${line}`);
  // Written once, at the end, so a failure part-way never leaves half a plan behind.
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
