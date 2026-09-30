// AECI-1163: write a copy of a wrangler.jsonc with every cron trigger and every
// route removed, for deploying to the WBS account before cutover.
//
// No crons: the WBS copies must not run the digest, alert or sync jobs a second
// time while the old account is still live. No routes: the custom domains can only
// bind once the WBS zone is Active, and they belong to the old Workers until then.
// `--workers-dev` also turns the workers.dev route on, so the rehearsal is reachable.
//
// Usage: node strip-config.mjs <in.jsonc> <out.json> [--workers-dev]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(fileURLToPath(new URL('../../../apps/api/package.json', import.meta.url)));
const ts = require('typescript');

const [input, output, flag] = process.argv.slice(2);
const parsed = ts.parseConfigFileTextToJson(input, readFileSync(input, 'utf8'));
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
const config = parsed.config;

function strip(block) {
  delete block.routes;
  if (block.triggers) block.triggers = { crons: [] };
  if (flag === '--workers-dev') block.workers_dev = true;
}
strip(config);
for (const env of Object.values(config.env ?? {})) strip(env);

writeFileSync(output, JSON.stringify(config, null, 2));
