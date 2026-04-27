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
//
// On a successful POST /run we push each spawned runId onto the
// shared `runs:recent` list in KV so the notification bell can surface it
// without the client having to remember runIds across page loads.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import { WORKFLOWS, workflowBinding, type WorkflowName } from '../workflows/registry';
import type { RunParams } from '../lib/workflow-meta';
import { listRecords, asString } from '../services/airtable';
import { resolveSearchTool } from '../lib/llm';
import { pushRuns, type RecentRun } from '../services/recent-runs';
import { buildLookupMaps } from '../hydrate';

const app = new Hono<{ Bindings: Env }>();

const VALID_MODEL = /^claude-(opus|sonnet|haiku)-[\w.-]+$/;

app.get('/', (c) => {
  return c.json({
    workflows: Object.values(WORKFLOWS).map(({ meta }) => ({
      name: meta.slug,
      description: meta.description,
      table: meta.table,
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
    search_tool?: 'searchapi' | 'web';
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

  const requestedSearchTool = body.search_tool ?? c.env.SEARCH_TOOL ?? 'searchapi';
  const searchTool = resolveSearchTool(c.env, requestedSearchTool);

  // Spawn one workflow instance per record. Errors creating any single
  // instance fail the whole request — no partial-spawn cleanup.
  const runs: Array<{ runId: string; recordId: string }> = [];
  try {
    for (const recordId of recordIds) {
      const runId = crypto.randomUUID();
      const params: RunParams = { recordId, model, searchTool };
      await binding.create({ id: runId, params });
      runs.push({ runId, recordId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to start run', details: message, runs }, 500);
  }

  // Best-effort label lookup so the bell can show "Acme Co." instead of
  // "recXXXX". buildLookupMaps caches in KV (60s) so this is cheap on hot paths.
  let labels: Map<string, string> | undefined;
  try {
    const maps = await buildLookupMaps(c.env);
    labels = entry.meta.table === 'vendors' ? maps.vendors : entry.meta.table === 'tools' ? maps.tools : undefined;
  } catch {
    labels = undefined;
  }

  const startedAt = new Date().toISOString();
  const recent: RecentRun[] = runs.map((r) => ({
    runId: r.runId,
    workflow: name,
    recordId: r.recordId,
    recordLabel: labels?.get(r.recordId),
    startedAt,
  }));
  c.executionCtx.waitUntil(pushRuns(c.env, recent));

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
