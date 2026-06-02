import { describe, expect, it } from 'vitest';

import { json, noContent } from './http';

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
    // Guards: json() must not override status — error/operational responses
    // (e.g. the canonical 4xx/5xx envelope) depend on this passthrough.
    expect(json({}, { status: 201 }).status).toBe(201);
    expect(json({ error: {} }, { status: 400 }).status).toBe(400);
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

describe('noContent', () => {
  it('returns a 204 response with an empty body', async () => {
    // Guards: AECI-55 capture endpoint must respond 204 with no body — a
    // body or non-204 status breaks the fire-and-forget contract.
    const response = noContent();
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
  });

  it("defaults Cache-Control to 'private, no-store'", () => {
    // Guards: 204 responses inherit the same no-cache default as json().
    expect(noContent().headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('preserves a caller-supplied Cache-Control header', () => {
    // Guards: parity with json() — future callers can override if needed.
    const response = noContent({ headers: { 'Cache-Control': 'public, max-age=0' } });
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=0');
  });

  it('does not set a Content-Type header (body-less response)', () => {
    // Guards: 204 has no body, so a Content-Type would be misleading.
    expect(noContent().headers.get('Content-Type')).toBeNull();
  });
});
