/**
 * datatool Worker entrypoint — an internal, Cloudflare-Access-gated admin tool.
 *
 * Three jobs from a UI (and JSON API): (1) copy/clone D1 data env→env (full
 * mirror, replace), (2) seed reviews into any env, and (3) prune orphaned
 * `integrations` rows that no Airtable record points at. Each runs a clean
 * Algolia reindex + edge-cache purge of the target afterward. All writes are
 * dry-run-by-default and require typed confirmation; production needs an extra
 * explicit confirm. The prune adds three data-shape guards that refuse the delete
 * by default, overridable only by naming exactly the guards that tripped plus a
 * logged reason — see `prune-integrations.ts`.
 *
 * The mutating `/api/*` routes are gated by `requireAccess` (Access JWT or
 * TOOL_TOKEN); the UI shell and `/api/version` are not (the edge Access already
 * gates the host).
 */
import { Hono } from 'hono';

import { type AccessVariables, requireAccess } from './access';
import {
  reindexEnv,
  REINDEX_ENTITIES,
  type ReindexEntity,
  type ReindexResult,
} from './algolia-reindex';
import { purgeEnvCache } from './cache-purge';
import { copyDryRun, copyExecute } from './copy';
import type { Env } from './env';
import {
  MIN_ACK_REASON_LENGTH,
  parseAcknowledgedGuards,
  parseIds,
  type PruneGuardName,
  pruneExecute,
  prunePlan,
} from './prune-integrations';
import {
  applySeed,
  applyTeardown,
  DEFAULT_SEED,
  planFor,
  readProducts,
  summarizePlan,
} from './seed';
import { ENV_IDS, isEnvId, type Target, targetFor } from './targets';
import { renderUi } from './ui';

type App = { Bindings: Env; Variables: AccessVariables };

const app = new Hono<App>();

// Security headers on every response (no-store: this tool must never be cached).
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Cache-Control', 'no-store');
});

function genNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

function logOperation(operator: string, fields: Record<string, unknown>): void {
  // Captured by the Worker's observability logs (wrangler.jsonc) — the audit trail
  // for who copied/seeded what. A clone wipes audit_log, so we don't write a row in-DB.
  console.log(JSON.stringify({ event: 'datatool.operation', operator, ...fields }));
}

interface RefreshOutcome {
  reindex: ReindexResult;
  purge: { ok: boolean; status: number; message?: string };
}

/** Post-write refresh: clean reindex of the target's search indexes + cache purge. */
async function refreshTarget(
  target: Target,
  entities: readonly ReindexEntity[],
): Promise<RefreshOutcome> {
  const reindex = await reindexEnv(target.db, fetch, target.algolia, target.algoliaEnv, entities);
  const purge = await purgeEnvCache(fetch, target.purge);
  return { reindex, purge };
}

// ── UI + version (ungated; edge Access gates the host) ──────────────────────────

app.get('/', (c) => {
  const nonce = genNonce();
  return c.html(renderUi(nonce), 200, {
    'Content-Security-Policy': [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "style-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; '),
  });
});

app.get('/api/version', (c) =>
  c.json({
    sha: c.env.COMMIT_SHA ?? 'unknown',
    deployedAt: c.env.DEPLOYED_AT ?? new Date(0).toISOString(),
    environment: c.env.ENV ?? 'tool',
  }),
);

// ── Guards shared by the write routes ───────────────────────────────────────────

type WriteBody = { confirmName?: unknown; prodConfirm?: unknown };

function confirmationError(
  target: Target,
  body: WriteBody,
): { code: string; message: string } | null {
  if (body.confirmName !== target.dbName) {
    return {
      code: 'CONFIRM_MISMATCH',
      message: `Type the destination DB name ("${target.dbName}") to confirm.`,
    };
  }
  if (target.id === 'production' && body.prodConfirm !== true) {
    return {
      code: 'PROD_CONFIRM_REQUIRED',
      message: 'Writing to PRODUCTION requires prodConfirm: true.',
    };
  }
  return null;
}

// ── Copy ─────────────────────────────────────────────────────────────────────────

app.post('/api/copy', requireAccess(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { source, dest } = body;
  if (!isEnvId(source) || !isEnvId(dest)) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: `source and dest must be ${ENV_IDS.join('|')}`,
        },
      },
      400,
    );
  }
  if (source === dest) {
    return c.json({ error: { code: 'BAD_REQUEST', message: 'source and dest must differ' } }, 400);
  }
  const src = targetFor(c.env, source);
  const dst = targetFor(c.env, dest);

  const plan = await copyDryRun(src.db, dst.db);
  if (!plan.ok) {
    return c.json(
      {
        error: {
          code: plan.code,
          message: 'Source and destination schemas differ.',
          detail: plan.messages,
        },
      },
      400,
    );
  }

  const dryRun = body.dryRun !== false; // default true
  if (dryRun) {
    return c.json({
      ok: true,
      dryRun: true,
      source,
      dest,
      mode: 'replace',
      tables: plan.tables,
      totalSourceRows: plan.totalSourceRows,
      totalDestRows: plan.totalDestRows,
      note: 'Full clone (all tables). Executing replaces every destination row, including reviews/auth/analytics.',
    });
  }

  const err = confirmationError(dst, body);
  if (err) return c.json({ error: err }, 400);

  const result = await copyExecute(src.db, dst.db, plan.schema);
  const refresh = body.refresh === false ? null : await refreshTarget(dst, REINDEX_ENTITIES);
  logOperation(c.get('operator'), { op: 'copy', source, dest, inserted: result.inserted });
  return c.json({
    ok: true,
    executed: true,
    source,
    dest,
    inserted: result.inserted,
    perTable: result.perTable,
    refresh,
  });
});

// ── Seed reviews ──────────────────────────────────────────────────────────────────

app.post('/api/seed', requireAccess(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { target, action } = body;
  if (!isEnvId(target)) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: `target must be ${ENV_IDS.join('|')}` } },
      400,
    );
  }
  if (action !== 'apply' && action !== 'teardown') {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: "action must be 'apply' or 'teardown'" } },
      400,
    );
  }
  const t = targetFor(c.env, target);
  const products = await readProducts(t.db);
  if (products.length === 0) {
    return c.json(
      {
        error: {
          code: 'NO_PRODUCTS',
          message: 'Target has no products — copy or promote the catalog first.',
        },
      },
      400,
    );
  }

  const dryRun = body.dryRun !== false; // default true

  if (action === 'teardown') {
    if (dryRun) {
      return c.json({
        ok: true,
        dryRun: true,
        action: 'teardown',
        target,
        products: products.length,
        willRemove: "reviews matching 'aeceed00-%'",
      });
    }
    const err = confirmationError(t, body);
    if (err) return c.json({ error: err }, 400);
    await applyTeardown(t.db);
    const refresh = body.refresh === false ? null : await refreshTarget(t, ['products']);
    logOperation(c.get('operator'), { op: 'seed-teardown', target });
    return c.json({ ok: true, executed: true, action: 'teardown', target, refresh });
  }

  const seed = Number.isInteger(body.seed) ? (body.seed as number) : DEFAULT_SEED;
  const plan = planFor(products, seed);
  const summary = summarizePlan(plan, products);
  if (dryRun) {
    return c.json({ ok: true, dryRun: true, action: 'apply', target, seed, summary });
  }
  const err = confirmationError(t, body);
  if (err) return c.json({ error: err }, 400);
  const { inserted } = await applySeed(t.db, plan);
  const refresh = body.refresh === false ? null : await refreshTarget(t, ['products']);
  logOperation(c.get('operator'), { op: 'seed-apply', target, seed, inserted });
  return c.json({
    ok: true,
    executed: true,
    action: 'apply',
    target,
    seed,
    inserted,
    summary,
    refresh,
  });
});

// ── Standalone reindex (no copy/seed) ────────────────────────────────────────────

app.post('/api/reindex', requireAccess(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { target } = body;
  if (!isEnvId(target)) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: `target must be ${ENV_IDS.join('|')}` } },
      400,
    );
  }
  const t = targetFor(c.env, target);
  const requested = Array.isArray(body.entities)
    ? body.entities.filter((e): e is ReindexEntity =>
        (REINDEX_ENTITIES as readonly string[]).includes(e as string),
      )
    : [];
  const entities = requested.length ? requested : REINDEX_ENTITIES;
  const reindex = await reindexEnv(t.db, fetch, t.algolia, t.algoliaEnv, entities);
  const purge = body.purge === false ? null : await purgeEnvCache(fetch, t.purge);
  logOperation(c.get('operator'), { op: 'reindex', target, entities });
  return c.json({ ok: true, target, reindex, purge });
});

// ── Prune orphaned integrations ──────────────────────────────────────────────────

app.post('/api/prune-integrations', requireAccess(), async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const { target } = body;
  if (!isEnvId(target)) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: `target must be ${ENV_IDS.join('|')}` } },
      400,
    );
  }

  let ids: string[];
  try {
    ids = parseIds(body.ids);
  } catch (e) {
    return c.json({ error: { code: 'BAD_IDS', message: (e as Error).message } }, 400);
  }

  const t = targetFor(c.env, target);
  const plan = await prunePlan(t.db, ids);
  const dryRun = body.dryRun !== false; // default true

  if (dryRun) {
    return c.json({
      ok: plan.blocked.length === 0,
      dryRun: true,
      target,
      ...plan,
      note:
        plan.blocked.length > 0
          ? `BLOCKED by ${plan.blocked.join(', ')} — these rows are not redundant copies. Stop here unless an editorial ruling says the content is retracted; to proceed anyway, pass acknowledgeGuards: ${JSON.stringify(plan.blocked)} with an acknowledgeReason.`
          : 'Save rollbackSql before executing: D1 has no undo and this Worker cannot write files.',
    });
  }

  // A tripped guard means at least one row is NOT a redundant copy. Refuse on the
  // execute path too, not just in the dry-run summary — the operator may not have
  // re-read the plan, and this is the last gate before an irreversible delete.
  //
  // Overridable, but only deliberately: the acknowledged set must EXACTLY equal the
  // tripped set (see prune-integrations.ts for why exact rather than "at least").
  let acknowledged: PruneGuardName[];
  try {
    acknowledged = parseAcknowledgedGuards(body.acknowledgeGuards);
  } catch (e) {
    return c.json({ error: { code: 'BAD_ACK_GUARDS', message: (e as Error).message } }, 400);
  }
  const acknowledgeReason =
    typeof body.acknowledgeReason === 'string' ? body.acknowledgeReason.trim() : '';

  const unacknowledged = plan.blocked.filter((g) => !acknowledged.includes(g));
  const notTripped = acknowledged.filter((g) => !plan.blocked.includes(g));

  if (unacknowledged.length > 0) {
    return c.json(
      {
        error: {
          code: 'GUARD_TRIPPED',
          message: `Refusing to delete: ${unacknowledged.join(', ')} is non-zero. These rows are not redundant copies. To delete anyway, pass acknowledgeGuards: ${JSON.stringify(plan.blocked)} with an acknowledgeReason.`,
          guards: plan.guards,
          blocked: plan.blocked,
        },
      },
      409,
    );
  }
  if (notTripped.length > 0) {
    // Acknowledging a guard that reads zero means the plan under review is not the
    // plan that just ran — the data moved, or the wrong ids were pasted. Refuse
    // rather than proceed on a stale understanding.
    return c.json(
      {
        error: {
          code: 'GUARD_ACK_STALE',
          message: `Acknowledged ${notTripped.join(', ')}, which read zero on this plan — the plan you reviewed is not the plan that just ran. Re-run the dry run and acknowledge exactly its blocked list (${plan.blocked.length ? plan.blocked.join(', ') : 'empty'}).`,
          guards: plan.guards,
          blocked: plan.blocked,
        },
      },
      400,
    );
  }
  if (acknowledged.length > 0 && acknowledgeReason.length < MIN_ACK_REASON_LENGTH) {
    return c.json(
      {
        error: {
          code: 'ACK_REASON_REQUIRED',
          message: `Overriding ${acknowledged.join(', ')} requires acknowledgeReason (min ${MIN_ACK_REASON_LENGTH} characters). A prune writes no audit_log row, so this is the only durable record of why the guard was overridden.`,
        },
      },
      400,
    );
  }
  if (plan.found === 0) {
    return c.json(
      { error: { code: 'NOTHING_TO_PRUNE', message: 'None of those ids matched a live row.' } },
      400,
    );
  }

  const err = confirmationError(t, body);
  if (err) return c.json({ error: err }, 400);

  // Captured pre-delete: afterwards the join that finds these products is gone.
  const { rollbackSql, affectedProductIds, affectedSlugs } = plan;
  const result = await pruneExecute(t.db, ids, affectedProductIds);

  // Reindex rebuilds `integrations` from D1 (clear + repopulate), which is also
  // what evicts the deleted objects from Algolia — so the search follow-up is
  // part of this operation rather than a separate manual step.
  const refresh =
    body.refresh === false ? null : await refreshTarget(t, ['products', 'integrations']);

  logOperation(c.get('operator'), {
    op: 'prune-integrations',
    target,
    requested: plan.requested,
    deleted: result.deleted,
    recounted: result.recounted.length,
    // The audit trail for an overridden guard: who, which guards, and why.
    acknowledgedGuards: acknowledged,
    acknowledgeReason: acknowledged.length ? acknowledgeReason : undefined,
  });

  return c.json({
    ok: true,
    executed: true,
    target,
    ...result,
    affectedSlugs,
    acknowledgedGuards: acknowledged,
    acknowledgeReason: acknowledged.length ? acknowledgeReason : null,
    refresh,
    rollbackSql,
  });
});

export default app;
