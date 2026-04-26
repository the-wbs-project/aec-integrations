// ---------------------------------------------------------------------------
// Tool endpoints — thin HTTP wrappers over the reusable services. Useful for
// poking at SERP/render manually with curl.
// ---------------------------------------------------------------------------
import { Hono } from 'hono';
import type { Env } from '../env';
import { runSerpSearch } from '../services/search';
import { renderPage } from '../services/render';

const app = new Hono<{ Bindings: Env }>();

app.get('/serp', async (c) => {
  const url = new URL(c.req.url);
  const query = url.searchParams.get('q');
  if (!query) {
    return c.json({ error: "Missing required 'q' parameter" }, 400);
  }
  const params = Object.fromEntries(url.searchParams.entries());
  const result = await runSerpSearch(c.env, params);
  return c.json(result.body, result.status as 200 | 502);
});

app.get('/render', async (c) => {
  const url = new URL(c.req.url);
  const target = url.searchParams.get('url');
  if (!target) {
    return c.json({ successful: false, results: null, error: "Missing required 'url' parameter" }, 400);
  }
  const mode = url.searchParams.get('mode') === 'text' ? 'text' : 'html';
  const maxChars = parseInt(url.searchParams.get('maxChars') || '0', 10);
  const result = await renderPage(c.env, target, { mode, maxChars });
  return c.json(result);
});

export default app;
