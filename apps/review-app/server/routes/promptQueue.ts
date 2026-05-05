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

promptQueue.post('/', async (c) => {
  let body: { playbook_slug?: unknown; scope?: unknown; model?: unknown };
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

  try {
    const result = await enqueue(c.env, {
      playbookSlug,
      scope,
      model,
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
