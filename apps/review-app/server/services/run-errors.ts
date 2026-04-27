// ---------------------------------------------------------------------------
// Captured workflow errors — sidecar to recent-runs.
//
// Cloudflare Workflows surfaces only a generic WorkflowFatalError via
// instance.status(), which swallows the actual NonRetryableError message
// thrown inside the run() body. We capture the real error in the workflow's
// own try/catch (see ErrorCapturingWorkflow) and stash it here so the runs
// route can surface it in the UI.
// ---------------------------------------------------------------------------
import type { Env } from '../env';

const KEY_PREFIX = 'runs:error:';
// Match the recent-runs window with headroom — we never want the captured
// error to disappear before the run drops off the recent list.
const TTL_S = 60 * 60 * 24 * 30;

export interface CapturedError {
  name: string;
  message: string;
  stack?: string;
  capturedAt: string;
}

export async function putCapturedError(env: Env, runId: string, err: unknown): Promise<void> {
  const captured: CapturedError = {
    name: err instanceof Error ? err.name : 'Error',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
    capturedAt: new Date().toISOString(),
  };
  await env.KV_CACHE.put(`${KEY_PREFIX}${runId}`, JSON.stringify(captured), {
    expirationTtl: TTL_S,
  });
}

export async function getCapturedError(env: Env, runId: string): Promise<CapturedError | null> {
  return env.KV_CACHE.get<CapturedError>(`${KEY_PREFIX}${runId}`, 'json');
}
