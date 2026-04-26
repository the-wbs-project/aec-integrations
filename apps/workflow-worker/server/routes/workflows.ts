// ---------------------------------------------------------------------------
// Workflow endpoints
//   GET  /api/workflows                       → list available workflows
//   GET  /api/workflows/:name/options         → grouped record picker
//   POST /api/workflows/:name/run             → spawn one instance per record
//   GET  /api/workflows/:name/runs/:runId     → instance.status() for one run
//
// Every workflow is its own Cloudflare Workflow class with its own binding.
// The route layer dispatches via `env[bindingName]` looked up in the registry.
// One instance handles a single record_id; multi-record runs spawn N instances.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import { WORKFLOWS, workflowBinding, type WorkflowName } from '../workflows/registry';
import type { RunParams } from '../lib/workflow-meta';
import { listRecords, asString } from '../services/airtable';

const app = new Hono<{ Bindings: Env }>();

const VALID_MODEL = /^claude-(opus|sonnet|haiku)-[\w.-]+$/;

app.get('/', (c) => {
  return c.json({
    workflows: Object.values(WORKFLOWS).map(({ meta }) => ({
      name: meta.slug,
      description: meta.description,
    })),
  });
});

app.post('/:name/run', async (c) => {
  const name = c.req.param('name');
  const entry = WORKFLOWS[name];
  if (!entry) {
    return c.json({ error: `Unknown workflow: ${name}` }, 404);
  }

  const body = await c.req.json<{
    record_ids?: string[];
    record_id?: string;
    model?: string;
    search_tool?: 'web' | 'serpapi';
    search_provider?: 'serpapi' | 'searchapi';
  }>();

  const recordIds = body.record_ids ?? (body.record_id ? [body.record_id] : []);
  if (recordIds.length === 0) {
    return c.json({ error: 'Provide record_id or record_ids' }, 400);
  }

  const model = body.model ?? c.env.DEFAULT_MODEL;
  if (!VALID_MODEL.test(model)) {
    return c.json({ error: `Invalid model: ${model}` }, 400);
  }

  const binding = workflowBinding(c.env, name);
  if (!binding) {
    // Should be impossible — entry exists but binding doesn't.
    return c.json({ error: `Workflow binding missing: ${name}` }, 500);
  }

  const searchTool = body.search_tool ?? c.env.SEARCH_TOOL;
  const searchProvider = body.search_provider ?? c.env.SEARCH_PROVIDER;

  // Spawn one workflow instance per record. Errors creating any single
  // instance fail the whole request — no partial-spawn cleanup.
  const runs: Array<{ runId: string; recordId: string }> = [];
  try {
    for (const recordId of recordIds) {
      const runId = crypto.randomUUID();
      const params: RunParams = { recordId, model, searchTool, searchProvider };
      await binding.create({ id: runId, params });
      runs.push({ runId, recordId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to start run', details: message, runs }, 500);
  }

  return c.json({ workflow: name as WorkflowName, model, runs });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/:name/options
// ---------------------------------------------------------------------------
const OPTIONS_CACHE_TTL_SECONDS = 300;

app.get('/:name/options', async (c) => {
  const name = c.req.param('name');
  const entry = WORKFLOWS[name];
  if (!entry) {
    return c.json({ error: `Unknown workflow: ${name}` }, 404);
  }
  const meta = entry.meta;
  if (!meta.options) {
    return c.json({ supported: false });
  }

  const refresh = c.req.query('refresh') === '1';
  const cacheUrl = new URL(c.req.url);
  cacheUrl.searchParams.delete('refresh');
  const cacheKey = new Request(cacheUrl.toString(), { method: 'GET' });
  const cache = (caches as unknown as { default: Cache }).default;

  if (!refresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return new Response(hit.body, hit);
  }

  const { primaryField, stalenessField, labelField, staleAfterDays = 60 } = meta.options;
  const records = await listRecords(c.env, meta.table, {
    fields: [labelField, primaryField, stalenessField],
  });

  const cutoffMs = Date.now() - staleAfterDays * 24 * 60 * 60 * 1000;
  const missing: Array<{ id: string; label: string }> = [];
  const stale: Array<{ id: string; label: string }> = [];
  const recent: Array<{ id: string; label: string }> = [];

  for (const r of records) {
    const label = asString(r.fields[labelField]);
    if (!label) continue;
    const primary = asString(r.fields[primaryField]);
    if (!primary) {
      missing.push({ id: r.id, label });
      continue;
    }
    const checkedAtRaw = asString(r.fields[stalenessField]);
    const checkedAtMs = checkedAtRaw ? Date.parse(checkedAtRaw) : NaN;
    if (!Number.isFinite(checkedAtMs) || checkedAtMs < cutoffMs) {
      stale.push({ id: r.id, label });
    } else {
      recent.push({ id: r.id, label });
    }
  }

  const byLabel = (a: { label: string }, b: { label: string }) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' });
  missing.sort(byLabel);
  stale.sort(byLabel);
  recent.sort(byLabel);

  const payload = {
    supported: true as const,
    table: meta.table,
    primaryField,
    stalenessField,
    staleAfterDays,
    groups: [
      { key: 'missing', label: `Missing ${primaryField}`, records: missing },
      { key: 'stale', label: `Stale (${staleAfterDays}+ days)`, records: stale },
      { key: 'recent', label: 'Recently updated', records: recent },
    ],
  };

  const response = new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${OPTIONS_CACHE_TTL_SECONDS}`,
    },
  });
  c.executionCtx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
});

// ---------------------------------------------------------------------------
// GET /api/workflows/:name/runs/:runId — instance.status() for one run.
//
// Workflow name is in the path (rather than a query param) because each
// workflow has its own binding; the runId alone doesn't tell us which.
// ---------------------------------------------------------------------------
app.get('/:name/runs/:runId', async (c) => {
  const name = c.req.param('name');
  const runId = c.req.param('runId');
  const binding = workflowBinding(c.env, name);
  if (!binding) {
    return c.json({ error: `Unknown workflow: ${name}` }, 404);
  }
  try {
    const instance = await binding.get(runId);
    const status = await instance.status();
    return c.json({ runId, workflow: name, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Run not found', details: message }, 404);
  }
});

export default app;
