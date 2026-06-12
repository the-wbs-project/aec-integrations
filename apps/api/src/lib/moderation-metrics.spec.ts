import { describe, expect, it } from 'vitest';

import {
  emitModerationQueueMetrics,
  oldestPendingAgeHours,
  type ModerationMetricSink,
} from './moderation-metrics';

type Call = { metric: string; value: number; tags: string[] };

/** Records every gauge call so tests can assert exact (metric, value, tags) tuples. */
function recordingSink(): ModerationMetricSink & { gauges: Call[] } {
  const gauges: Call[] = [];
  return {
    gauges,
    gauge: (metric, value, tags) => gauges.push({ metric, value, tags }),
  };
}

describe('emitModerationQueueMetrics', () => {
  it('emits depth + oldest-age gauges (untagged) for a non-empty queue', () => {
    const sink = recordingSink();
    emitModerationQueueMetrics(sink, { pendingCount: 5, oldestPendingAgeHours: 30 });
    expect(sink.gauges).toEqual([
      { metric: 'aeci.moderation.queue_depth', value: 5, tags: [] },
      { metric: 'aeci.moderation.queue_oldest_age_hours', value: 30, tags: [] },
    ]);
  });

  it('emits depth 0 / age 0 for an empty queue (the series always reports → liveness)', () => {
    const sink = recordingSink();
    emitModerationQueueMetrics(sink, { pendingCount: 0, oldestPendingAgeHours: 0 });
    expect(sink.gauges).toEqual([
      { metric: 'aeci.moderation.queue_depth', value: 0, tags: [] },
      { metric: 'aeci.moderation.queue_oldest_age_hours', value: 0, tags: [] },
    ]);
  });
});

describe('oldestPendingAgeHours', () => {
  const NOW = Date.parse('2026-06-12T06:00:00.000Z');

  it('returns 0 for an empty queue regardless of timestamp', () => {
    expect(oldestPendingAgeHours(0, null, NOW)).toBe(0);
    expect(oldestPendingAgeHours(0, Date.parse('2026-06-10T06:00:00.000Z'), NOW)).toBe(0);
  });

  it('returns 0 when there is no oldest timestamp (defensive)', () => {
    expect(oldestPendingAgeHours(3, null, NOW)).toBe(0);
  });

  it('computes the elapsed hours for the oldest pending review', () => {
    // 36h earlier → 36.
    expect(oldestPendingAgeHours(1, Date.parse('2026-06-10T18:00:00.000Z'), NOW)).toBe(36);
  });

  it('never returns a negative age (clock skew → future created_at)', () => {
    expect(oldestPendingAgeHours(1, Date.parse('2026-06-12T07:00:00.000Z'), NOW)).toBe(0);
  });
});
