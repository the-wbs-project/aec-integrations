/**
 * `scripts/dev-launch.sh`, the `pnpm dev:agent` launcher (AECI-2014). Runs under `node --test`
 * from root `pnpm test:scripts`.
 *
 * The real script runs from a copy in a temp directory, so its `cd "$(dirname "$0")/.."` lands
 * there and its log and cache paths never touch the repo. Fake `pnpm` and `lsof` binaries go first
 * on PATH. The fake `lsof` reports the ports in FAKE_BUSY as listening. The fake `pnpm dev:bound`
 * records the pair it was given, fails with wrangler's bind message for the first FAKE_FAIL_TIMES
 * calls, and then succeeds, fails another way, or hangs with a child process (FAKE_MODE).
 */

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const SCRIPT = join(process.cwd(), 'scripts', 'dev-launch.sh');
const roots = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const FAKE_LSOF = `#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in -iTCP:*) port="\${arg#-iTCP:}" ;; esac
done
for busy in \${FAKE_BUSY:-}; do
  [ "$busy" = "$port" ] && exit 0
done
exit 1
`;

const FAKE_PNPM = `#!/usr/bin/env bash
state="$FAKE_STATE"
if [ "$1" = "--filter" ]; then
  echo build >>"$state/calls"
  exit 0
fi
n=$(( $(cat "$state/count" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$state/count"
echo "bound $AECI_WEB_PORT $AECI_API_PORT" >>"$state/calls"
if [ "$n" -le "\${FAKE_FAIL_TIMES:-0}" ]; then
  echo "apps/api dev:preview: ✘ [ERROR] Address already in use. Please check that you are not already running a server on this address or specify a different port with --port."
  exit 1
fi
case "\${FAKE_MODE:-ok}" in
  other) echo "apps/api dev:preview: ✘ [ERROR] something else broke"; exit 7 ;;
  hang) sleep 300 & echo "$!" >"$state/grandchild"; wait ;;
  *) echo "apps/web dev:preview: Ready on http://localhost:$AECI_WEB_PORT" ;;
esac
`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dev-launch-'));
  roots.push(root);
  for (const dir of ['scripts', 'bin', 'state']) mkdirSync(join(root, dir));
  copyFileSync(SCRIPT, join(root, 'scripts', 'dev-launch.sh'));
  writeFileSync(join(root, 'bin', 'lsof'), FAKE_LSOF);
  writeFileSync(join(root, 'bin', 'pnpm'), FAKE_PNPM);
  chmodSync(join(root, 'bin', 'lsof'), 0o755);
  chmodSync(join(root, 'bin', 'pnpm'), 0o755);
  return root;
}

function envFor(root, extra) {
  const env = {
    ...process.env,
    PATH: `${join(root, 'bin')}:${process.env.PATH}`,
    FAKE_STATE: join(root, 'state'),
    ...extra,
  };
  for (const key of ['AECI_WEB_PORT', 'AECI_API_PORT', 'AECI_DEV_RETRIES', 'DEV_SKIP_BUILD']) {
    if (!(key in extra)) delete env[key];
  }
  return env;
}

function run(extra = {}) {
  const root = fixture();
  const res = spawnSync('bash', [join(root, 'scripts', 'dev-launch.sh')], {
    env: envFor(root, extra),
    encoding: 'utf8',
    timeout: 30_000,
  });
  const callsFile = join(root, 'state', 'calls');
  const calls = existsSync(callsFile) ? readFileSync(callsFile, 'utf8').trim().split('\n') : [];
  return { status: res.status, out: `${res.stdout}${res.stderr}`, calls };
}

test('a free first pair boots once on 8790/8789', () => {
  const r = run();
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ['build', 'bound 8790 8789']);
  assert.match(r.out, /▶ dev:agent → SSR http:\/\/localhost:8790 {2}· {2}API :8789/);
  assert.doesNotMatch(r.out, /↻/);
});

test('the scan skips a busy pair', () => {
  const r = run({ FAKE_BUSY: '8789' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ['build', 'bound 8792 8791']);
});

test('a lost bind race retries on the next pair without rebuilding', () => {
  const r = run({ FAKE_FAIL_TIMES: '1' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ['build', 'bound 8790 8789', 'bound 8792 8791']);
  assert.match(
    r.out,
    /↻ dev:agent — Address already in use on SSR :8790 \/ API :8789 during boot; retrying from the next pair \(attempt 2\/3\)/,
  );
  assert.match(r.out, /▶ dev:agent → SSR http:\/\/localhost:8792 .*\(attempt 2\/3\)/);
});

test('the retry re-scans and skips a pair that became busy', () => {
  const r = run({ FAKE_FAIL_TIMES: '1', FAKE_BUSY: '8792' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ['build', 'bound 8790 8789', 'bound 8794 8793']);
});

test('it gives up after AECI_DEV_RETRIES attempts', () => {
  const r = run({ FAKE_FAIL_TIMES: '99', AECI_DEV_RETRIES: '2' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['build', 'bound 8790 8789', 'bound 8792 8791']);
  assert.match(
    r.out,
    /✘ dev:agent — Address already in use on SSR :8792 \/ API :8791; gave up after 2 attempt\(s\)/,
  );
});

test('the default bound is three attempts', () => {
  const r = run({ FAKE_FAIL_TIMES: '99' });
  assert.equal(r.status, 1);
  assert.equal(r.calls.filter((c) => c.startsWith('bound')).length, 3);
});

test('a pinned pair never retries', () => {
  const r = run({ FAKE_FAIL_TIMES: '1', AECI_WEB_PORT: '8900', AECI_API_PORT: '8899' });
  assert.equal(r.status, 1);
  assert.deepEqual(r.calls, ['build', 'bound 8900 8899']);
  assert.match(r.out, /pinned port is taken/);
});

test('a failure that is not a bind error exits with its own code and no retry', () => {
  const r = run({ FAKE_MODE: 'other' });
  assert.equal(r.status, 7);
  assert.deepEqual(r.calls, ['build', 'bound 8790 8789']);
  assert.doesNotMatch(r.out, /↻/);
});

test('DEV_SKIP_BUILD skips the rebuild', () => {
  const r = run({ DEV_SKIP_BUILD: '1' });
  assert.equal(r.status, 0);
  assert.deepEqual(r.calls, ['bound 8790 8789']);
});

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  test(`${signal} to the launcher stops the whole stack`, async () => {
    const root = fixture();
    const child = spawn('bash', [join(root, 'scripts', 'dev-launch.sh')], {
      env: envFor(root, { FAKE_MODE: 'hang', DEV_SKIP_BUILD: '1' }),
      stdio: 'ignore',
    });
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    const pidFile = join(root, 'state', 'grandchild');
    assert.ok(
      await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== ''),
      'stack never started',
    );
    const grandchild = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(alive(grandchild));

    child.kill(signal);
    assert.equal(await exited, 130);
    assert.ok(
      await until(() => !alive(grandchild)),
      'a process the stack started outlived the launcher',
    );
  });
}
