/**
 * `scripts/ci/posthog-liveness-sweep.sh`, the `activeFrom` grace (AECI-1221). Runs the real
 * script (real `jq`, real `curl`, real exit codes) against a local stub that answers in the
 * PostHog query-API envelope, the same approach as the README drill. Runs under
 * `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ci', 'posthog-liveness-sweep.sh');

const hasTool = (tool) => {
  try {
    execFileSync('sh', ['-c', `command -v ${tool}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const skip = hasTool('jq') && hasTool('curl') ? false : 'jq and curl are required';

/** 2026-10-04T00:00:00Z */
const NOW = 1_791_072_000;
const FUTURE = '2026-10-12T12:00:00Z';
const PAST = '2026-10-01T00:00:00Z';

/** Rows the stub returns: `[metric, last_seen, age_minutes]`. */
let rows = [];
let server;
let host;
let dir;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aeci-liveness-test-'));
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          results: rows,
          columns: ['heartbeat_metric', 'last_seen', 'age_minutes'],
        }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  host = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const cron = (job, extra = {}) => ({
  job,
  cron: '0 1 * * *',
  metric: `aeci.test.${job}`,
  maxAgeMinutes: 1560,
  ...extra,
});

/** Writes a fixture config with `crons`, runs the sweep, returns `{ code, out }`. */
const sweep = (crons, name) => {
  const config = join(dir, `${name}.json`);
  writeFileSync(
    config,
    JSON.stringify({
      hosts: { management: host },
      projects: [{ key: 'prod', id: 1 }],
      liveness: { project: 'prod', lookbackHours: 360, crons },
    }),
  );
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT], {
      env: {
        ...process.env,
        POSTHOG_CLI_API_KEY: 'phx_test',
        PH_LIVENESS_CONFIG: config,
        PH_APP_HOST: host,
        PH_PROJECT_ID: '1',
        PH_LIVENESS_NOW_EPOCH: String(NOW),
      },
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
};

const fresh = (job) => [`aeci.test.${job}`, '2026-10-03T23:00:00Z', 60];

test('every heartbeat fresh passes', { skip }, async () => {
  rows = [fresh('a'), fresh('b')];
  const { code, out } = await sweep([cron('a'), cron('b')], 'fresh');
  assert.equal(code, 0, out);
  assert.match(out, /all 2 cron heartbeats fresh/);
});

test('a missing heartbeat with no activeFrom fails MISSING', { skip }, async () => {
  rows = [fresh('a')];
  const { code, out } = await sweep([cron('a'), cron('b')], 'missing');
  assert.equal(code, 1, out);
  assert.match(out, /::error title=Cron heartbeat MISSING: b::/);
});

test('a missing heartbeat before activeFrom prints PENDING and passes', { skip }, async () => {
  rows = [fresh('a')];
  const { code, out } = await sweep([cron('a'), cron('b', { activeFrom: FUTURE })], 'pending');
  assert.equal(code, 0, out);
  assert.match(out, /^b\s+aeci\.test\.b\s+none\s+1560\s+PENDING$/m);
  assert.match(out, /::notice title=Cron heartbeat PENDING: b::.*2026-10-12T12:00:00Z/);
  assert.match(out, /all 1 cron heartbeats fresh .*1 pending a first heartbeat/);
  assert.doesNotMatch(out, /::error/);
});

test('a missing heartbeat after activeFrom fails MISSING', { skip }, async () => {
  rows = [fresh('a')];
  const { code, out } = await sweep([cron('a'), cron('b', { activeFrom: PAST })], 'expired');
  assert.equal(code, 1, out);
  assert.match(out, /::error title=Cron heartbeat MISSING: b::/);
});

test('a stale heartbeat before activeFrom still fails STALE', { skip }, async () => {
  rows = [['aeci.test.b', '2026-10-01T00:00:00Z', 4000]];
  const { code, out } = await sweep([cron('b', { activeFrom: FUTURE })], 'stale');
  assert.equal(code, 1, out);
  assert.match(out, /::error title=Cron heartbeat STALE: b::/);
});

test('an activeFrom jq cannot parse exits 2 (unchecked)', { skip }, async () => {
  rows = [];
  const { code, out } = await sweep([cron('b', { activeFrom: '2026-10-12' })], 'malformed');
  assert.equal(code, 2, out);
  assert.match(out, /activeFrom '2026-10-12'.*UNCHECKED/);
});
