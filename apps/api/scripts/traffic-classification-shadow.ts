/**
 * traffic-classification-shadow.ts — run the AECI-872 classifier in shadow over
 * a window of `page_views`, read-only (`ADMIN_PANEL_SPEC.md` §13 D19,
 * `POST_LAUNCH_MONITORING.md` §3c step 2).
 *
 * The Node shell around the tested core (`src/lib/traffic-shadow.ts`). It:
 *   1. pulls `page_views` and `asn_registry` from a D1 with `wrangler d1 execute
 *      --json --command`, every statement passing a SELECT-only guard;
 *   2. loads them into an in-memory SQLite built from the real migrations;
 *   3. runs the existing detectors unchanged, classifies every row, and sets the
 *      new class beside today's digest verdict;
 *   4. writes a JSON and a Markdown report to `<repo>/.context/aeci-872/`, which
 *      is gitignored. Reports are never committed.
 *
 * SAFETY:
 *   - Read-only. Every statement is a single SELECT (`assertSelectOnly`). Nothing
 *     is written to the source D1, and nothing writes `is_bot`.
 *   - The remote target is the production database by its Cloudflare name,
 *     `aeci-app-production-us`, run from `/tmp` with `CLOUDFLARE_API_TOKEN`
 *     unset so wrangler uses the operator's OAuth login. Inside `apps/api` the
 *     same read returns 7403, and from `/tmp` the binding name
 *     `aeci-app-production` reaches the retired APAC copy.
 *
 * USAGE (from the repo root):
 *   pnpm --filter @aeci/api ops:traffic-shadow -- --from 2026-09-13 --to 2026-10-13
 *   pnpm --filter @aeci/api ops:traffic-shadow -- --local --from 2026-10-01 --to 2026-10-14
 *
 * Flags:
 *   --from / --to YYYY-MM-DD   reported days, inclusive (required)
 *   --local                    read the local D1 (`aeci-app-preview`) instead of production
 *   --labels <path>            labels file; default `.context/aeci-872/labels.json` if present.
 *                              Shape: `scripts/traffic-shadow-labels.example.json`.
 *   --chunk <n>                rows per pull statement (default 5000)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  assertSelectOnly,
  buildAsnRegistrySql,
  buildPageViewChunkSql,
  evidenceWindows,
  loadPulledRows,
  parseLabelsFile,
  renderShadowMarkdown,
  runShadow,
  type LabelsFile,
  type PulledAsnRow,
  type PulledPageView,
  type ShadowMeta,
} from '../src/lib/traffic-shadow';
import {
  classifierFingerprint,
  classifierRuleInputs,
  TRAFFIC_CLASSIFIER_VERSION,
} from '../src/lib/traffic-classifier';
import { makeTestDb } from '../src/test/d1';

/** The WBS Project account that holds production D1. */
const PROD_ACCOUNT_ID = '004dc1af737b22a8aa83b3550fa9b9d3';
/** Production D1 by its Cloudflare name, not its binding name. */
const PROD_DB = 'aeci-app-production-us';
const LOCAL_DB = 'aeci-app-preview';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

interface Target {
  label: string;
  run: (sql: string) => unknown[];
}

function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function requireDay(argv: string[], name: string): string {
  const v = readValueFlag(argv, name);
  if (!v || !DAY_RE.test(v))
    throw new Error(`${name} YYYY-MM-DD is required. Got: ${v ?? '(unset)'}`);
  return v;
}

function parseWranglerRows(stdout: string): unknown[] {
  const start = stdout.indexOf('[');
  if (start === -1) throw new Error(`Unexpected wrangler output (no JSON):\n${stdout}`);
  const parsed = JSON.parse(stdout.slice(start)) as { results?: unknown[]; success?: boolean }[];
  const first = parsed[0];
  if (!first || first.success === false)
    throw new Error('wrangler reported an unsuccessful query.');
  return first.results ?? [];
}

function resolveTarget(argv: string[], apiDir: string): Target {
  const wrangler = join(apiDir, 'node_modules', '.bin', 'wrangler');
  if (!existsSync(wrangler))
    throw new Error(`wrangler not found at ${wrangler}. Run pnpm install.`);
  const local = argv.includes('--local');

  return {
    label: local ? `local (${LOCAL_DB})` : `remote (${PROD_DB}, OAuth, from /tmp)`,
    run: (sql: string) => {
      const statement = assertSelectOnly(sql);
      const env = { ...process.env };
      if (!local) {
        delete env.CLOUDFLARE_API_TOKEN;
        env.CLOUDFLARE_ACCOUNT_ID = PROD_ACCOUNT_ID;
      }
      const args = local
        ? ['d1', 'execute', LOCAL_DB, '--local', '--json', '--command', statement]
        : ['d1', 'execute', PROD_DB, '--remote', '--json', '--command', statement];
      const res = spawnSync(wrangler, args, {
        cwd: local ? apiDir : '/tmp',
        env,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      if (res.error) throw res.error;
      if (res.status !== 0) {
        const hint = local
          ? 'Set up the local D1 first:  pnpm --filter @aeci/api db:setup:local'
          : 'Check `wrangler login` (OAuth) reaches The WBS Project account.';
        throw new Error(`wrangler d1 execute failed (exit ${res.status}). ${hint}\n${res.stderr}`);
      }
      return parseWranglerRows(res.stdout);
    },
  };
}

function pullChunked(
  target: Target,
  window: { from: string; to: string },
  chunk: number,
  operatorOnly: boolean,
): PulledPageView[] {
  const out: PulledPageView[] = [];
  let afterId = 0;
  for (;;) {
    const rows = target.run(
      buildPageViewChunkSql({
        fromIso: window.from,
        toIso: window.to,
        afterId,
        limit: chunk,
        operatorOnly,
      }),
    ) as PulledPageView[];
    out.push(...rows);
    const last = rows.at(-1);
    process.stdout.write(
      `\r  pulled ${out.length} ${operatorOnly ? 'operator anchor' : 'page view'} rows`,
    );
    if (!last || rows.length < chunk) break;
    afterId = Number(last.id);
  }
  process.stdout.write('\n');
  return out;
}

function gitSha(): string {
  const sha = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim();
  return `${sha || 'unknown'}${dirty ? '-dirty' : ''}`;
}

function readLabels(argv: string[], outDir: string): { labels: LabelsFile; path: string | null } {
  const explicit = readValueFlag(argv, '--labels');
  const path = explicit ? resolve(explicit) : join(outDir, 'labels.json');
  if (!existsSync(path)) {
    if (explicit) throw new Error(`Labels file not found: ${path}`);
    console.log(`  no labels file at ${path}; labelled slices will be empty`);
    return { labels: parseLabelsFile({}), path: null };
  }
  return { labels: parseLabelsFile(JSON.parse(readFileSync(path, 'utf8'))), path };
}

export async function main(argv: string[]): Promise<number> {
  const apiDir = process.cwd();
  if (!existsSync(join(apiDir, 'migrations')) || !existsSync(join(apiDir, 'wrangler.jsonc'))) {
    throw new Error('Run from apps/api:  pnpm --filter @aeci/api ops:traffic-shadow -- …');
  }
  const fromDay = requireDay(argv, '--from');
  const toDay = requireDay(argv, '--to');
  const chunk = Number(readValueFlag(argv, '--chunk') ?? 5000);
  if (!Number.isSafeInteger(chunk) || chunk < 1)
    throw new Error('--chunk must be a positive integer.');

  const outDir = resolve(apiDir, '..', '..', '.context', 'aeci-872');
  mkdirSync(outDir, { recursive: true });
  const { labels, path: labelsPath } = readLabels(argv, outDir);
  const target = resolveTarget(argv, apiDir);
  const windows = evidenceWindows(fromDay, toDay);

  console.log(`Shadow run ${fromDay} to ${toDay} against ${target.label}`);
  const views = pullChunked(target, windows.rows, chunk, false);
  const anchors = pullChunked(target, windows.operatorAnchors, chunk, true);
  const asns = target.run(
    buildAsnRegistrySql(windows.rows.from, windows.rows.to),
  ) as PulledAsnRow[];

  const local = await makeTestDb();
  try {
    const pulled = await loadPulledRows(local.db, [...views, ...anchors], asns);
    console.log(
      `  loaded ${pulled.pageViews} page views and ${pulled.asnRegistry} ASNs; classifying`,
    );
    const result = await runShadow(local.db, { fromDay, toDay, labels });

    const generatedAt = new Date().toISOString();
    const meta: ShadowMeta = {
      classifierVersion: TRAFFIC_CLASSIFIER_VERSION,
      fingerprint: await classifierFingerprint(),
      gitSha: gitSha(),
      generatedAt,
      target: target.label,
      window: { fromDay, toDay },
      evidenceWindows: windows,
      pulled,
      labelsPath,
      heldOutDays: labels.heldOutDays,
      ruleInputs: classifierRuleInputs(),
    };

    const tag = argv.includes('--local') ? 'local' : 'prod';
    const base = join(
      outDir,
      `traffic-shadow-${tag}-${fromDay}_${toDay}-${generatedAt.replace(/[:.]/g, '')}`,
    );
    writeFileSync(`${base}.json`, `${JSON.stringify({ meta, ...result }, null, 2)}\n`);
    writeFileSync(`${base}.md`, renderShadowMarkdown(meta, result));
    console.log(`  wrote ${base}.json`);
    console.log(`  wrote ${base}.md`);

    const notReproduced = result.days.filter((d) => !d.reproducesDigest).map((d) => d.day);
    if (notReproduced.length > 0) {
      console.log(
        `  WARNING: the digest headline was not reproduced on ${notReproduced.join(', ')}`,
      );
    }
  } finally {
    local.dispose();
  }
  return 0;
}

// Entrypoint guard — importing this module must not run main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
