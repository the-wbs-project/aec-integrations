// ---------------------------------------------------------------------------
// Workflow endpoints
//   POST /api/workflows/:name/run   → start a run, return runId
//   GET  /api/workflows/runs/:runId → return current state
//   GET  /api/workflows             → list available workflow names
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import { WORKFLOWS, type WorkflowName } from '../workflows/registry';
import type { StartRunInput } from '../durable-objects/WorkflowRun';
import { listRecords, asString } from '../services/airtable';

const app = new Hono<{ Bindings: Env }>();

const VALID_MODEL = /^claude-(opus|sonnet|haiku)-[\w.-]+$/;

app.get('/', (c) => {
  return c.json({
    workflows: Object.keys(WORKFLOWS).map((name) => ({
      name,
      description: WORKFLOWS[name as WorkflowName].description,
    })),
  });
});

app.post('/:name/run', async (c) => {
  const name = c.req.param('name');
  if (!(name in WORKFLOWS)) {
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

  const runId = crypto.randomUUID();
  const stub = c.env.WORKFLOW_RUN.get(c.env.WORKFLOW_RUN.idFromName(runId));

  const input: StartRunInput = {
    runId,
    workflow: name as WorkflowName,
    model,
    searchTool: body.search_tool ?? c.env.SEARCH_TOOL,
    searchProvider: body.search_provider ?? c.env.SEARCH_PROVIDER,
    recordIds,
  };

  const startRes = await stub.fetch('https://workflow-run/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!startRes.ok) {
    const errBody = await startRes.text();
    return c.json({ error: 'Failed to start run', details: errBody }, 500);
  }

  return c.json({ runId, workflow: name, recordIds, model });
});

// ---------------------------------------------------------------------------
// GET /api/workflows/:name/options
// Returns the workflow's records bucketed into missing / stale / recent groups
// for the runner-page picker. Workflows opt in by declaring `options` on their
// definition; without it we return { supported: false } so the UI can fall
// back to the comma-separated text input.
//
// Response is cached in the Worker Cache API for 5 minutes; pass ?refresh=1
// to bypass and repopulate.
// ---------------------------------------------------------------------------
const OPTIONS_CACHE_TTL_SECONDS = 300;

app.get('/:name/options', async (c) => {
  const name = c.req.param('name');
  if (!(name in WORKFLOWS)) {
    return c.json({ error: `Unknown workflow: ${name}` }, 404);
  }
  const workflow = WORKFLOWS[name as WorkflowName];
  if (!workflow.options) {
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

  const { primaryField, stalenessField, labelField, staleAfterDays = 60 } = workflow.options;
  const records = await listRecords(c.env, workflow.table, {
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
    table: workflow.table,
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

app.get('/runs/:runId', async (c) => {
  const runId = c.req.param('runId');
  const stub = c.env.WORKFLOW_RUN.get(c.env.WORKFLOW_RUN.idFromName(runId));
  const res = await stub.fetch('https://workflow-run/status');
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' },
  });
});

export default app;
