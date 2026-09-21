import { describe, expect, it } from 'vitest';

import { getProduct } from './get-product';
import { makeApiStub } from '../test/api-stub';

function caller(stub: ReturnType<typeof makeApiStub>) {
  return { API: stub.fetcher as unknown as Fetcher };
}

describe('get_product', () => {
  it('calls the public product endpoint and returns its payload', async () => {
    // Guards: it must go through the API Worker, which owns the allowlist and
    // the mappers — not through D1.
    const stub = makeApiStub(() => ({ status: 200, body: { slug: 'zoho', name: 'Zoho' } }));
    const out = await getProduct(caller(stub), { slug: 'zoho' });
    expect(stub.calls).toEqual(['/api/products/zoho']);
    expect(out).toEqual({ found: true, product: { slug: 'zoho', name: 'Zoho' } });
  });

  it('reports a miss without throwing, and releases the body (AECI-666)', async () => {
    const stub = makeApiStub(() => ({ status: 404, body: {} }));
    const out = await getProduct(caller(stub), { slug: 'ghost' });
    expect(out).toEqual({ found: false, slug: 'ghost', message: 'Not found.' });
    expect(stub.cancelled()).toBe(true);
  });

  it('encodes the model-supplied slug into the path', async () => {
    const stub = makeApiStub(() => ({ status: 404, body: {} }));
    await getProduct(caller(stub), { slug: '../vendors/acme' });
    expect(stub.calls).toEqual(['/api/products/..%2Fvendors%2Facme']);
  });
});
