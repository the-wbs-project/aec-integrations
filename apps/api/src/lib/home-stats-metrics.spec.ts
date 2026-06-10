import { describe, expect, it } from 'vitest';

import { emitHomeStatsMetrics, type StatsMetricSink } from './home-stats-metrics';
import type { HomeStatKeyOutcome, HomeStatsResult } from './home-stats';

type Call = { metric: string; value: number; tags: string[] };

/** Records every sink call so tests can assert exact (metric, value, tags) tuples. */
function recordingSink(): StatsMetricSink & { counts: Call[]; dists: Call[] } {
  const counts: Call[] = [];
  const dists: Call[] = [];
  return {
    counts,
    dists,
    count: (metric, value, tags) => counts.push({ metric, value, tags }),
    distribution: (metric, value, tags) => dists.push({ metric, value, tags }),
  };
}

function key(
  k: HomeStatKeyOutcome['key'],
  status: HomeStatKeyOutcome['status'],
  durationMs: number,
): HomeStatKeyOutcome {
  return { key: k, status, durationMs };
}

function result(keys: HomeStatKeyOutcome[]): HomeStatsResult {
  return { keys };
}

describe('emitHomeStatsMetrics', () => {
  it('emits per-key outcome + duration for each key and a partial job rollup', () => {
    const sink = recordingSink();

    emitHomeStatsMetrics(
      sink,
      'cron',
      result([
        key('home.total_integrations', 'written', 3),
        key('home.most_integrated_product', 'skipped', 1),
        key('home.trending_products', 'failed', 7),
      ]),
      42,
    );

    // Per-key outcome counts, in order, then the job-level rollup last.
    expect(sink.counts).toEqual([
      {
        metric: 'aeci.stats.compute.key',
        value: 1,
        tags: ['trigger:cron', 'key:home.total_integrations', 'outcome:written'],
      },
      {
        metric: 'aeci.stats.compute.key',
        value: 1,
        tags: ['trigger:cron', 'key:home.most_integrated_product', 'outcome:skipped'],
      },
      {
        metric: 'aeci.stats.compute.key',
        value: 1,
        tags: ['trigger:cron', 'key:home.trending_products', 'outcome:failed'],
      },
      // one written + one failed → partial
      { metric: 'aeci.stats.compute', value: 1, tags: ['trigger:cron', 'outcome:partial'] },
    ]);

    // Per-key duration distributions (carrying each key's durationMs), then the
    // run-level duration last.
    expect(sink.dists).toEqual([
      {
        metric: 'aeci.stats.compute.key.duration_ms',
        value: 3,
        tags: ['trigger:cron', 'key:home.total_integrations'],
      },
      {
        metric: 'aeci.stats.compute.key.duration_ms',
        value: 1,
        tags: ['trigger:cron', 'key:home.most_integrated_product'],
      },
      {
        metric: 'aeci.stats.compute.key.duration_ms',
        value: 7,
        tags: ['trigger:cron', 'key:home.trending_products'],
      },
      { metric: 'aeci.stats.compute.duration_ms', value: 42, tags: ['trigger:cron'] },
    ]);
  });

  it('rolls up to success when every key written/skipped cleanly', () => {
    const sink = recordingSink();
    emitHomeStatsMetrics(
      sink,
      'cron',
      result([
        key('home.total_integrations', 'written', 2),
        key('home.most_active_category', 'skipped', 0),
      ]),
      5,
    );
    expect(sink.counts.at(-1)).toEqual({
      metric: 'aeci.stats.compute',
      value: 1,
      tags: ['trigger:cron', 'outcome:success'],
    });
  });

  it('rolls up to failed when nothing wrote and at least one key failed', () => {
    const sink = recordingSink();
    emitHomeStatsMetrics(
      sink,
      'cron',
      result([
        key('home.total_integrations', 'failed', 1),
        key('home.most_active_category', 'skipped', 0),
      ]),
      9,
    );
    expect(sink.counts.at(-1)).toEqual({
      metric: 'aeci.stats.compute',
      value: 1,
      tags: ['trigger:cron', 'outcome:failed'],
    });
  });

  it('still emits the job-level rollup + duration when there are no keys (outcome success)', () => {
    const sink = recordingSink();
    emitHomeStatsMetrics(sink, 'cron', result([]), 4);
    expect(sink.counts).toEqual([
      { metric: 'aeci.stats.compute', value: 1, tags: ['trigger:cron', 'outcome:success'] },
    ]);
    expect(sink.dists).toEqual([
      { metric: 'aeci.stats.compute.duration_ms', value: 4, tags: ['trigger:cron'] },
    ]);
  });
});
