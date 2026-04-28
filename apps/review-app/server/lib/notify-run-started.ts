// ---------------------------------------------------------------------------
// Tells the RunsHub Durable Object that a workflow instance was just spawned.
// Used by both the route layer (POST /api/workflows/:name/run) and the
// orchestrator workflows (when they spawn child instances) so the bell + run
// detail UI can pick up the new run before the alarm reconciler does.
// ---------------------------------------------------------------------------
import type { Env } from '../env';
import type { RunStartedPayload } from '../do/runs-hub';

const HUB_URL = 'https://runs-hub.internal/run-started';

export async function notifyRunStarted(env: Env, payload: RunStartedPayload): Promise<void> {
  const id = env.RUNS_HUB.idFromName('singleton');
  const stub = env.RUNS_HUB.get(id);
  const res = await stub.fetch(HUB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => '<unreadable>');
    throw new Error(`RunsHub run-started failed: ${res.status} ${text}`);
  }
}
