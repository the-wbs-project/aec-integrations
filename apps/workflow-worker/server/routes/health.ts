import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    status: 'ok',
    time: new Date().toISOString(),
    searchProvider: c.env.SEARCH_PROVIDER,
    searchTool: c.env.SEARCH_TOOL,
    defaultModel: c.env.DEFAULT_MODEL,
  }),
);

export default app;
