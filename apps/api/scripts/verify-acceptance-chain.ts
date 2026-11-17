/**
 * verify-acceptance-chain.ts: prove the agreement acceptance record was not edited
 * (AECI-1680, ADR 0057; runbook `docs/runbooks/legal.md` "Prove an acceptance was not
 * edited").
 *
 * READ-ONLY. It reads R2 and D1 through `wrangler` and writes nothing anywhere. The rule
 * lives once in `src/lib/acceptance-chain.ts` (`verifyAcceptanceChain`), which the
 * nightly export also uses to fingerprint rows. This script is the thin adapter: it
 * gathers the inputs, calls the rule, and prints what it found.
 *
 * It checks, in this order:
 *   1. LOCK. `wrangler r2 bucket lock list` must show an enabled rule covering
 *      `evidence/acceptance-chain/`. None is `LOCK MISSING`, a failure. Only a finite
 *      rule (the 4-year `evidence/` rule) is `LOCK NOT INDEFINITE`, also a failure. Local R2
 *      has no lock, so `--local` skips this step.
 *   2. CHAIN. It walks `000001.json`, `000002.json`, … from R2. A missing key does not end
 *      the walk: it probes 30 seqs further, and walks at least to the highest seq in the
 *      D1 ledger, so a deleted middle file is `CHAIN BROKEN`. It does NOT trust the
 *      ledger's content, only its highest seq as a floor. A newest file over 50 hours old
 *      on a deployed tier is `CHAIN STALE`. Each file's SHA-256 must be the next file's
 *      `prev_sha256`, the seqs must run without a gap, and `state_sha256` must match the
 *      entries so far. It reports the FIRST broken link as `CHAIN BROKEN`.
 *   3. TIMESTAMPS. `openssl ts -verify` on each file's `.tsr` against the pinned
 *      `scripts/certs/digicert-tsa-chain.pem`. A missing or invalid token is a warning.
 *   4. D1. Every live `agreement_acceptances` and `license_grants` row is fingerprinted
 *      and compared with its last fingerprint in the chain: `CHANGED`, `UNEXPORTED`,
 *      `ABSENT`, and `TOMBSTONE WITHOUT PRUNE AUDIT`.
 *
 * A row edited since the last nightly export (18:00 UTC) shows as `CHANGED` until the next
 * export carries it. Run it after 18:15 UTC, or match each `CHANGED` row to its audit row.
 *
 * Usage (from the repo root):
 *   pnpm --filter @aeci/api ops:verify-acceptance-chain -- --env production
 *   pnpm --filter @aeci/api ops:verify-acceptance-chain -- --local
 *
 * `--env` needs `CLOUDFLARE_API_TOKEN` with R2 read and D1 read on the account, or an
 * OAuth `wrangler login`. `openssl` must be on PATH for step 3. Exit 0 when nothing
 * failed, 1 when anything failed.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CHAIN_TABLES,
  chainKey,
  parseLockRules,
  pruneAuditIds,
  tsrKey,
  verifyAcceptanceChain,
  type ChainTable,
  type LockRule,
  type RawRow,
} from '../src/lib/acceptance-chain';
import { sha256HexBytes } from '../src/lib/hash';

const ENVS = ['staging', 'demo', 'production'] as const;
type DeployedEnv = (typeof ENVS)[number];

/** The pinned DigiCert chain. Its header names the source URLs. */
const CA_FILE = join(process.cwd(), 'scripts', 'certs', 'digicert-tsa-chain.pem');

/** A safety stop for the walk. One file a night is 365 a year. */
const MAX_FILES = 100_000;
/** How many seqs past the last file found the walk keeps probing for a later file. */
const PROBE_AHEAD = 30;

interface Target {
  label: string;
  bucket: string;
  db: string;
  d1Flags: string[];
  r2Flags: string[];
  local: boolean;
}

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

function resolveTarget(argv: string[]): Target {
  if (argv.includes('--local')) {
    return {
      label: 'local',
      bucket: 'aeci-uploads-preview',
      db: 'aeci-app-preview',
      d1Flags: ['--local'],
      r2Flags: ['--local'],
      local: true,
    };
  }
  const env = readValueFlag(argv, '--env');
  if (!env || !(ENVS as readonly string[]).includes(env)) {
    throw new Error(`Set --env ${ENVS.join('|')} (or --local). Got: ${env ?? '(unset)'}.`);
  }
  const e = env as DeployedEnv;
  return {
    label: e,
    bucket: `aeci-uploads-${e}`,
    db: `aeci-app-${e}`,
    d1Flags: ['--env', e, '--remote'],
    r2Flags: ['--remote'],
    local: false,
  };
}

const WRANGLER_HINT =
  'Run via pnpm so wrangler is on PATH:\n  pnpm --filter @aeci/api ops:verify-acceptance-chain -- …';

function wrangler(args: string[]) {
  const res = spawnSync('wrangler', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`\`wrangler\` not found. ${WRANGLER_HINT}`);
    }
    throw res.error;
  }
  return res;
}

function readLockRules(target: Target): LockRule[] {
  const res = wrangler(['r2', 'bucket', 'lock', 'list', target.bucket]);
  if (res.status !== 0) {
    throw new Error(`wrangler r2 bucket lock list ${target.bucket} failed:\n${res.stderr}`);
  }
  return parseLockRules(res.stdout);
}

/** One R2 object's bytes, or null when the key does not exist. */
function getObject(target: Target, key: string, dir: string): Uint8Array | null {
  const file = join(dir, 'object');
  rmSync(file, { force: true });
  const res = wrangler([
    'r2',
    'object',
    'get',
    `${target.bucket}/${key}`,
    ...target.r2Flags,
    '--file',
    file,
  ]);
  if (res.status !== 0) {
    if (`${res.stdout}${res.stderr}`.includes('The specified key does not exist')) return null;
    throw new Error(`wrangler r2 object get ${target.bucket}/${key} failed:\n${res.stderr}`);
  }
  return new Uint8Array(readFileSync(file));
}

function runD1<T>(target: Target, sql: string): T[] {
  const res = wrangler(['d1', 'execute', target.db, ...target.d1Flags, '--json', '--command', sql]);
  if (res.status !== 0) {
    throw new Error(`wrangler d1 execute failed on "${target.db}":\n${res.stderr}`);
  }
  const start = res.stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${res.stdout}`);
  const parsed = JSON.parse(res.stdout.slice(start)) as { results: T[] }[];
  return parsed[0]?.results ?? [];
}

/** `ok`, `invalid`, or null when openssl is not installed. */
function opensslVerify(sha256: string, tsrPath: string): 'ok' | 'invalid' | null {
  const res = spawnSync(
    'openssl',
    ['ts', '-verify', '-digest', sha256, '-in', tsrPath, '-CAfile', CA_FILE],
    { encoding: 'utf8' },
  );
  if (res.error) {
    if ((res.error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw res.error;
  }
  return res.status === 0 && res.stdout.includes('Verification: OK') ? 'ok' : 'invalid';
}

export async function main(argv: string[]): Promise<number> {
  const target = resolveTarget(argv);
  const dir = mkdtempSync(join(tmpdir(), 'aeci-acceptance-chain-'));
  try {
    console.log(`Acceptance chain verify: ${target.label} (${target.bucket}, ${target.db})`);
    console.log('Read-only. Nothing is written.\n');

    // 1. Lock.
    const lockRules = target.local ? null : readLockRules(target);
    console.log(
      `1. Lock: ${lockRules === null ? 'skipped (local R2 has no bucket lock)' : `${lockRules.length} rule(s) on ${target.bucket}`}`,
    );

    // 2. Chain, from R2. `wrangler` cannot list a bucket, so a missing key does not end
    // the walk: it probes PROBE_AHEAD seqs past the last miss, and walks at least to the
    // highest seq the D1 ledger records. A gap with a later file, or a ledger seq with no
    // file, reaches the verify as `bytes: null` and is CHAIN BROKEN. The ledger is only a
    // floor for how far to look. Its content is never trusted.
    const ledgerMax =
      runD1<{ max_seq: number | null }>(
        target,
        'SELECT MAX("seq") AS "max_seq" FROM "acceptance_chain_exports"',
      )[0]?.max_seq ?? 0;
    const walked: { key: string; bytes: Uint8Array | null }[] = [];
    let lastFound = 0;
    for (let seq = 1; seq <= MAX_FILES; seq += 1) {
      if (seq > lastFound + PROBE_AHEAD && seq > ledgerMax) break;
      const bytes = getObject(target, chainKey(seq), dir);
      if (bytes) lastFound = seq;
      walked.push({ key: chainKey(seq), bytes });
    }
    const files = walked.slice(0, Math.max(lastFound, ledgerMax));
    const missing = files.filter((f) => f.bytes === null).length;
    console.log(
      `2. Chain: ${files.length - missing} file(s) in R2` +
        (missing > 0 ? `, ${missing} seq(s) MISSING below the highest seq.` : '.') +
        ` D1 ledger records ${ledgerMax}.`,
    );

    // 3. Timestamps.
    const timestamps = new Map<number, 'ok' | 'missing' | 'invalid'>();
    let opensslMissing = false;
    for (const [index, file] of files.entries()) {
      const seq = index + 1;
      if (file.bytes === null) continue;
      const tsr = getObject(target, tsrKey(seq), dir);
      if (!tsr) {
        timestamps.set(seq, 'missing');
        continue;
      }
      const tsrPath = join(dir, `${seq}.tsr`);
      writeFileSync(tsrPath, tsr);
      const verdict = opensslVerify(await sha256HexBytes(file.bytes), tsrPath);
      if (verdict === null) {
        opensslMissing = true;
        break;
      }
      timestamps.set(seq, verdict);
    }
    console.log(
      opensslMissing
        ? '3. Timestamps: NOT CHECKED. openssl is not on PATH.'
        : `3. Timestamps: ${[...timestamps.values()].filter((v) => v === 'ok').length} of ${files.length} verified against ${CA_FILE}.`,
    );

    // 4. D1.
    const d1Rows = Object.fromEntries(
      CHAIN_TABLES.map((t) => [t, runD1<RawRow>(target, `SELECT * FROM "${t}"`)]),
    ) as Record<ChainTable, RawRow[]>;
    const prunes = runD1<{ metadata: unknown }>(
      target,
      `SELECT "metadata" FROM "audit_log" WHERE "action" = 'retention.pruned'`,
    ).map((r) => r.metadata);
    console.log(
      `4. D1: ${d1Rows.agreement_acceptances.length} acceptance(s), ${d1Rows.license_grants.length} grant(s), ${prunes.length} prune audit row(s).\n`,
    );

    const result = await verifyAcceptanceChain({
      lockRules,
      files,
      d1Rows,
      pruneAuditIds: pruneAuditIds(prunes),
      timestamps: opensslMissing ? undefined : timestamps,
      now: target.local ? undefined : new Date(),
    });

    for (const level of ['fail', 'warn', 'info'] as const) {
      for (const f of result.findings.filter((x) => x.level === level)) {
        console.log(`${level.toUpperCase().padEnd(4)}  ${f.code}  ${f.detail}`);
      }
    }
    console.log('');
    // Three separate results. A missing lock and a broken chain are different events
    // with different remedies (docs/runbooks/legal.md), so neither is folded into the other.
    console.log(`LOCK:  ${result.lock}`);
    console.log(
      `CHAIN: ${result.chain}${result.brokenAt === null ? '' : ` at seq ${result.brokenAt}`}`,
    );
    console.log(`ROWS:  ${result.rows}`);
    console.log(
      `${result.ok ? 'PASS' : 'FAIL'}: ${result.filesVerified} of ${files.length} seq(s) verified` +
        (result.brokenAt === null ? '.' : `, first broken link at seq ${result.brokenAt}.`),
    );
    return result.ok ? 0 : 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Entrypoint guard: importing this module (e.g. in tests) must not run main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
