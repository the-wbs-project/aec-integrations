import { describe, expect, it, vi } from 'vitest';

import { ServerApiError, createServerApiClient } from './server-api-client';

function fetcherReturning(response: Response): { API: Fetcher } {
  // Cloudflare's Fetcher interface is broader than fetch (RPC methods etc.),
  // but for the binding's request path a single `fetch` is all the client
  // exercises. Cast through unknown to satisfy strict types in tests.
  const fetcher = {
    fetch: vi.fn().mockResolvedValue(response),
  } as unknown as Fetcher;
  return { API: fetcher };
}

describe('createServerApiClient', () => {
  it('returns the parsed JSON body for 2xx responses', async () => {
    const env = fetcherReturning(
      new Response(JSON.stringify({ ok: true, db: 'ok', latencyMs: 12 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createServerApiClient(env);
    const body = await client.request<{ ok: true; latencyMs: number }>('/api/health');

    expect(body).toEqual({ ok: true, db: 'ok', latencyMs: 12 });
  });

  it("sends the request through env.API.fetch with the binding's placeholder host", async () => {
    const env = fetcherReturning(new Response('{}', { status: 200 }));
    const client = createServerApiClient(env);

    await client.request('/api/health');

    const fetchMock = env.API.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledOnce();
    const sent = fetchMock.mock.calls[0][0] as Request;
    expect(sent.url).toBe('https://api/api/health');
  });

  it('throws ServerApiError with fields parsed from the canonical envelope', async () => {
    const envelope = {
      error: {
        code: 'NOT_FOUND',
        message: 'product not found',
        field: 'slug',
      },
      trace_id: 'trace-abc',
    };
    const env = fetcherReturning(
      new Response(JSON.stringify(envelope), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createServerApiClient(env);
    const err = await client.request('/api/products/missing').catch((e) => e);

    expect(err).toBeInstanceOf(ServerApiError);
    const apiError = err as ServerApiError;
    expect(apiError.status).toBe(404);
    expect(apiError.code).toBe('NOT_FOUND');
    expect(apiError.message).toBe('product not found');
    expect(apiError.field).toBe('slug');
    expect(apiError.traceId).toBe('trace-abc');
  });

  it('throws ServerApiError with code=UNKNOWN when the body is not the canonical envelope', async () => {
    const env = fetcherReturning(
      new Response('Internal Server Error — not JSON at all', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      }),
    );

    const client = createServerApiClient(env);
    const err = await client.request('/api/health').catch((e) => e);

    expect(err).toBeInstanceOf(ServerApiError);
    const apiError = err as ServerApiError;
    expect(apiError.status).toBe(500);
    expect(apiError.code).toBe('UNKNOWN');
    expect(apiError.message).toContain('Internal Server Error');
    expect(apiError.traceId).toBeNull();
  });

  it('throws ServerApiError with code=UNKNOWN when the JSON body fails envelope validation', async () => {
    const env = fetcherReturning(
      new Response(JSON.stringify({ error: 'old shape' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const client = createServerApiClient(env);
    const err = await client.request('/api/products').catch((e) => e);

    expect(err).toBeInstanceOf(ServerApiError);
    expect((err as ServerApiError).code).toBe('UNKNOWN');
    expect((err as ServerApiError).status).toBe(400);
  });

  it("rejects paths that do not start with '/'", async () => {
    const env = fetcherReturning(new Response('{}', { status: 200 }));
    const client = createServerApiClient(env);

    await expect(client.request('api/health')).rejects.toBeInstanceOf(TypeError);
  });
});

/**
 * AECI-203 — the cookie-forwarding option lets an authenticated SSR resolver
 * read the visitor's `sb-…-auth-token` cookie on the API Worker. The SSR runtime
 * builds a forwarding client ONLY on the non-cacheable branch; these tests pin
 * the client's own contract (forward when asked, never when not, never clobber).
 */
describe('createServerApiClient — forwardCookieFrom', () => {
  function capturingFetcher(): { env: { API: Fetcher }; sent: () => Request } {
    let captured: Request | undefined;
    const fetcher = {
      fetch: vi.fn(async (input: Request) => {
        captured = input;
        return new Response('{}', { status: 200 });
      }),
    } as unknown as Fetcher;
    return {
      env: { API: fetcher },
      sent: () => captured as Request,
    };
  }

  it('forwards the inbound Cookie header onto the outbound API request', async () => {
    const { env, sent } = capturingFetcher();
    const inbound = new Request('https://aecintegrations.com/admin', {
      headers: { cookie: 'sb-abc-auth-token=tok; theme=dark' },
    });
    const client = createServerApiClient(env, { forwardCookieFrom: inbound });

    await client.request('/api/admin/summary');

    expect(sent().headers.get('cookie')).toBe('sb-abc-auth-token=tok; theme=dark');
  });

  it('sends NO cookie when no forwarding request is provided (cacheable-branch default)', async () => {
    const { env, sent } = capturingFetcher();
    const client = createServerApiClient(env);

    await client.request('/api/admin/summary');

    expect(sent().headers.get('cookie')).toBeNull();
  });

  it('sends NO cookie when the forwarding request itself has none', async () => {
    const { env, sent } = capturingFetcher();
    const client = createServerApiClient(env, {
      forwardCookieFrom: new Request('https://aecintegrations.com/admin'),
    });

    await client.request('/api/admin/summary');

    expect(sent().headers.get('cookie')).toBeNull();
  });

  it('does not clobber a caller-supplied Cookie header', async () => {
    const { env, sent } = capturingFetcher();
    const inbound = new Request('https://aecintegrations.com/admin', {
      headers: { cookie: 'sb-abc-auth-token=inbound' },
    });
    const client = createServerApiClient(env, { forwardCookieFrom: inbound });

    await client.request('/api/admin/summary', {
      headers: { cookie: 'sb-abc-auth-token=explicit' },
    });

    expect(sent().headers.get('cookie')).toBe('sb-abc-auth-token=explicit');
  });
});
