/**
 * Targeted Algolia orphan purge — the testable core of the AECI-267 one-off ops
 * remediation (`STAGE_1_SPEC.md` §23.1: the human-triage step the daily index-drift
 * check prescribes).
 *
 * Deletes specific objects **by objectID** from an environment's Algolia indexes.
 * The motivating case: the four AECI-65 axe/Lighthouse fixtures — the "Fixture
 * Procore" vendor + product, the "Fixture Acme Connector" product (the integration's
 * target endpoint), and the integration between them (`apps/api/seed/phase2-fixtures.sql`)
 * — stranded in the **staging** indexes by the Supabase→D1 cutover: they exist in the
 * index but not in staging D1, so their detail pages 404 and the §23.1 drift check
 * reads negative. The incremental sync
 * only deletes rows it *sees* as non-promoted; it can't remove rows absent from D1
 * entirely, hence this manual unblock (the durable orphan-sweep is tracked
 * separately).
 *
 * Dependency-injected, exactly like `./algolia-drift`: this module imports neither
 * `algoliasearch` nor a DB client. The read/delete I/O goes through an injected
 * `OrphanPurgeClient` (the fetch-based factory below wires the real one); the CLI
 * wrapper (`apps/api/scripts/purge-algolia-orphans.ts`) supplies `process.argv`,
 * `process.env` credentials, and `console`. Deletes reuse the same
 * `callAlgoliaBatch` (`deleteObject` by objectID) the daily sync and post-promote
 * hook use — no new write plumbing.
 *
 * Scope note: `localizedIndexNamesFor(env)` resolves to the three primary indexes
 * (en-US is the only launch locale). The per-tab sort indexes are **standard
 * Algolia replicas**, so an object delete on the primary propagates to them
 * automatically — this purge only ever targets the primaries.
 *
 * Spec: `STAGE_1_SPEC.md` §23.1; related AECI-140 (`./algolia-drift`).
 */

import {
  INDEX_ENTITIES,
  localizedIndexNamesFor,
  type AlgoliaEnv,
  type IndexEntity,
} from '@aeci/shared/algolia';
import {
  callAlgoliaBatch,
  type AlgoliaBatchCredentials,
  type AlgoliaBatchOutcome,
} from '@aeci/shared/algolia-batch';
import { discardResponseBody } from '@aeci/shared/response-drain';

/** A specific object known (or suspected) to be orphaned in an env's index. */
export type OrphanTarget = {
  /** Which entity index the object lives in. */
  entity: IndexEntity;
  /** Algolia objectID = the D1 row UUID the sync writes (`{ objectID: row.id }`). */
  objectID: string;
  /** Human label for logs (the fixture's name). */
  label: string;
};

/**
 * The four AECI-65 CI fixtures stranded in the staging Algolia indexes (AECI-267).
 * objectIDs are the deterministic fixture UUIDs from `apps/api/seed/phase2-fixtures.sql`
 * (lines 41 / 60 / 61 / 102). Both fixture PRODUCTS are promoted — `fixture-procore`
 * AND `fixture-acme-connector` (the integration's target endpoint) — so both orphan
 * into `staging_products`; the original issue listed only the first product. The
 * pre-flight search probes below confirm these against the live index before any
 * delete, in case staging's objectIDs ever differed.
 */
export const PROCORE_ORPHANS: readonly OrphanTarget[] = [
  {
    entity: 'vendors',
    objectID: '00000000-0000-4000-8000-000000000061',
    label: 'Fixture Procore Technologies',
  },
  {
    entity: 'products',
    objectID: '00000000-0000-4000-8000-000000000062',
    label: 'Fixture Procore',
  },
  {
    entity: 'products',
    objectID: '00000000-0000-4000-8000-000000000063',
    label: 'Fixture Acme Connector',
  },
  {
    entity: 'integrations',
    objectID: '00000000-0000-4000-8000-000000000065',
    label: 'Fixture Procore ↔ Acme Connector',
  },
] as const;

/**
 * Queries run against each affected index to surface the live objectIDs before
 * deleting — implements the issue's "confirm against the live index … capture the
 * actual objectIDs" step.
 */
export const SEARCH_PROBES = ['Procore', 'Fixture'] as const;

/** Parsed CLI options. */
export type PurgeArgs = {
  env: AlgoliaEnv;
  /** Gate: false = dry-run (read-only preflight + plan); true = perform deletes. */
  apply: boolean;
  /** Required to target `production` — a guard against fat-fingering the live index. */
  allowProduction: boolean;
  /** Optional `--ids entity:uuid,...` override; undefined → the default Procore set. */
  ids: OrphanTarget[] | undefined;
};

const VALID_ENVS: readonly AlgoliaEnv[] = ['development', 'preview', 'staging', 'production'];

function isEnv(value: string): value is AlgoliaEnv {
  return (VALID_ENVS as readonly string[]).includes(value);
}

function isEntity(value: string): value is IndexEntity {
  return (INDEX_ENTITIES as readonly string[]).includes(value);
}

/** Reads `--name=value` or `--name value`. Returns undefined if absent. */
function readValueFlag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  if (i !== -1 && i + 1 < argv.length) return argv[i + 1];
  return undefined;
}

/** Parse `entity:uuid,entity:uuid` into targets (label defaults to the objectID). */
export function parseIdsFlag(raw: string): OrphanTarget[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((pair) => {
      const [entity, objectID] = pair.split(':');
      if (!entity || !objectID || !isEntity(entity)) {
        throw new Error(
          `Invalid --ids entry "${pair}". Expected "<products|vendors|integrations>:<objectID>".`,
        );
      }
      return { entity, objectID, label: objectID };
    });
}

export function parsePurgeArgs(argv: string[]): PurgeArgs {
  const envFlag = readValueFlag(argv, '--env') ?? 'staging';
  if (!isEnv(envFlag)) {
    throw new Error(
      `Invalid --env "${envFlag}". Expected one of: ${VALID_ENVS.join(', ')} (default: staging).`,
    );
  }
  const idsFlag = readValueFlag(argv, '--ids');
  return {
    env: envFlag,
    apply: argv.includes('--apply'),
    allowProduction: argv.includes('--allow-production'),
    ids: idsFlag !== undefined ? parseIdsFlag(idsFlag) : undefined,
  };
}

/**
 * Resolve the Algolia credentials from a key/value source (typically `process.env`).
 * One Algolia application backs every environment, so a single MANAGEMENT (admin)
 * key reaches any index — `env` here only decides which key NAME to read, not which
 * key can write. Accepts the generic `ALGOLIA_ADMIN_KEY` (the name the Worker + CI
 * map the secret into) or the per-env CI secret name `ALGOLIA_ADMIN_KEY_<ENV>`; the
 * env-specific name wins when both are present. `--env` selects the target indexes
 * (`staging_*`) — see `buildDeletePlan`.
 */
export function resolveAlgoliaCreds(
  env: AlgoliaEnv,
  source: Record<string, string | undefined>,
): AlgoliaBatchCredentials {
  const apiKey = source[`ALGOLIA_ADMIN_KEY_${env.toUpperCase()}`] ?? source.ALGOLIA_ADMIN_KEY;
  return { appId: source.ALGOLIA_APP_ID, apiKey };
}

/** Throw if the run would mutate production without the explicit guard flag. */
export function assertEnvAllowed(args: PurgeArgs): void {
  if (args.apply && args.env === 'production' && !args.allowProduction) {
    throw new Error(
      'Refusing to mutate PRODUCTION Algolia indexes. Pass --allow-production only if you are certain.',
    );
  }
}

/** A target resolved to its physical index name. */
export type PlannedDeletion = OrphanTarget & { indexName: string };

/** Resolve each target to its physical index name for the env. */
export function buildDeletePlan(
  orphans: readonly OrphanTarget[],
  env: AlgoliaEnv,
): PlannedDeletion[] {
  const names = localizedIndexNamesFor(env);
  return orphans.map((o) => ({ ...o, indexName: names[o.entity] }));
}

/** Group planned deletions by index so each index takes one batch call. */
export function groupByIndex(plan: readonly PlannedDeletion[]): Map<string, PlannedDeletion[]> {
  const byIndex = new Map<string, PlannedDeletion[]>();
  for (const item of plan) {
    const bucket = byIndex.get(item.indexName);
    if (bucket) bucket.push(item);
    else byIndex.set(item.indexName, [item]);
  }
  return byIndex;
}

/** A search hit, trimmed to the fields useful for human confirmation. */
export type AlgoliaObjectHit = {
  objectID: string;
  /** Best-effort display name (`name`/`title`/`slug`), for the operator log. */
  display: string;
};

/** Injected read/delete surface — fetch-based factory below; faked in tests. */
export type OrphanPurgeClient = {
  /** GET one object. `found:false` for a 404; throws on other non-2xx. `consistent`
   *  reads from the write host (read-after-write) instead of the lagging `-dsn` DSN —
   *  used by post-delete verification. */
  getObject(
    indexName: string,
    objectID: string,
    opts?: { consistent?: boolean },
  ): Promise<{ found: boolean }>;
  /** Search an index and return trimmed hits. */
  search(indexName: string, query: string): Promise<AlgoliaObjectHit[]>;
  /** Delete objects by objectID via the shared batch transport. */
  deleteObjects(indexName: string, objectIDs: string[]): Promise<AlgoliaBatchOutcome>;
  /** Block until an indexing task has published (Algolia writes are asynchronous). */
  waitTask(indexName: string, taskID: number): Promise<void>;
};

function displayNameOf(record: Record<string, unknown>): string {
  for (const key of ['name', 'title', 'slug'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '(no name)';
}

/** Resolve after `ms` — `waitTask`'s poll backoff. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetch-based `OrphanPurgeClient`. Reads default to the `-dsn` read host (matching
 * `./algolia-drift`'s counter); a `consistent` read and `waitTask` hit the write host
 * (`{appId}.algolia.net`) for read-after-write. Deletes reuse `callAlgoliaBatch`. The
 * management key's `search` + `deleteObject` ACLs cover all calls.
 */
export function createOrphanPurgeClient(
  creds: AlgoliaBatchCredentials,
  fetchImpl: typeof fetch = fetch,
): OrphanPurgeClient {
  const appId = creds.appId ?? '';
  const headers = {
    'content-type': 'application/json',
    'X-Algolia-Application-Id': appId,
    'X-Algolia-API-Key': creds.apiKey ?? '',
  };
  return {
    async getObject(indexName, objectID, opts) {
      // Default reads hit the DSN (what the public search sees); `consistent` reads
      // the write host so post-delete verification isn't fooled by DSN lag.
      const host = opts?.consistent ? `${appId}.algolia.net` : `${appId}-dsn.algolia.net`;
      const url = `https://${host}/1/indexes/${encodeURIComponent(indexName)}/${encodeURIComponent(
        objectID,
      )}`;
      const res = await fetchImpl(url, { method: 'GET', headers });
      if (res.status === 404) {
        // Neither existence branch reads the body, and an unread body holds its
        // connection open until GC (AECI-666).
        discardResponseBody(res);
        return { found: false };
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `Algolia getObject failed for ${indexName}/${objectID}: HTTP ${res.status}${
            detail ? ` — ${detail.slice(0, 200)}` : ''
          }`,
        );
      }
      discardResponseBody(res);
      return { found: true };
    },
    async search(indexName, query) {
      const url = `https://${appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(indexName)}/query`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          params: `query=${encodeURIComponent(query)}&hitsPerPage=20&analytics=false`,
        }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `Algolia search failed for "${indexName}" (q=${query}): HTTP ${res.status}${
            detail ? ` — ${detail.slice(0, 200)}` : ''
          }`,
        );
      }
      const body = (await res.json()) as { hits?: Array<Record<string, unknown>> };
      return (body.hits ?? []).map((hit) => ({
        objectID: String(hit.objectID ?? ''),
        display: displayNameOf(hit),
      }));
    },
    deleteObjects(indexName, objectIDs) {
      return callAlgoliaBatch(
        fetchImpl,
        creds,
        indexName,
        objectIDs.map((objectID) => ({ action: 'deleteObject' as const, body: { objectID } })),
      );
    },
    async waitTask(indexName, taskID) {
      // Poll the task until Algolia reports it published. Bounded backoff
      // (~35s worst case); a delete normally publishes in a second or two.
      const url = `https://${appId}.algolia.net/1/indexes/${encodeURIComponent(
        indexName,
      )}/task/${taskID}`;
      for (let attempt = 0; attempt < 20; attempt++) {
        const res = await fetchImpl(url, { method: 'GET', headers });
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === 'published') return;
        } else {
          // The non-ok path never reads the body, and this loop runs up to 20
          // times — so a task that keeps erroring parks 20 held connections in
          // one invocation, well past the limit (AECI-666).
          discardResponseBody(res);
        }
        await sleep(Math.min(250 * 2 ** attempt, 2000));
      }
    },
  };
}

/** Per-target outcome row. */
export type PurgeRow = {
  target: PlannedDeletion;
  presentBefore: boolean;
  deleted?: boolean;
  presentAfter?: boolean;
};

export type OrphanPurgeResult = {
  applied: boolean;
  /** false if any delete failed or any target survived verification. */
  ok: boolean;
  rows: PurgeRow[];
};

type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

/**
 * Run the purge: pre-flight (confirm each target exists + search probes to capture
 * the live objectIDs), then either print the dry-run plan or delete-and-verify.
 * All I/O is injected. Returns a structured result; the CLI maps `ok` to the exit
 * code. Never seeds or touches D1 — the correct end state is "absent from both D1
 * and the index".
 */
export async function runOrphanPurge(
  deps: { client: OrphanPurgeClient; log?: Logger },
  opts: { env: AlgoliaEnv; orphans: readonly OrphanTarget[]; apply: boolean },
): Promise<OrphanPurgeResult> {
  const log = deps.log ?? console;
  const { client } = deps;
  const plan = buildDeletePlan(opts.orphans, opts.env);
  const targetIds = new Set(plan.map((p) => p.objectID));
  const indexes = [...new Set(plan.map((p) => p.indexName))];

  log.log('── purge-algolia-orphans ──────────────────────────────────');
  log.log(`Mode:    ${opts.apply ? 'APPLY' : 'DRY RUN'}`);
  log.log(`Env:     ${opts.env}`);
  log.log(`Indexes: ${indexes.join(', ')}`);
  log.log(`Targets: ${plan.length}`);
  log.log('');

  // ── Pre-flight: confirm each target exists in its index ──────────────────────
  log.log('Pre-flight — confirming targets against the live index:');
  const rows: PurgeRow[] = [];
  for (const target of plan) {
    const { found } = await client.getObject(target.indexName, target.objectID);
    rows.push({ target, presentBefore: found });
    log.log(
      `  [${found ? 'present' : 'ABSENT '}] ${target.indexName}  ${target.objectID}  — ${target.label}`,
    );
  }
  log.log('');

  // ── Search probes: surface the live objectIDs (catch differing/extra orphans) ─
  log.log('Search probes — capturing live objectIDs:');
  for (const indexName of indexes) {
    for (const probe of SEARCH_PROBES) {
      const hits = await client.search(indexName, probe);
      log.log(`  ${indexName} ⟵ "${probe}": ${hits.length} hit(s)`);
      for (const hit of hits) {
        const known = targetIds.has(hit.objectID);
        log.log(`    ${known ? '✓ target ' : '⚠ EXTRA  '} ${hit.objectID}  — ${hit.display}`);
        if (!known) {
          log.warn(
            `      ↳ "${hit.display}" (${hit.objectID}) is NOT in the target list — ` +
              `investigate before relying on this run as complete.`,
          );
        }
      }
    }
  }
  log.log('');

  // ── Dry-run: report the plan and stop ────────────────────────────────────────
  if (!opts.apply) {
    const present = rows.filter((r) => r.presentBefore).length;
    log.log(
      `DRY RUN — nothing deleted. ${present}/${plan.length} target(s) present. ` +
        `Re-run with --apply to delete.`,
    );
    return { applied: false, ok: true, rows };
  }

  // ── Apply: one batch delete per index ────────────────────────────────────────
  let ok = true;
  const tasks: Array<{ indexName: string; taskID: number | undefined }> = [];
  log.log('Deleting:');
  for (const [indexName, items] of groupByIndex(plan)) {
    const outcome = await client.deleteObjects(
      indexName,
      items.map((i) => i.objectID),
    );
    if (outcome.ok) {
      log.log(`  ✓ ${indexName}: deleted ${items.length} object(s) (HTTP ${outcome.status})`);
      tasks.push({ indexName, taskID: outcome.taskID });
      for (const item of items) {
        const row = rows.find((r) => r.target.objectID === item.objectID);
        if (row) row.deleted = true;
      }
    } else {
      ok = false;
      log.error(`  ✗ ${indexName}: delete failed — ${outcome.message} (HTTP ${outcome.status})`);
    }
  }
  log.log('');

  // ── Wait for indexing: Algolia deletes are asynchronous, so block on each task
  //    before verifying — otherwise the read races the delete and false-fails. ──
  log.log('Waiting for indexing to publish…');
  for (const task of tasks) {
    if (task.taskID !== undefined) await client.waitTask(task.indexName, task.taskID);
  }
  log.log('');

  // ── Verify: each target must now be gone (read-after-write on the write host) ─
  log.log('Verifying deletion:');
  for (const row of rows) {
    const { found } = await client.getObject(row.target.indexName, row.target.objectID, {
      consistent: true,
    });
    row.presentAfter = found;
    if (found) {
      ok = false;
      log.error(`  ✗ ${row.target.indexName}  ${row.target.objectID} still present`);
    } else {
      log.log(`  ✓ ${row.target.indexName}  ${row.target.objectID} gone`);
    }
  }
  log.log('');
  log.log(
    ok
      ? '✓ Purge complete — all targets removed (verified on the write host). The public ' +
          '/search (DSN) catches up within ~a minute; the §23.1 drift gauge reads 0 on the next ' +
          'cron/deploy reconcile (orphans had no D1 row, so database − algolia → 0).'
      : '✗ Purge incomplete — see errors above.',
  );

  return { applied: true, ok, rows };
}
