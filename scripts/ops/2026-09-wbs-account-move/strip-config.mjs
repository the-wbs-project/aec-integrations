// AECI-1163: write a copy of a wrangler.jsonc with every cron trigger and every
// route removed, for deploying to the WBS account before cutover.
//
// No crons: the WBS copies must not run the digest, alert or sync jobs a second
// time while the old account is still live. No routes: the custom domains can only
// bind once the WBS zone is Active, and they belong to the old Workers until then.
// `--workers-dev` also turns the workers.dev route on, so the rehearsal is reachable.
//
// `--crons-only` keeps routes and only empties the crons; `--account <id>` overrides
// account_id. Together they let the cutover stop the OLD account's crons with
// `wrangler triggers deploy` without touching anything else.
//
// Usage: node strip-config.mjs <in.jsonc> <out.json> [--workers-dev] [--crons-only] [--account <id>]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(
  fileURLToPath(new URL('../../../apps/api/package.json', import.meta.url)),
);
const ts = require('typescript');

const [input, output, ...flags] = process.argv.slice(2);
const workersDev = flags.includes('--workers-dev');
const cronsOnly = flags.includes('--crons-only');
const accountAt = flags.indexOf('--account');
const parsed = ts.parseConfigFileTextToJson(input, readFileSync(input, 'utf8'));
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
const config = parsed.config;

function strip(block) {
  if (!cronsOnly) delete block.routes;
  if (block.triggers) block.triggers = { crons: [] };
  if (workersDev) block.workers_dev = true;
}
if (accountAt !== -1) config.account_id = flags[accountAt + 1];
strip(config);
for (const env of Object.values(config.env ?? {})) strip(env);

writeFileSync(output, JSON.stringify(config, null, 2));
