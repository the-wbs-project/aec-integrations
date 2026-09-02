/**
 * Unit tests for the PostHog HogQL read (AECI-660).
 *
 * The theme: this transport must NEVER throw and must never invent a number.
 * The digest is a daily operator email — an observability outage has to degrade
 * it, not take it down, and a fabricated `0` beside a real server-side count
 * would read as a finding rather than as missing data.
 */

import { describe, expect, it, vi } from 'vitest';

import { fetchPosthogTraffic, publicHostOf } from './posthog-query';

const CREDS = { apiKey: 'phx_test', projectId: '354071' };
const WINDOW = {
  startIso: '2026-08-23T00:00:00.000Z',
  endIso: '2026-08-24T00:00:00.000Z',
  host: 'www.aecintegrations.com',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchPosthogTraffic', () => {
  it('returns the pageview and person counts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[48, 3]] }));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: true, traffic: { pageviews: 48, people: 3 } });
  });

  it('scopes the query to the window and host', async () => {
    // Every tier shares one PostHog project today, so an unscoped read would
    // fold demo and staging traffic into the production figure.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[5, 1]] }));
    await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://us.posthog.com/api/projects/354071/query/');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer phx_test');
    const sent = JSON.parse(init.body as string).query.query as string;
    expect(sent).toContain("properties.$host = 'www.aecintegrations.com'");
    expect(sent).toContain("timestamp >= toDateTime('2026-08-23T00:00:00.000Z')");
    expect(sent).toContain("timestamp < toDateTime('2026-08-24T00:00:00.000Z')");
    // People, not distinct ids: one person owns many distinct ids.
    expect(sent).toContain('uniq(person_id)');
  });

  it('skips without querying when credentials are absent', async () => {
    const fetchImpl = vi.fn();
    const outcome = await fetchPosthogTraffic(
      { apiKey: undefined, projectId: '354071' },
      WINDOW,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_credentials_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips when the host is empty rather than querying every tier at once', async () => {
    const fetchImpl = vi.fn();
    const outcome = await fetchPosthogTraffic(
      CREDS,
      { ...WINDOW, host: '' },
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_host_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails open on a non-2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: false, reason: 'posthog_http_401' });
  });

  it('fails open on a network error instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection reset'));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('posthog_fetch_failed');
  });

  it('fails open on an unparseable body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>502</html>', { status: 200 }));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('posthog_body_unparseable');
  });

  it('does NOT coerce an empty result set to zero', async () => {
    // `count()` over an empty set still returns one row of zeros, so an empty
    // `results` array means the response shape changed — not that traffic was 0.
    // Reporting 0 here would put a fabricated number next to a real one.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: false, reason: 'posthog_empty_result' });
  });

  it('reports a real zero as a real zero', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[0, 0]] }));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: true, traffic: { pageviews: 0, people: 0 } });
  });

  it('rejects a row that is not two numbers', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [['n/a', null]] }));
    const outcome = await fetchPosthogTraffic(CREDS, WINDOW, fetchImpl as unknown as typeof fetch);
    expect(outcome).toEqual({ ok: false, reason: 'posthog_non_numeric_result' });
  });

  it('honours a custom API host without a trailing slash', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1]] }));
    await fetchPosthogTraffic(
      { ...CREDS, host: 'https://eu.posthog.com/' },
      WINDOW,
      fetchImpl as unknown as typeof fetch,
    );
    expect(fetchImpl.mock.calls[0][0]).toBe('https://eu.posthog.com/api/projects/354071/query/');
  });

  it('strips quotes from interpolated values', async () => {
    // Defence in depth: every value is server-derived today, but "no caller ever
    // passes user input" is a convention, and conventions erode.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1]] }));
    await fetchPosthogTraffic(
      CREDS,
      { ...WINDOW, host: "evil' OR 1=1 --" },
      fetchImpl as unknown as typeof fetch,
    );
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body as string).query.query as string;
    expect(sent).toContain("properties.$host = 'evil OR 1=1 --'");
  });
});

describe('publicHostOf', () => {
  it('extracts a lower-cased hostname', () => {
    expect(publicHostOf('https://WWW.aecintegrations.com')).toBe('www.aecintegrations.com');
  });

  it('returns null for unset or malformed values so the caller skips', () => {
    expect(publicHostOf(undefined)).toBeNull();
    expect(publicHostOf('')).toBeNull();
    expect(publicHostOf('not a url')).toBeNull();
  });
});
