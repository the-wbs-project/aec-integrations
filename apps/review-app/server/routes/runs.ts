// ---------------------------------------------------------------------------
// Recent runs endpoint — backs the notifications dropdown and /runs page.
//
//   GET /api/runs/recent?limit=25
//     → 200 { runs: Array<RecentRun & { status: string, error?, output? }> }
//
// The recent list (runId, workflow, recordId, recordLabel, startedAt) lives
// in KV under `runs:recent`. We hydrate it with each run's live status by
// calling the matching workflow binding's `instance.status()` in parallel.
// Failures from a single status() lookup are surfaced inline as
// status='unknown' so one bad runId doesn't poison the whole panel.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import { listRecent, type RecentRun } from '../services/recent-runs';
import { workflowBinding } from '../workflows/registry';

const app = new Hono<{ Bindings: Env }>();

interface HydratedRun extends RecentRun {
  status: string;
  error?: unknown;
  output?: unknown;
}

app.get('/recent', async (c) => {
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? 25)));
  const runs = await listRecent(c.env, limit);

  const hydrated: HydratedRun[] = await Promise.all(
    runs.map(async (run) => {
      const binding = workflowBinding(c.env, run.workflow);
      if (!binding) {
        return { ...run, status: 'unknown', error: `binding missing: ${run.workflow}` };
      }
      try {
        const instance = await binding.get(run.runId);
        const status = await instance.status();
        return {
          ...run,
          status: (status as { status?: string }).status ?? 'unknown',
          error: (status as { error?: unknown }).error,
          output: (status as { output?: unknown }).output,
        };
      } catch (err) {
        return {
          ...run,
          status: 'unknown',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );

  return c.json({ runs: hydrated });
});

export default app;
