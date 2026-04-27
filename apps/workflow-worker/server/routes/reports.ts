// ---------------------------------------------------------------------------
// Reports endpoints.
//
//   POST /api/reports/weekly-cost  → enqueue an ad-hoc weekly cost report
//                                    onto REPORTS_QUEUE. Returns 202.
//                                    Optional JSON body: { lookbackDays: number }.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import type { ReportJob } from '../services/reports/types';

const app = new Hono<{ Bindings: Env }>();

app.post('/weekly-cost', async (c) => {
  let lookbackDays: number | undefined;
  // Body is optional — only parse if there's content.
  try {
    if (c.req.header('content-length') && c.req.header('content-length') !== '0') {
      const body = await c.req.json<{ lookbackDays?: number }>();
      if (typeof body?.lookbackDays === 'number' && body.lookbackDays > 0) {
        lookbackDays = body.lookbackDays;
      }
    }
  } catch {
    // Ignore body parse errors — it's optional.
  }

  const job: ReportJob = { kind: 'weekly-cost-report', triggeredBy: 'http', lookbackDays };
  await c.env.REPORTS_QUEUE.send(job);
  return c.json({ status: 'enqueued', job }, 202);
});

export default app;
