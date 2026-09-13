/**
 * Unit tests for the PostHog HogQL read (AECI-660).
 *
 * The theme: this transport must NEVER throw and must never invent a number.
 * The digest is a daily operator email — an observability outage has to degrade
 * it, not take it down, and a fabricated `0` beside a real server-side count
 * would read as a finding rather than as missing data.
 */

import { describe, expect, it, vi } from 'vitest';

import { fetchPosthogBrowserStarts, fetchPosthogTraffic, publicHostOf } from './posthog-query';

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

describe('fetchPosthogBrowserStarts', () => {
  const ADMINS = ['49dd03ee-1111-4222-8333-444455556666'];

  /** The query string the call actually sent. */
  function sentQuery(fetchImpl: { mock: { calls: unknown[][] } }): string {
    const init = fetchImpl.mock.calls[0][1] as { body: string };
    return (JSON.parse(init.body) as { query: { query: string } }).query.query;
  }

  it('returns all three counts', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[21, 13, 7]] }));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({
      ok: true,
      starts: { startsAll: 21, starts: 13, searchReferred: 7 },
    });
  });

  it('emits the whole query verbatim — event, window, host, both exclusions', async () => {
    // Pinned in full rather than by substring. Every clause here is load-bearing
    // and three of them fail SILENTLY if they drift: a dropped `$host` folds
    // three tiers into one figure, a dropped operator subquery inflates the
    // number by roughly a third, and a `countIf` predicate that diverges from its
    // sibling makes `search_referred` describe a population `starts` does not.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1, 0]] }));
    await fetchPosthogBrowserStarts(CREDS, WINDOW, ADMINS, fetchImpl as unknown as typeof fetch);
    expect(sentQuery(fetchImpl)).toBe(
      [
        'SELECT count() AS starts_all,',
        "       countIf(properties.$virt_traffic_type = 'Regular' AND person_id NOT IN " +
          "(SELECT person_id FROM events WHERE event = '$identify' AND distinct_id IN " +
          "('49dd03ee-1111-4222-8333-444455556666') AND timestamp >= " +
          "toDateTime('2026-07-24T00:00:00.000Z') AND timestamp < " +
          "toDateTime('2026-08-24T00:00:00.000Z'))) AS starts,",
        "       countIf(properties.$virt_traffic_type = 'Regular' AND person_id NOT IN " +
          "(SELECT person_id FROM events WHERE event = '$identify' AND distinct_id IN " +
          "('49dd03ee-1111-4222-8333-444455556666') AND timestamp >= " +
          "toDateTime('2026-07-24T00:00:00.000Z') AND timestamp < " +
          "toDateTime('2026-08-24T00:00:00.000Z')) AND " +
          'notEmpty(properties.$search_engine)) AS starts_search_referred',
        'FROM events',
        "WHERE event = 'app_started'",
        "  AND timestamp >= toDateTime('2026-08-23T00:00:00.000Z')",
        "  AND timestamp < toDateTime('2026-08-24T00:00:00.000Z')",
        "  AND properties.$host = 'www.aecintegrations.com'",
      ].join('\n'),
    );
  });

  it('omits the operator subquery entirely when there are no admins', async () => {
    // `IN ()` is a syntax error, and an empty-set NOT IN that matched nothing
    // would be worse: an unfiltered number labelled "operator excluded".
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[4, 4, 0]] }));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      [],
      fetchImpl as unknown as typeof fetch,
    );
    const query = sentQuery(fetchImpl);
    expect(query).not.toContain('person_id NOT IN');
    expect(query).not.toContain('IN ()');
    expect(query).toContain("countIf(properties.$virt_traffic_type = 'Regular') AS starts");
    expect(outcome).toEqual({
      ok: true,
      starts: { startsAll: 4, starts: 4, searchReferred: 0 },
    });
  });

  it('looks the operator up over a 30-day trailing window, not just the reported day', async () => {
    // The Tier 2 beacon fires at bootstrap and `$identify` merges later in the
    // same session, so `$is_identified` is FALSE on the operator's own
    // `app_started` rows. Only a retro-join finds them.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 0, 0]] }));
    await fetchPosthogBrowserStarts(CREDS, WINDOW, ADMINS, fetchImpl as unknown as typeof fetch);
    expect(sentQuery(fetchImpl)).toContain("toDateTime('2026-07-24T00:00:00.000Z')");
  });

  it('counts starts, never people', async () => {
    // `persistence: 'memory'` mints a fresh distinct id per page load, so
    // `uniq(person_id)` over this event is persons-equals-starts noise.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1, 1]] }));
    await fetchPosthogBrowserStarts(CREDS, WINDOW, ADMINS, fetchImpl as unknown as typeof fetch);
    expect(sentQuery(fetchImpl)).not.toContain('uniq(person_id)');
  });

  it('is exactly one request', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1, 1]] }));
    await fetchPosthogBrowserStarts(CREDS, WINDOW, ADMINS, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('degrades to unavailable on a non-2xx, exactly as the $pageview join does', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('nope', { status: 503 }));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_http_503' });
  });

  it('releases the body of a non-2xx rather than holding the connection', async () => {
    // AECI-666: an unread body holds one of ~6 connections until the runtime
    // cancels it, and a cancelled fetch returns a promise that never settles.
    const response = new Response('nope', { status: 500 });
    const fetchImpl = vi.fn().mockResolvedValue(response);
    await fetchPosthogBrowserStarts(CREDS, WINDOW, ADMINS, fetchImpl as unknown as typeof fetch);
    expect(response.bodyUsed).toBe(true);
  });

  it('fails open on a network error instead of throwing', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('connection reset'));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.reason).toContain('posthog_fetch_failed');
  });

  it('rejects a malformed row rather than inventing a number', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[21, 'n/a', null]] }));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_non_numeric_result' });
  });

  it('rejects a row with too few columns', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[21, 13]] }));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_unexpected_row_shape' });
  });

  it('reports a real zero as a real zero', async () => {
    // Zero starts on a day with arrivals is a FINDING — a broken bundle or a
    // blocked collector — so it must survive the transport as a value.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[0, 0, 0]] }));
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({
      ok: true,
      starts: { startsAll: 0, starts: 0, searchReferred: 0 },
    });
  });

  it('skips without querying when credentials are absent', async () => {
    const fetchImpl = vi.fn();
    const outcome = await fetchPosthogBrowserStarts(
      { apiKey: undefined, projectId: '354071' },
      WINDOW,
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_credentials_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('skips when the host is empty rather than querying every tier at once', async () => {
    const fetchImpl = vi.fn();
    const outcome = await fetchPosthogBrowserStarts(
      CREDS,
      { ...WINDOW, host: '' },
      ADMINS,
      fetchImpl as unknown as typeof fetch,
    );
    expect(outcome).toEqual({ ok: false, reason: 'posthog_host_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('strips quotes from an admin id before interpolating it', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ results: [[1, 1, 1]] }));
    await fetchPosthogBrowserStarts(
      CREDS,
      WINDOW,
      ["evil') OR 1=1 --"],
      fetchImpl as unknown as typeof fetch,
    );
    expect(sentQuery(fetchImpl)).toContain("distinct_id IN ('evil) OR 1=1 --')");
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
