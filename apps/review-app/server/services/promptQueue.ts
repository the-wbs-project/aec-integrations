// ---------------------------------------------------------------------------
// promptQueue — Airtable-backed prompt-job queue.
//
// Producers (HTTP route POST /api/prompt-queue) call enqueue() to push a
// rendered playbook prompt onto the queue. Consumers (the MCP tools used by
// a scheduled Claude Code task in the Claude macOS app) call listPending(),
// claim(), and complete() to drain the queue.
//
// The queue table lives in Airtable under env.AIRTABLE_TABLES.promptQueue.
// Schema (must be created manually in the base — see docs/prompt-queue.md):
//   playbook_slug   single line text
//   playbook_title  single line text
//   scope           long text (optional)
//   prompt          long text  (the rendered markdown the sub-agent runs)
//   status          single select  pending | running | completed | failed
//   requested_by    single line text  (Supabase user email)
//   model           single line text  (e.g. "opus")
//   created_at      datetime
//   started_at      datetime
//   completed_at    datetime
//   result_summary  long text
//   error           long text
//
// Status transitions: pending → running → completed|failed. claim() is the
// only path into running and rejects rows already past pending so two
// concurrent pollers can't double-dispatch the same job.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import { createRecord, getRecord, listRecords, tableId, updateRecord } from './airtable';
import { cacheInvalidate } from './cache';
import { getPlaybook, renderPlaybookPrompt } from '../playbooks';

export type PromptJobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface PromptJobSummary {
  id: string;
  playbook_slug: string;
  playbook_title: string;
  status: PromptJobStatus;
  created_at: string;
}

export interface PromptJobClaim {
  id: string;
  playbook_slug: string;
  playbook_title: string;
  scope: string;
  prompt: string;
  model: string;
}

export class PromptQueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptQueueValidationError';
  }
}

export class PromptJobAlreadyClaimedError extends Error {
  constructor(recordId: string, status: string) {
    super(`Prompt job ${recordId} is not pending (status=${status}); cannot claim.`);
    this.name = 'PromptJobAlreadyClaimedError';
  }
}

const DEFAULT_MODEL = 'opus';

function nowIso(): string {
  return new Date().toISOString();
}

async function invalidate(env: Env): Promise<void> {
  await cacheInvalidate(env.KV_CACHE, `table:${tableId(env, 'promptQueue')}`);
}

export interface EnqueueOptions {
  playbookSlug: string;
  scope?: string;
  requestedBy?: string;
  model?: string;
}

export interface EnqueueResult {
  recordId: string;
  playbookSlug: string;
  playbookTitle: string;
}

export async function enqueue(env: Env, opts: EnqueueOptions): Promise<EnqueueResult> {
  const playbook = getPlaybook(opts.playbookSlug);
  if (!playbook) {
    throw new PromptQueueValidationError(`Unknown playbook slug: ${opts.playbookSlug}`);
  }
  const scope = (opts.scope ?? '').trim();
  const prompt = renderPlaybookPrompt(playbook, scope);

  const fields: Record<string, unknown> = {
    playbook_slug: playbook.slug,
    playbook_title: playbook.frontmatter.title,
    scope,
    prompt,
    status: 'pending',
    model: opts.model ?? DEFAULT_MODEL,
    created_at: nowIso(),
  };
  if (opts.requestedBy) fields['requested_by'] = opts.requestedBy;

  const created = await createRecord(env, 'promptQueue', fields);
  await invalidate(env);
  return {
    recordId: created.id,
    playbookSlug: playbook.slug,
    playbookTitle: playbook.frontmatter.title,
  };
}

export async function listPending(env: Env, limit = 10): Promise<PromptJobSummary[]> {
  const records = await listRecords(env, 'promptQueue', {
    filterByFormula: "{status} = 'pending'",
    sort: [{ field: 'created_at', direction: 'asc' }],
    maxRecords: limit,
    fields: ['playbook_slug', 'playbook_title', 'status', 'created_at'],
  });
  return records.map((r) => ({
    id: r.id,
    playbook_slug: String(r.get('playbook_slug') ?? ''),
    playbook_title: String(r.get('playbook_title') ?? ''),
    status: (r.get('status') as PromptJobStatus) ?? 'pending',
    created_at: String(r.get('created_at') ?? ''),
  }));
}

export async function claim(env: Env, recordId: string): Promise<PromptJobClaim> {
  const existing = await getRecord(env, 'promptQueue', recordId);
  const status = String(existing.get('status') ?? '');
  if (status !== 'pending') {
    throw new PromptJobAlreadyClaimedError(recordId, status);
  }
  const updated = await updateRecord(env, 'promptQueue', recordId, {
    status: 'running',
    started_at: nowIso(),
  });
  await invalidate(env);
  return {
    id: updated.id,
    playbook_slug: String(updated.get('playbook_slug') ?? ''),
    playbook_title: String(updated.get('playbook_title') ?? ''),
    scope: String(updated.get('scope') ?? ''),
    prompt: String(updated.get('prompt') ?? ''),
    model: String(updated.get('model') ?? DEFAULT_MODEL),
  };
}

export interface CompleteOptions {
  status: 'completed' | 'failed';
  summary?: string;
  error?: string;
}

export async function complete(
  env: Env,
  recordId: string,
  opts: CompleteOptions,
): Promise<void> {
  const fields: Record<string, unknown> = {
    status: opts.status,
    completed_at: nowIso(),
  };
  if (opts.summary !== undefined) fields['result_summary'] = opts.summary;
  if (opts.error !== undefined) fields['error'] = opts.error;
  await updateRecord(env, 'promptQueue', recordId, fields);
  await invalidate(env);
}
