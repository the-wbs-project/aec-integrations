import { describe, expect, it } from 'vitest';

import { badRequest, json, notFound } from './http';

describe('json', () => {
  it('serializes BigInt values as decimal strings', async () => {
    // Guards: BigInt is not natively JSON-serializable; the replacer must coerce to string.
    const response = json({ id: 12345678901234567890n });
    expect(await response.text()).toBe('{"id":"12345678901234567890"}');
  });

  it('sets Content-Type to application/json; charset=utf-8', () => {
    // Guards: clients rely on this header to parse the body.
    const response = json({ ok: true });
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  });

  it('preserves caller-supplied status code', () => {
    // Guards: json() must not override status; badRequest/notFound depend on this passthrough.
    expect(json({}, { status: 201 }).status).toBe(201);
    expect(badRequest('bad').status).toBe(400);
    expect(notFound().status).toBe(404);
  });
});

describe('notFound', () => {
  it("uses 'Route not found' when called with no argument", async () => {
    // Guards: default message is the documented unmatched-route response.
    const response = notFound();
    expect(await response.json()).toEqual({ error: 'Route not found' });
  });
});
