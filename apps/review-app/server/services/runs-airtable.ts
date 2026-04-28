// ---------------------------------------------------------------------------
// Persistent run history — appends one row per terminal run to the Airtable
// `runs` table. Called by the RunsHub Durable Object after a run reaches a
// terminal status.
// ---------------------------------------------------------------------------
import { createRecord } from './airtable';
import type { Env } from '../env';
import type { RunRecord } from '../do/runs-hub';

// Airtable long-text caps at ~100k chars; leave headroom for the truncation
// marker so we never trip a 422 on a borderline-large output.
const MAX_OUTPUT_CHARS = 95_000;

export async function appendRunRow(env: Env, rec: RunRecord): Promise<string> {
  const fields: Record<string, unknown> = {
    run_id: rec.runId,
    workflow: rec.workflow,
    record_id: rec.recordId,
    record_label: rec.recordLabel ?? '',
    parent_run_id: rec.parentRunId ?? '',
    triggered_by: rec.triggeredBy,
    force_refresh: rec.forceRefresh,
    model: rec.model ?? '',
    started_at: rec.startedAt,
    status: rec.status,
    error_name: rec.error?.name ?? '',
    error_message: rec.error?.message ?? '',
    error_stack: rec.error?.stack ?? '',
    output_summary: serializeOutput(rec.output),
  };
  if (rec.finishedAt) fields['finished_at'] = rec.finishedAt;
  if (typeof rec.durationMs === 'number') fields['duration_ms'] = rec.durationMs;

  const row = await createRecord(env, 'runs', fields);
  return row.id;
}

function serializeOutput(output: unknown): string {
  if (output == null) return '';
  let json: string;
  try {
    json = JSON.stringify(output, null, 2);
  } catch {
    return '<unserializable output>';
  }
  if (json.length <= MAX_OUTPUT_CHARS) return json;
  return json.slice(0, MAX_OUTPUT_CHARS - 24) + '\n…[truncated]';
}
