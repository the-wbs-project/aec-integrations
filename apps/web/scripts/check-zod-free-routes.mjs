#!/usr/bin/env node
/**
 * AECI-2033: fail when a public route that needs no zod loads the zod chunk.
 *
 * A bundler cannot prove a Zod schema builder chain is pure. So one value import
 * from a module that builds schemas at the top level keeps that module, its
 * schemas and the whole of zod (428 kB raw, 78 kB transferred). The route chunk
 * then imports the zod chunk, and the page downloads it while it hydrates. The
 * bundle budget cannot see this, because the zod chunk is lazy.
 *
 * CI runs it in the required `Build SSR Worker` job (`.github/workflows/deploy.yml`),
 * so a regression blocks the merge. Locally, run it after a build made with
 * `--stats-json`:
 *
 *   pnpm --filter @aeci/web build:stats
 *   pnpm --filter @aeci/web check:zod-free-routes
 *
 * It reads `dist/browser-stats.json` (the esbuild metafile), finds every chunk that
 * holds any module of the zod package, and walks every static import from each route
 * chunk listed below. A route that reaches any of those chunks fails the check.
 *
 * To fix a failure, find the shared module that brought zod in. Move the pure
 * constant or function the page needs into a zod-free file, and add that file to
 * `ZOD_FREE_API_MODULES` in `packages/shared/eslint.config.mjs`. See
 * `packages/shared/README.md` "Zod-free modules".
 *
 * Add a route here only when it needs no zod. A page with a form that validates
 * against a shared schema needs zod and does not belong on this list.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Route entry points (relative to `src/app/`) that must not load zod. */
export const ZOD_FREE_ROUTES = [
  'home/home.ts',
  'about/about.ts',
  'methodology/methodology.ts',
  'vendor-program/vendor-program.ts',
  'docs/docs.routes.ts',
  'docs/docs-home.ts',
  'docs/docs-page.ts',
  'docs/docs-section.ts',
  'docs/docs-archive-page.ts',
  'legal/legal-page.ts',
  'legal/legal-in-force.resolver.ts',
];

/** A metafile input that is part of the zod package, under any subpath. */
const ZOD_INPUT = /(^|\/)node_modules\/(\.pnpm\/zod@[^/]+\/node_modules\/)?zod\//;

/**
 * @param {{ outputs: Record<string, { entryPoint?: string, imports?: { path: string, kind: string }[], inputs: Record<string, unknown> }> }} metafile
 * @param {readonly string[]} routes
 * @returns {{ missing: string[], failures: { route: string, path: string[] }[] }}
 */
export function findZodRoutes(metafile, routes) {
  const outputs = metafile.outputs;
  // Every chunk that holds ANY zod module, not only the one with `zod/index.js`. A
  // `zod/v4` or `zod/mini` import can put the implementation in a different chunk
  // from the `zod` entry module, and a route can reach that chunk alone.
  const zodChunks = new Set(
    Object.keys(outputs).filter((o) =>
      Object.keys(outputs[o].inputs).some((i) => ZOD_INPUT.test(i)),
    ),
  );
  const missing = [];
  const failures = [];
  for (const route of routes) {
    const start = Object.keys(outputs).find((o) =>
      outputs[o].entryPoint?.endsWith(`src/app/${route}`),
    );
    if (!start) {
      missing.push(route);
      continue;
    }
    const prev = new Map([[start, null]]);
    const queue = [start];
    let hit = zodChunks.has(start) ? start : null;
    while (queue.length > 0 && !hit) {
      const chunk = queue.shift();
      for (const imp of outputs[chunk]?.imports ?? []) {
        if (imp.kind !== 'import-statement' || prev.has(imp.path)) continue;
        prev.set(imp.path, chunk);
        if (zodChunks.has(imp.path)) {
          hit = imp.path;
          break;
        }
        queue.push(imp.path);
      }
    }
    if (hit) {
      const path = [];
      for (let c = hit; c; c = prev.get(c)) path.unshift(c);
      failures.push({ route, path });
    }
  }
  return { missing, failures };
}

function main() {
  const statsPath = join(process.cwd(), 'dist', 'browser-stats.json');
  let metafile;
  try {
    metafile = JSON.parse(readFileSync(statsPath, 'utf8'));
  } catch {
    console.error(`check-zod-free-routes: ${statsPath} not found. Build with --stats-json first.`);
    process.exit(2);
  }
  const { missing, failures } = findZodRoutes(metafile, ZOD_FREE_ROUTES);
  for (const route of missing) {
    console.error(
      `check-zod-free-routes: no chunk has entry point src/app/${route}. Update ZOD_FREE_ROUTES.`,
    );
  }
  for (const { route, path } of failures) {
    const inputs = (o) =>
      Object.keys(metafile.outputs[o].inputs)
        .filter((i) => !i.includes('node_modules') && !i.startsWith('angular:'))
        .slice(0, 4)
        .join(', ');
    console.error(`check-zod-free-routes: ${route} loads the zod chunk. Import path:`);
    for (const chunk of path) console.error(`  ${chunk}  ${inputs(chunk)}`);
  }
  if (missing.length > 0 || failures.length > 0) process.exit(1);
  console.log(`check-zod-free-routes: ${ZOD_FREE_ROUTES.length} routes load no zod.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
