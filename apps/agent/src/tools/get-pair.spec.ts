import { describe, expect, it } from 'vitest';

import { getPair } from './get-pair';
import { makeApiStub } from '../test/api-stub';

function caller(stub: ReturnType<typeof makeApiStub>) {
  return { API: stub.fetcher as unknown as Fetcher };
}

describe('get_pair', () => {
  it('calls the real pair route, context product first', async () => {
    // Guards: the endpoint is GET /api/products/:slug/integrations/:otherSlug and
    // the FIRST slug is the context the response is oriented to.
    const stub = makeApiStub(() => ({ status: 200, body: { mechanisms: [] } }));
    const out = await getPair(caller(stub), { slug: 'procore', otherSlug: 'sage-intacct' });
    expect(stub.calls).toEqual(['/api/products/procore/integrations/sage-intacct']);
    expect(out).toEqual({ found: true, pair: { mechanisms: [] } });
  });

  it('passes through an empty mechanism list rather than calling it a miss', async () => {
    // Guards: a pair page with no edge is a 200 with nothing in it, not a 404.
    const stub = makeApiStub(() => ({ status: 200, body: { mechanisms: [] } }));
    const out = (await getPair(caller(stub), { slug: 'a', otherSlug: 'b' })) as {
      found: boolean;
      pair: { mechanisms: unknown[] };
    };
    expect(out.found).toBe(true);
    expect(out.pair.mechanisms).toEqual([]);
  });

  it('reports a miss without throwing, and releases the body (AECI-666)', async () => {
    const stub = makeApiStub(() => ({ status: 404, body: {} }));
    const out = await getPair(caller(stub), { slug: 'ghost', otherSlug: 'other' });
    expect(out).toEqual({
      found: false,
      slug: 'ghost',
      other_slug: 'other',
      message: 'Not found.',
    });
    expect(stub.cancelled()).toBe(true);
  });

  it('encodes both model-supplied slugs', async () => {
    const stub = makeApiStub(() => ({ status: 404, body: {} }));
    await getPair(caller(stub), { slug: 'a/b', otherSlug: 'c/d' });
    expect(stub.calls).toEqual(['/api/products/a%2Fb/integrations/c%2Fd']);
  });
});
