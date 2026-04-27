import { Hono } from 'hono';
import type { Env } from '../env';

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) =>
  c.json({
    status: 'ok',
    time: new Date().toISOString(),
    searchTool: c.env.SEARCH_TOOL,
    searchApiConfigured: Boolean(c.env.SEARCHAPI_API_KEY),
    defaultModel: c.env.DEFAULT_MODEL,
  }),
);

export default app;
