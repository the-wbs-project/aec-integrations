// ---------------------------------------------------------------------------
// MCP prompt-queue tools — drive the Airtable-backed prompt-job queue from a
// scheduled Claude Code dispatcher.
//
// Intended usage (see playbooks/process-prompt-queue.md):
//   1. list_pending_prompt_jobs(limit?)   → cheap summary list, oldest first.
//   2. claim_prompt_job(record_id)        → atomically flip pending → running
//                                           and return the rendered prompt.
//   3. dispatch the prompt to a sub-agent on Opus.
//   4. complete_prompt_job(record_id, …)  → terminal state + summary/error.
// ---------------------------------------------------------------------------
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Env } from '../../env';
import {
  PromptJobAlreadyClaimedError,
  claim,
  complete,
  listPending,
} from '../../services/promptQueue';
import { err, ok, toMessage } from '../helpers';

export function registerPromptQueueTools(
  server: McpServer,
  getEnv: () => Env,
): void {
  // -------------------------------------------------------------------------
  // list_pending_prompt_jobs
  // -------------------------------------------------------------------------
  server.tool(
    'list_pending_prompt_jobs',
    'List prompt jobs with status="pending" from the prompt_queue table, oldest first. Returns just summary fields (id, playbook_slug, playbook_title, created_at) — call claim_prompt_job to fetch the rendered prompt body. Use this from the scheduled dispatcher every 10 minutes.',
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('Max rows to return. Defaults to 10.'),
    },
    async (input) => {
      try {
        const jobs = await listPending(getEnv(), input.limit ?? 10);
        return ok({ jobs, total: jobs.length });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // claim_prompt_job
  // -------------------------------------------------------------------------
  server.tool(
    'claim_prompt_job',
    'Atomically claim a pending prompt job: flips status pending→running, sets started_at, and returns the rendered `prompt` markdown to feed into a sub-agent. Errors if the row is not currently pending — that means another dispatcher already grabbed it; skip it.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the prompt_queue row, e.g. "rec0123…".'),
    },
    async (input) => {
      try {
        const job = await claim(getEnv(), input.record_id);
        return ok(job);
      } catch (e) {
        if (e instanceof PromptJobAlreadyClaimedError) return err(e.message);
        return err(toMessage(e));
      }
    },
  );

  // -------------------------------------------------------------------------
  // complete_prompt_job
  // -------------------------------------------------------------------------
  server.tool(
    'complete_prompt_job',
    'Mark a claimed prompt job as completed or failed. Set `summary` to a 1–2 sentence recap of what the sub-agent did/found. On failure, also pass `error` with the underlying error message.',
    {
      record_id: z
        .string()
        .min(1)
        .describe('Airtable record ID of the prompt_queue row.'),
      status: z
        .enum(['completed', 'failed'])
        .describe('Terminal status. Use "failed" only if the sub-agent could not produce a usable result.'),
      summary: z
        .string()
        .optional()
        .describe('Short recap of the sub-agent run (1–2 sentences).'),
      error: z
        .string()
        .optional()
        .describe('Error detail when status="failed".'),
    },
    async (input) => {
      try {
        await complete(getEnv(), input.record_id, {
          status: input.status,
          summary: input.summary,
          error: input.error,
        });
        return ok({ ok: true, record_id: input.record_id, status: input.status });
      } catch (e) {
        return err(toMessage(e));
      }
    },
  );
}
