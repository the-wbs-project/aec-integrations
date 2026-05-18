import { Hono } from 'hono';

import type { Env } from './env';
import { notFound } from './http';
import { createHealthHandler } from './routes/health';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', createHealthHandler());

app.all('/api/*', () => notFound('API route not found'));
app.all('*', () => notFound());

export default app;
