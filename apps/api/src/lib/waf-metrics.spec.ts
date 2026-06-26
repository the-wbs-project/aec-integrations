import { describe, expect, it } from 'vitest';

import type { WafEventGroup } from '@aeci/shared/cloudflare-analytics';

import { emitWafEventMetrics, previousHourWindow, type WafMetricSink } from './waf-metrics';

type Call = { metric: string; value: number; tags: string[] };

/** Records every count call so tests can assert exact (metric, value, tags) tuples. */
function recordingSink(): WafMetricSink & { counts: Call[] } {
  const counts: Call[] = [];
  return {
    counts,
    count: (metric, value, tags) => counts.push({ metric, value, tags }),
  };
}

function group(over: Partial<WafEventGroup> = {}): WafEventGroup {
  return {
    count: 1,
    action: 'block',
    source: 'ratelimit',
    ruleId: 'rule-a',
    host: 'demo.aecintegrations.com',
    ...over,
  };
}

describe('emitWafEventMetrics', () => {
  it('emits one count per mitigation group with rule/action/host/source tags and the event count value', () => {
    const sink = recordingSink();
    emitWafEventMetrics(sink, [
      group({ count: 9, action: 'block', source: 'ratelimit', ruleId: 'rule-a' }),
      group({ count: 4, action: 'managed_challenge', source: 'firewallcustom', ruleId: 'scraper' }),
    ]);
    expect(sink.counts).toEqual([
      {
        metric: 'aeci.waf.ratelimit.blocked',
        value: 9,
        tags: ['rule:rule-a', 'action:block', 'host:demo.aecintegrations.com', 'source:ratelimit'],
      },
      {
        metric: 'aeci.waf.ratelimit.blocked',
        value: 4,
        tags: [
          'rule:scraper',
          'action:managed_challenge',
          'host:demo.aecintegrations.com',
          'source:firewallcustom',
        ],
      },
    ]);
  });

  it('drops non-mitigation actions (allow / log / skip)', () => {
    const sink = recordingSink();
    emitWafEventMetrics(sink, [
      group({ action: 'allow' }),
      group({ action: 'log' }),
      group({ action: 'skip' }),
      group({ action: 'block', count: 2 }),
    ]);
    expect(sink.counts).toEqual([
      {
        metric: 'aeci.waf.ratelimit.blocked',
        value: 2,
        tags: ['rule:rule-a', 'action:block', 'host:demo.aecintegrations.com', 'source:ratelimit'],
      },
    ]);
  });

  it('matches mitigation actions case-insensitively', () => {
    const sink = recordingSink();
    emitWafEventMetrics(sink, [group({ action: 'JS_Challenge', count: 5 })]);
    expect(sink.counts).toHaveLength(1);
    expect(sink.counts[0]!.value).toBe(5);
  });

  it('emits nothing for an empty group list (a quiet hour is a sparse count series)', () => {
    const sink = recordingSink();
    emitWafEventMetrics(sink, []);
    expect(sink.counts).toEqual([]);
  });
});

describe('previousHourWindow', () => {
  it('returns the prior clock hour as a half-open ISO window regardless of fire-time minutes', () => {
    expect(previousHourWindow(new Date('2026-06-26T11:37:42.123Z'))).toEqual({
      startIso: '2026-06-26T10:00:00.000Z',
      endIso: '2026-06-26T11:00:00.000Z',
    });
  });

  it('handles a fire exactly on the hour boundary', () => {
    expect(previousHourWindow(new Date('2026-06-26T11:00:00.000Z'))).toEqual({
      startIso: '2026-06-26T10:00:00.000Z',
      endIso: '2026-06-26T11:00:00.000Z',
    });
  });

  it('crosses the midnight (and day) boundary correctly', () => {
    expect(previousHourWindow(new Date('2026-06-26T00:12:00.000Z'))).toEqual({
      startIso: '2026-06-25T23:00:00.000Z',
      endIso: '2026-06-26T00:00:00.000Z',
    });
  });
});
