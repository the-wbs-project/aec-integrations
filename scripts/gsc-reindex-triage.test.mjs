// AECI-1941: --from-d1 must read the live production D1 by default, and must stop
// when the database it reached is not live. A fake `npx` on PATH stands in for
// wrangler, so nothing reaches Cloudflare or Google.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'gsc-reindex-triage.mjs');

// Answers `npx wrangler d1 execute <db> --remote --json --command <sql>` and logs
// every argv. FAKE_NEWEST is the newest job_runs.started_at ("" = no rows).
const FAKE_NPX = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(argv) + '\\n');
const sql = argv[argv.indexOf('--command') + 1] ?? '';
const results = sql.includes('job_runs')
  ? [{ newest: process.env.FAKE_NEWEST || null }]
  : [];
process.stdout.write(JSON.stringify([{ results, success: true }]));
`;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gsc-triage-test-'));
  writeFileSync(join(dir, 'npx'), FAKE_NPX);
  chmodSync(join(dir, 'npx'), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(env) {
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const childEnv = { ...process.env };
  for (const k of ['AECI_D1_DATABASE', 'AECI_ADMIN_TOKEN', 'AECI_ADMIN_COOKIE']) delete childEnv[k];
  Object.assign(childEnv, {
    PATH: `${dir}:${process.env.PATH}`,
    FAKE_LOG: log,
    GSC_TRIAGE_DIR: join(dir, 'triage'),
    ...env,
  });
  const res = spawnSync(process.execPath, [SCRIPT, '--from-d1', '--out', join(dir, 'r.json')], {
    env: childEnv,
    encoding: 'utf8',
  });
  const calls = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return { ...res, calls };
}

test('with no override it reads aeci-app-production-us, the live ENAM database', () => {
  const res = run({ FAKE_NEWEST: new Date().toISOString() });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(res.calls.length >= 2);
  for (const argv of res.calls) {
    assert.deepEqual(argv.slice(0, 4), ['wrangler', 'd1', 'execute', 'aeci-app-production-us']);
  }
  assert.match(res.stderr, /Worklist: 0 rows/);
});

test('a database with no recent job_runs row stops the run before the queue read', () => {
  const stale = new Date(Date.now() - 46 * 24 * 3600e3).toISOString();
  const res = run({ FAKE_NEWEST: stale, AECI_D1_DATABASE: 'aeci-app-production' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /aeci-app-production is not the live production database/);
  assert.equal(res.calls.length, 1, 'only the liveness read ran');
  assert.match(res.calls[0].at(-1), /job_runs/);
});

test('a database with no job_runs rows at all stops the run', () => {
  const res = run({ FAKE_NEWEST: '' });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /newest job_runs row is missing/);
});
