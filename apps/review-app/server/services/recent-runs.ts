// ---------------------------------------------------------------------------
// Recent workflow runs — durable list of runIds in KV so the notification
// bell can show "what just happened" across browser sessions / tabs.
//
// Storage: a single JSON array under key `runs:recent`. We cap to MAX_ENTRIES
// on every write to keep payloads small. Each entry records just enough to
// look up the underlying Workflow instance via `instance.status()` (which is
// the live source of truth for status / error / output).
// ---------------------------------------------------------------------------
import type { Env } from '../env';

const KEY = 'runs:recent';
const MAX_ENTRIES = 100;

export interface RecentRun {
  runId: string;
  workflow: string;
  recordId: string;
  /** Optional human-readable label for the record (e.g. company_name / Name). */
  recordLabel?: string;
  /** ISO timestamp when the run was kicked off. */
  startedAt: string;
}

/**
 * Push one or more runs onto the head of the recent list. Newer entries
 * appear first. Older entries past MAX_ENTRIES are dropped.
 */
export async function pushRuns(env: Env, runs: RecentRun[]): Promise<void> {
  if (runs.length === 0) return;
  const existing = (await env.KV_CACHE.get<RecentRun[]>(KEY, 'json')) ?? [];
  const merged = [...runs, ...existing].slice(0, MAX_ENTRIES);
  await env.KV_CACHE.put(KEY, JSON.stringify(merged));
}

/** Most recent N runs (newest first). */
export async function listRecent(env: Env, limit = 25): Promise<RecentRun[]> {
  const all = (await env.KV_CACHE.get<RecentRun[]>(KEY, 'json')) ?? [];
  return all.slice(0, Math.min(MAX_ENTRIES, Math.max(1, limit)));
}
