import { describe, expect, it } from 'vitest';

import { getVendor } from './get-vendor';
import { makeApiStub } from '../test/api-stub';

function caller(stub: ReturnType<typeof makeApiStub>) {
  return { API: stub.fetcher as unknown as Fetcher };
}

describe('get_vendor', () => {
  it('calls the public vendor endpoint and returns its payload', async () => {
    const stub = makeApiStub(() => ({
      status: 200,
      body: { slug: 'acme', company_name: 'Acme Software' },
    }));
    const out = await getVendor(caller(stub), { slug: 'acme' });
    expect(stub.calls).toEqual(['/api/vendors/acme']);
    expect(out).toEqual({
      found: true,
      vendor: { slug: 'acme', company_name: 'Acme Software' },
    });
  });

  it('reports a miss without throwing, and releases the body (AECI-666)', async () => {
    const stub = makeApiStub(() => ({ status: 404, body: {} }));
    const out = await getVendor(caller(stub), { slug: 'ghost' });
    expect(out).toEqual({ found: false, slug: 'ghost', message: 'Not found.' });
    expect(stub.cancelled()).toBe(true);
  });

  it('releases the body on a 5xx too', async () => {
    const stub = makeApiStub(() => ({ status: 503, body: {} }));
    const out = await getVendor(caller(stub), { slug: 'acme' });
    expect(out).toMatchObject({ found: false });
    expect(stub.cancelled()).toBe(true);
  });
});
