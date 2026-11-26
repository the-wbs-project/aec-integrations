/**
 * `scripts/api-manual-deploy.sh` (AECI-2069): the manual API deploy must migrate first,
 * refuse an unmerged revision, and refuse to deploy while migrations are still pending
 * (a declined wrangler prompt exits 0). Runs under `node --test` from root
 * `pnpm test:scripts`.
 *
 * Each test builds a throwaway git repo with a bare `origin`, copies the two scripts in,
 * and puts a fake `pnpm` first on PATH. The fake logs every call and prints
 * FAKE_LIST_OUTPUT for `wrangler d1 migrations list`. No real wrangler or network call runs.
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

const SCRIPTS = join(process.cwd(), 'scripts');
const NONE_PENDING = '✅ No migrations to apply!';
const PENDING = 'Migrations to be applied:\n│ 0134_crawl_path_index.sql │';

const dirs = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'aeci-manual-deploy-'));
  dirs.push(base);
  const origin = join(base, 'origin.git');
  const repo = join(base, 'repo');
  const bin = join(base, 'bin');
  const log = join(base, 'calls.log');
  git(base, 'init', '--quiet', '--bare', '-b', 'main', origin);
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  mkdirSync(join(repo, 'apps/api'), { recursive: true });
  mkdirSync(bin);
  for (const f of ['api-manual-deploy.sh', 'd1-apply-migrations.sh']) {
    copyFileSync(join(SCRIPTS, f), join(repo, 'scripts', f));
  }
  writeFileSync(join(repo, 'apps/api/README.md'), 'api\n');
  git(repo, 'init', '--quiet', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '.');
  git(repo, 'commit', '--quiet', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '--quiet', 'origin', 'main');
  writeFileSync(
    join(bin, 'pnpm'),
    [
      '#!/usr/bin/env bash',
      `echo "$*" >> "${log}"`,
      'if [ "$1 $2 $3 $4" = "exec wrangler d1 migrations" ] && [ "$5" = "list" ]; then',
      '  printf "%s\\n" "$FAKE_LIST_OUTPUT"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  return { repo, bin, log };
}

function run(ctx, env, listOutput = NONE_PENDING) {
  const res = spawnSync('bash', [join(ctx.repo, 'scripts/api-manual-deploy.sh'), env], {
    cwd: ctx.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${ctx.bin}:${process.env.PATH}`,
      FAKE_LIST_OUTPUT: listOutput,
      D1_RETRY_BASE_SECONDS: '0',
    },
  });
  let calls = [];
  try {
    calls = readFileSync(ctx.log, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    // no pnpm call happened
  }
  return { status: res.status, stderr: res.stderr, calls };
}

const deployed = (calls) => calls.some((c) => c.startsWith('exec wrangler deploy '));

test('merged, clean, nothing pending: migrates, then deploys with the HEAD sha', () => {
  const ctx = setup();
  const sha = git(ctx.repo, 'rev-parse', 'HEAD').trim();
  const { status, calls } = run(ctx, 'production');
  assert.equal(status, 0);
  const apply = calls.findIndex((c) =>
    c.startsWith('exec wrangler d1 migrations apply aeci-app-production --env production --remote'),
  );
  const list = calls.findIndex((c) =>
    c.startsWith('exec wrangler d1 migrations list aeci-app-production'),
  );
  const deploy = calls.findIndex((c) => c.startsWith('exec wrangler deploy --env production'));
  assert.ok(apply >= 0 && list > apply && deploy > list, calls.join('\n'));
  assert.match(calls[deploy], new RegExp(`COMMIT_SHA:${sha}`));
});

test('pending migrations after apply (declined prompt): refuses to deploy', () => {
  const ctx = setup();
  const { status, stderr, calls } = run(ctx, 'staging', PENDING);
  assert.equal(status, 1);
  assert.match(stderr, /still has pending migrations/);
  assert.equal(deployed(calls), false);
});

test('HEAD not merged into origin/main: refuses before any wrangler call', () => {
  const ctx = setup();
  writeFileSync(join(ctx.repo, 'apps/api/new.sql'), 'select 1;\n');
  git(ctx.repo, 'add', '.');
  git(ctx.repo, 'commit', '--quiet', '-m', 'unmerged migration');
  const { status, stderr, calls } = run(ctx, 'demo');
  assert.equal(status, 1);
  assert.match(stderr, /not merged into origin\/main/);
  assert.deepEqual(calls, []);
});

test('dirty working tree: refuses before any wrangler call', () => {
  const ctx = setup();
  writeFileSync(join(ctx.repo, 'apps/api/untracked.sql'), 'select 1;\n');
  const { status, stderr, calls } = run(ctx, 'staging');
  assert.equal(status, 1);
  assert.match(stderr, /uncommitted or untracked/);
  assert.deepEqual(calls, []);
});

test('unknown tier: usage error, no calls', () => {
  const ctx = setup();
  const { status, stderr, calls } = run(ctx, 'preview');
  assert.equal(status, 1);
  assert.match(stderr, /usage/);
  assert.deepEqual(calls, []);
});
