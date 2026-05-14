/**
 * AEC Integrations private API Worker.
 *
 * Scaffolded in AECI-27 with a single `/health` route. Real API surface
 * (Prisma Accelerate, business endpoints, service-binding entry) lands in
 * subsequent Phase 1 issues.
 */

import { Hono } from 'hono';

export type Bindings = {
  ENV: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get('/health', (c) => c.json({ ok: true, env: c.env.ENV ?? 'unknown' }));

app.all('*', (c) => c.json({ error: 'Not found' }, 404));

export default app;
