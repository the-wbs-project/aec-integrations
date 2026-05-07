// ---------------------------------------------------------------------------
// POST /api/prompt-queue
//
// Enqueue a playbook prompt for the scheduled Claude Code dispatcher (a
// macOS Claude task running on Sonnet) to pick up later. The dispatcher polls
// the same Airtable table via MCP tools — see services/promptQueue.ts and
// mcp/tools/prompt-queue-tools.ts.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import type { AuthVariables } from '../middleware/auth';
import { enqueue, PromptQueueValidationError } from '../services/promptQueue';

const promptQueue = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

const RECORD_ID_RE = /^rec[A-Za-z0-9]{14}$/;

promptQueue.post('/', async (c) => {
  let body: {
    playbook_slug?: unknown;
    scope?: unknown;
    model?: unknown;
    target_record_id?: unknown;
    aspect?: unknown;
    force_refresh?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const playbookSlug = typeof body.playbook_slug === 'string' ? body.playbook_slug.trim() : '';
  if (!playbookSlug) {
    return c.json({ error: 'playbook_slug is required' }, 400);
  }
  const scope = typeof body.scope === 'string' ? body.scope : undefined;
  const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : undefined;

  let targetRecordId: string | undefined;
  if (body.target_record_id !== undefined && body.target_record_id !== null) {
    if (typeof body.target_record_id !== 'string' || !RECORD_ID_RE.test(body.target_record_id.trim())) {
      return c.json({ error: 'target_record_id must match ^rec[A-Za-z0-9]{14}$' }, 400);
    }
    targetRecordId = body.target_record_id.trim();
  }

  let aspect: string | undefined;
  if (typeof body.aspect === 'string' && body.aspect.trim()) {
    aspect = body.aspect.trim();
  }

  let forceRefresh: boolean | undefined;
  if (typeof body.force_refresh === 'boolean') {
    forceRefresh = body.force_refresh;
  }

  try {
    const result = await enqueue(c.env, {
      playbookSlug,
      scope,
      model,
      targetRecordId,
      aspect,
      forceRefresh,
      requestedBy: c.var.user.email ?? c.var.user.id,
    });
    return c.json(result, 201);
  } catch (e) {
    if (e instanceof PromptQueueValidationError) {
      return c.json({ error: e.message }, 400);
    }
    const message = e instanceof Error ? e.message : String(e);
    return c.json({ error: 'Failed to enqueue prompt job', details: message }, 500);
  }
});

export default promptQueue;
