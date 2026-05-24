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

  it("defaults Cache-Control to 'private, no-store'", () => {
    // Guards: CODE_REVIEW_CHECKLIST.md requires non-cacheable API responses to
    // explicitly opt out of caching. Without this default, /api/health and any
    // future error/operational endpoint can be cached at the edge or by clients.
    const response = json({ ok: true });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('preserves a caller-supplied Cache-Control header (override path)', () => {
    // Guards: cacheable endpoints (e.g. integrations index) must be able to set
    // their own Cache-Control without json() clobbering it back to no-store.
    const response = json({ items: [] }, { headers: { 'Cache-Control': 'public, max-age=60' } });
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
  });
});

describe('badRequest / notFound default caching', () => {
  it("badRequest carries Cache-Control: 'private, no-store'", () => {
    // Guards: error responses must never be cached — they can pin a stale
    // failure for every subsequent visitor on the same URL.
    expect(badRequest('bad').headers.get('Cache-Control')).toBe('private, no-store');
  });

  it("notFound carries Cache-Control: 'private, no-store'", () => {
    expect(notFound().headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('notFound', () => {
  it("uses 'Route not found' when called with no argument", async () => {
    // Guards: default message is the documented unmatched-route response.
    const response = notFound();
    expect(await response.json()).toEqual({ error: 'Route not found' });
  });
});
