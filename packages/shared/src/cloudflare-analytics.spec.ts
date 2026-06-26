import { describe, expect, it, vi } from 'vitest';

import {
  fetchWafFirewallEvents,
  WAF_EVENTS_GROUP_LIMIT,
  type WafEventGroup,
} from './cloudflare-analytics';

const CREDS = { apiToken: 'cf-analytics-token', zoneId: 'zone-1' };
const WINDOW = {
  startIso: '2026-06-26T10:00:00.000Z',
  endIso: '2026-06-26T11:00:00.000Z',
  host: 'demo.aecintegrations.com',
};
const GRAPHQL_URL = 'https://api.cloudflare.com/client/v4/graphql';

function group(count: number, action: string, source: string, ruleId: string, host = WINDOW.host) {
  return { count, dimensions: { action, source, ruleId, clientRequestHTTPHost: host } };
}

function ddData(groups: ReturnType<typeof group>[]): Response {
  return new Response(
    JSON.stringify({
      data: { viewer: { zones: [{ firewallEventsAdaptiveGroups: groups }] } },
    }),
    { status: 200 },
  );
}

describe('fetchWafFirewallEvents', () => {
  it('POSTs the GraphQL endpoint with the bearer token + zoneTag/window/host variables', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ddData([group(7, 'block', 'ratelimit', 'rule-a')]));

    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );

    expect(outcome).toEqual({
      ok: true,
      truncated: false,
      groups: [
        {
          count: 7,
          action: 'block',
          source: 'ratelimit',
          ruleId: 'rule-a',
          host: 'demo.aecintegrations.com',
        } satisfies WafEventGroup,
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(GRAPHQL_URL);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(
      'Bearer cf-analytics-token',
    );
    const sent = JSON.parse(init.body as string);
    expect(sent.query).toContain('firewallEventsAdaptiveGroups');
    expect(sent.variables).toEqual({
      zoneTag: 'zone-1',
      start: WINDOW.startIso,
      end: WINDOW.endIso,
      host: WINDOW.host,
    });
  });

  it('flattens every returned group', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        ddData([
          group(12, 'block', 'ratelimit', 'rule-a'),
          group(3, 'managed_challenge', 'firewallcustom', 'scraper'),
        ]),
      );

    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );

    expect(outcome.ok).toBe(true);
    expect((outcome as { groups: WafEventGroup[] }).groups).toHaveLength(2);
  });

  it('returns ok with an empty group list when the zone reported no events', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ddData([]));
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );
    expect(outcome).toEqual({ ok: true, truncated: false, groups: [] });
  });

  it('sets truncated when the group count hits the limit', async () => {
    const many = Array.from({ length: WAF_EVENTS_GROUP_LIMIT }, (_, i) =>
      group(1, 'block', 'ratelimit', `rule-${i}`),
    );
    const fetchMock = vi.fn().mockResolvedValue(ddData(many));
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );
    expect(outcome.ok).toBe(true);
    expect((outcome as { truncated: boolean }).truncated).toBe(true);
  });

  it('returns cf_credentials_missing without calling fetch when the token is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      { apiToken: undefined, zoneId: 'zone-1' },
      WINDOW,
    );
    expect(outcome).toEqual({ ok: false, message: 'cf_credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns cf_credentials_missing without calling fetch when the zone is absent', async () => {
    const fetchMock = vi.fn();
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      { apiToken: 'cf-analytics-token', zoneId: undefined },
      WINDOW,
    );
    expect(outcome).toEqual({ ok: false, message: 'cf_credentials_missing' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a GraphQL errors[] body even on a 200 response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ message: 'unauthorized' }, { message: 'nope' }],
        }),
        { status: 200 },
      ),
    );
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );
    expect(outcome).toEqual({ ok: false, message: 'unauthorized; nope' });
  });

  it('surfaces the error body message on a non-2xx response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ errors: [{ message: 'bad token' }] }), { status: 403 }),
      );
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );
    expect(outcome).toEqual({ ok: false, message: 'bad token' });
  });

  it('falls back to statusText when a non-2xx body is not JSON', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 503, statusText: 'Service Unavailable' }));
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );
    expect(outcome).toEqual({ ok: false, message: 'Service Unavailable' });
  });

  it('never throws on a network error — returns a structured outcome', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    const outcome = await fetchWafFirewallEvents(
      fetchMock as unknown as typeof fetch,
      CREDS,
      WINDOW,
    );
    expect(outcome).toEqual({ ok: false, message: 'network down' });
  });
});
