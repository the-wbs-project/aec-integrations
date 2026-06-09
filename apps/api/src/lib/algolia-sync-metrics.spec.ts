import { describe, expect, it } from 'vitest';

import { emitAlgoliaSyncMetrics, type SyncMetricSink } from './algolia-sync-metrics';
import type { IndexEntityResult } from './algolia-sync';

type CountCall = { metric: string; value: number; tags: string[] };
type DistCall = { metric: string; value: number; tags: string[] };

/** Records every sink call so tests can assert exact (metric, value, tags) tuples. */
function recordingSink(): SyncMetricSink & { counts: CountCall[]; dists: DistCall[] } {
  const counts: CountCall[] = [];
  const dists: DistCall[] = [];
  return {
    counts,
    dists,
    count: (metric, value, tags) => counts.push({ metric, value, tags }),
    distribution: (metric, value, tags) => dists.push({ metric, value, tags }),
  };
}

function result(
  overrides: Partial<IndexEntityResult> & Pick<IndexEntityResult, 'entity'>,
): IndexEntityResult {
  return {
    indexName: `preview_${overrides.entity}`,
    saved: 0,
    deleted: 0,
    transformErrors: 0,
    ok: true,
    ...overrides,
  };
}

describe('emitAlgoliaSyncMetrics', () => {
  it('emits outcome + records counts per entity and a single run duration', () => {
    const sink = recordingSink();

    emitAlgoliaSyncMetrics(
      sink,
      'cron',
      [
        result({ entity: 'products', saved: 12, deleted: 3, ok: true }),
        result({ entity: 'vendors', saved: 0, deleted: 0, ok: false, error: 'boom' }),
      ],
      8421,
    );

    // 3 counts per entity (outcome + saved + deleted) × 2 entities.
    expect(sink.counts).toEqual([
      {
        metric: 'aeci.algolia.sync',
        value: 1,
        tags: ['trigger:cron', 'entity:products', 'outcome:ok'],
      },
      {
        metric: 'aeci.algolia.sync.records',
        value: 12,
        tags: ['trigger:cron', 'entity:products', 'op:saved'],
      },
      {
        metric: 'aeci.algolia.sync.records',
        value: 3,
        tags: ['trigger:cron', 'entity:products', 'op:deleted'],
      },
      {
        metric: 'aeci.algolia.sync',
        value: 1,
        tags: ['trigger:cron', 'entity:vendors', 'outcome:failed'],
      },
      {
        metric: 'aeci.algolia.sync.records',
        value: 0,
        tags: ['trigger:cron', 'entity:vendors', 'op:saved'],
      },
      {
        metric: 'aeci.algolia.sync.records',
        value: 0,
        tags: ['trigger:cron', 'entity:vendors', 'op:deleted'],
      },
    ]);

    // Exactly one run-level duration distribution.
    expect(sink.dists).toEqual([
      { metric: 'aeci.algolia.sync.duration_ms', value: 8421, tags: ['trigger:cron'] },
    ]);
  });

  it('propagates the promote trigger and still emits duration for an empty result set', () => {
    const sink = recordingSink();

    emitAlgoliaSyncMetrics(
      sink,
      'promote',
      [result({ entity: 'integrations', saved: 1, deleted: 0, ok: true })],
      42,
    );

    expect(sink.counts.map((c) => c.tags[0])).toEqual([
      'trigger:promote',
      'trigger:promote',
      'trigger:promote',
    ]);
    expect(sink.dists).toEqual([
      { metric: 'aeci.algolia.sync.duration_ms', value: 42, tags: ['trigger:promote'] },
    ]);
  });

  it('emits only the duration distribution when there are no entities', () => {
    const sink = recordingSink();
    emitAlgoliaSyncMetrics(sink, 'cron', [], 5);
    expect(sink.counts).toEqual([]);
    expect(sink.dists).toEqual([
      { metric: 'aeci.algolia.sync.duration_ms', value: 5, tags: ['trigger:cron'] },
    ]);
  });
});
