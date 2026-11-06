#!/usr/bin/env node
// Backfill the AECI-1614 edit stamps and plan-end mirrors. See README.md.
// Dry run by default. `--apply` writes. Production also needs `--allow-production`.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PLAN, projectionSql, updateSql } from './plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WRANGLER = join(ROOT, 'apps/api/node_modules/.bin/wrangler');
const CONFIG = join(ROOT, 'apps/api/wrangler.jsonc');

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const env = envIndex >= 0 ? args[envIndex + 1] : undefined;
const apply = args.includes('--apply');
const allowProduction = args.includes('--allow-production');

if (!['local', 'preview', 'staging', 'demo', 'production'].includes(env)) {
  console.error(
    'usage: run.mjs --env <local|preview|staging|demo|production> [--apply] [--allow-production]',
  );
  process.exit(2);
}
if (env === 'production' && apply && !allowProduction) {
  console.error('REFUSING: production writes need --allow-production.');
  process.exit(1);
}

/** `--command`, never `--file`: wrangler's bulk-import path returns no rows. */
function d1(sql) {
  const target = env === 'local' ? ['--local'] : ['--env', env, '--remote', '--config', CONFIG];
  const out = execFileSync(
    WRANGLER,
    ['d1', 'execute', 'DB', ...target, '--json', '--command', sql],
    {
      cwd: join(ROOT, 'apps/api'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  return JSON.parse(out)[0];
}

console.log(`target: ${env} (${apply ? 'APPLY' : 'DRY RUN'})`);
for (const entry of PLAN) {
  const [row] = d1(projectionSql(entry)).results;
  console.log(JSON.stringify(row));
  if (apply && row.would_write > 0) {
    const { meta } = d1(updateSql(entry));
    console.log(`  wrote ${meta?.changes ?? 'unknown'} row(s)`);
  }
}
if (!apply) console.log('Dry run: nothing written. Re-run with --apply to write.');
