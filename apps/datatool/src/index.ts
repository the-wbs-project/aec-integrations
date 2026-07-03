/**
 * datatool Worker entrypoint — an internal, Cloudflare-Access-gated admin tool.
 *
 * Two jobs from a UI (and JSON API): (1) copy/clone D1 data env→env (full mirror,
 * replace), and (2) seed reviews into any env. Both run a clean Algolia reindex +
 * edge-cache purge of the destination afterward. All writes are dry-run-by-default
 * and require typed confirmation; production needs an extra explicit confirm.
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

export default app;
