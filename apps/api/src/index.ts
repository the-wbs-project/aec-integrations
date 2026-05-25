import { Hono } from 'hono';

import type { Env } from './env';
import { notFound } from './http';
import { createHealthHandler } from './routes/health';
import { createVersionHandler } from './routes/version';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', createHealthHandler());
app.get('/api/version', createVersionHandler());

app.all('/api/*', () => notFound('API route not found'));
app.all('*', () => notFound());

export default app;
