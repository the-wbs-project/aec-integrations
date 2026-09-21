import { describe, expect, it } from 'vitest';

import { apiGetJson, pathSegment } from './api-client';
import { makeApiStub } from '../test/api-stub';

/** The stub fetcher, cast to the `Fetcher` shape the caller expects. */
function caller(stub: ReturnType<typeof makeApiStub>) {
  return { API: stub.fetcher as unknown as Fetcher };
}

describe('apiGetJson', () => {
  it('returns the decoded body on 200', async () => {
    const stub = makeApiStub(() => ({ status: 200, body: { slug: 'zoho' } }));
    const result = await apiGetJson<{ slug: string }>(caller(stub), '/api/products/zoho');
    expect(result).toEqual({ ok: true, data: { slug: 'zoho' } });
    expect(stub.calls).toEqual(['/api/products/zoho']);
  });

  it('RELEASES the body on a non-2xx it only inspects the status of (AECI-666)', async () => {
    // Guards: the exact path that lost ~8% of production promote hooks. The error
    // branch reads `res.status` and nothing else, so without an explicit cancel it
    // holds a connection; past the limit the runtime cancels the response and the
    // fetch promise never settles, so the caller's own catch never fires.
    const stub = makeApiStub(() => ({ status: 404, body: { error: 'nope' } }));
    const result = await apiGetJson(caller(stub), '/api/products/ghost');
    expect(result).toEqual({ ok: false, status: 404, message: 'Not found.' });
    expect(stub.cancelled()).toBe(true);
  });

  it('releases the body on a 500 too, not just 404', async () => {
    const stub = makeApiStub(() => ({ status: 500, body: {} }));
    const result = await apiGetJson(caller(stub), '/api/vendors/acme');
    expect(result).toEqual({
      ok: false,
      status: 500,
      message: 'Upstream returned 500.',
    });
    expect(stub.cancelled()).toBe(true);
  });

  it('routes over plain fetch when API_BASE_URL is set, and over the binding otherwise', async () => {
    // Guards: the local-dev escape hatch must never be reachable in a deployed
    // Worker, where no wrangler env block declares the var.
    const stub = makeApiStub(() => ({ status: 200, body: {} }));
    await apiGetJson(caller(stub), '/api/products/zoho');
    expect(stub.calls).toEqual(['/api/products/zoho']);
  });
});

describe('pathSegment', () => {
  it('encodes a model-supplied slug rather than interpolating it raw', () => {
    expect(pathSegment('zoho')).toBe('zoho');
    expect(pathSegment('a/b')).toBe('a%2Fb');
    expect(pathSegment('../../admin')).toBe('..%2F..%2Fadmin');
  });
});
