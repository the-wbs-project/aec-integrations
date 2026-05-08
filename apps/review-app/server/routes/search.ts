import { Hono } from 'hono';
import type { Env } from '../env';
import {
  configureAeciSearch,
  searchAeciCorpus,
  syncAeciSearchCorpus,
  type AeciSearchRequest,
  type AeciSearchSyncRequest,
} from '../services/aeci-search';

const search = new Hono<{ Bindings: Env }>();

search.post('/', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<AeciSearchRequest>;
  if (typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json({ error: 'query is required' }, 400);
  }

  try {
    const result = await searchAeciCorpus(c.env, {
      query: body.query,
      filters: body.filters,
      limit: body.limit,
      matchThreshold: body.matchThreshold,
      retrievalType: body.retrievalType,
    });
    return c.json(result);
  } catch (err) {
    return c.json(
      {
        error: 'AI Search request failed',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

search.post('/sync', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as AeciSearchSyncRequest;
  try {
    const result = await syncAeciSearchCorpus(c.env, body);
    return c.json(result);
  } catch (err) {
    return c.json(
      {
        error: 'AI Search sync failed',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

search.post('/configure', async (c) => {
  try {
    const info = await configureAeciSearch(c.env);
    return c.json({ configured: true, instance: info });
  } catch (err) {
    return c.json(
      {
        error: 'AI Search configure failed',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

search.get('/status', async (c) => {
  try {
    const instance = c.env.AECI_SEARCH.get('aeci-search');
    const [info, stats] = await Promise.all([
      instance.info(),
      instance.stats(),
    ]);
    return c.json({ instance: info, stats });
  } catch (err) {
    return c.json(
      {
        error: 'AI Search status failed',
        details: err instanceof Error ? err.message : String(err),
      },
      502,
    );
  }
});

export default search;
