/**
 * Lighthouse CI sharding (AECI-2030). Runs under `node --test` from root `pnpm test:scripts`.
 *
 * Three things must hold, or a shard silently drops or doubles URLs:
 *   1. `.lighthouserc.cjs` with `AECI_LHCI_SHARD=N/T` splits the URL list so the shards cover it
 *      exactly once, and an unset spec keeps every URL.
 *   2. The `lighthouse-shard` matrix in `lighthouse.yml` lists exactly 1..LHCI_SHARD_TOTAL.
 *   3. The workflow's inline "can this commit's config shard?" step runs every shard on a
 *      sharding config, and only shard 1 (unsharded) on an older config that ignores the spec.
 *      That step lives in the workflow, not a script, because it runs against the MEASURED
 *      commit's checkout, which may predate any helper file. So the test runs the step's own
 *      shell body, extracted from the YAML.
 *
 * Child processes use execFileSync with fixed argument arrays (no shell string built from input).
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const ROOT = process.cwd();
const CONFIG = join(ROOT, '.lighthouserc.cjs');
const WORKFLOW = readFileSync(join(ROOT, '.github/workflows/lighthouse.yml'), 'utf8');

const tempDirs = [];
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** The URL list the config yields for a shard spec. A fresh process per call: require() caches. */
function urlsFor(spec, configPath = CONFIG) {
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      'process.stdout.write(JSON.stringify(require(process.argv[1]).ci.collect.url))',
      configPath,
    ],
    { env: { ...process.env, AECI_LHCI_SHARD: spec }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(String(out));
}

function shardTotal() {
  const match = /LHCI_SHARD_TOTAL: '(\d+)'/.exec(WORKFLOW);
  assert.ok(match, 'lighthouse.yml sets LHCI_SHARD_TOTAL');
  return Number(match[1]);
}

/** The `run: |` body of the named step, de-indented. */
function stepScript(name) {
  const lines = WORKFLOW.split('\n');
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.ok(start >= 0, `lighthouse.yml has a step named "${name}"`);
  const runAt = lines.findIndex((line, i) => i > start && line.trim() === 'run: |');
  const indent = lines[runAt].search(/\S/) + 2;
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== '' && line.search(/\S/) < indent) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** Run the fallback step for one shard in `dir`. Returns its GITHUB_OUTPUT as an object. */
function shardPlan(dir, shard, total) {
  // Always a temp file: `dir` may be the repo root.
  const outDir = mkdtempSync(join(tmpdir(), 'lhci-shard-out-'));
  tempDirs.push(outDir);
  const outputFile = join(outDir, 'github-output');
  writeFileSync(outputFile, '');
  execFileSync('bash', ['-c', stepScript("Check that this commit's config can shard")], {
    cwd: dir,
    env: {
      ...process.env,
      SHARD: String(shard),
      LHCI_SHARD_TOTAL: String(total),
      GITHUB_OUTPUT: outputFile,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  return Object.fromEntries(
    readFileSync(outputFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split(/=(.*)/s).slice(0, 2)),
  );
}

test('an unset shard spec keeps every URL', () => {
  const all = urlsFor('');
  assert.equal(all.length, 15);
  assert.equal(new Set(all).size, all.length, 'no duplicate URLs in the list');
});

for (const total of [1, 2, 3, 4, 15]) {
  test(`${total} shard(s) cover every URL exactly once`, () => {
    const all = urlsFor('');
    const shards = Array.from({ length: total }, (_, i) => urlsFor(`${i + 1}/${total}`));
    for (const urls of shards) assert.ok(urls.length > 0, 'no empty shard');
    const seen = shards.flat();
    assert.equal(seen.length, all.length, 'no URL measured twice');
    assert.deepEqual([...seen].sort(), [...all].sort(), 'no URL dropped');
  });
}

for (const bad of ['0/3', '4/3', '1/0', '3', 'a/b', '1/3/1']) {
  test(`shard spec '${bad}' is refused`, () => {
    assert.throws(() => urlsFor(bad), /AECI_LHCI_SHARD must look like N\/T/);
  });
}

test('the lighthouse-shard matrix lists exactly 1..LHCI_SHARD_TOTAL', () => {
  const match = /lighthouse-shard:[\s\S]*?shard: \[([\d,\s]+)\]/.exec(WORKFLOW);
  assert.ok(match, 'lighthouse.yml has a lighthouse-shard matrix');
  const matrix = match[1].split(',').map((n) => Number(n.trim()));
  const total = shardTotal();
  assert.deepEqual(
    matrix,
    Array.from({ length: total }, (_, i) => i + 1),
  );
  assert.match(
    WORKFLOW,
    new RegExp(`Lighthouse \\(shard \\$\\{\\{ matrix\\.shard \\}\\}/${total}\\)`),
  );
});

test('the fallback step runs every shard on a sharding config', () => {
  const total = shardTotal();
  for (let shard = 1; shard <= total; shard++) {
    assert.deepEqual(shardPlan(ROOT, shard, total), { run: 'true', spec: `${shard}/${total}` });
  }
});

test('the fallback step runs only shard 1, unsharded, on a config that ignores the spec', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lhci-shard-'));
  tempDirs.push(dir);
  // The shape of every .lighthouserc.cjs before AECI-2030: a fixed URL list.
  const urls = Array.from({ length: 15 }, (_, i) => `http://localhost:8788/page-${i}`);
  writeFileSync(
    join(dir, '.lighthouserc.cjs'),
    `module.exports = { ci: { collect: { url: ${JSON.stringify(urls)} } } };\n`,
  );
  const total = shardTotal();
  assert.deepEqual(shardPlan(dir, 1, total), { run: 'true', spec: '' });
  for (let shard = 2; shard <= total; shard++) {
    assert.deepEqual(shardPlan(dir, shard, total), { run: 'false' });
  }
});
