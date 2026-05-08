// ---------------------------------------------------------------------------
// Snapshot endpoints.
//
//   POST /api/snapshots/run  → enqueue an ad-hoc daily_stats snapshot onto
//                              SNAPSHOTS_QUEUE. Returns 202.
//                              Optional JSON body: { date?: 'YYYY-MM-DD' }.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import type { SnapshotJob } from '../services/snapshot/types';

const app = new Hono<{ Bindings: Env }>();

app.post('/run', async (c) => {
  let date: string | undefined;
  try {
    if (c.req.header('content-length') && c.req.header('content-length') !== '0') {
      const body = await c.req.json<{ date?: string }>();
      if (typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        date = body.date;
      }
    }
  } catch {
    // Body is optional.
  }

  const job: SnapshotJob = { kind: 'daily-stats-snapshot', triggeredBy: 'http', date };
  await c.env.SNAPSHOTS_QUEUE.send(job);
  return c.json({ status: 'enqueued', job }, 202);
});

export default app;
