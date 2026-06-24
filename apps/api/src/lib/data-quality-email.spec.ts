/**
 * Unit tests for the data-quality email digest builder (`data-quality-email.ts`,
 * AECI-241). Pure function — asserts subject/summary/section rendering for a clean
 * run, a run with issues (incl. the sample overflow), a check error, and a skip.
 */

import { describe, expect, it } from 'vitest';

import type { DataQualityCheckResult } from './data-quality';
import { buildDataQualityDigest } from './data-quality-email';

const OPTS = { env: 'production', generatedAt: new Date('2026-06-24T04:30:00.000Z') };

function result(over: Partial<DataQualityCheckResult> & { id: string }): DataQualityCheckResult {
  return {
    label: over.id,
    severity: 'warn',
    count: 0,
    sample: [],
    ...over,
  };
}

describe('buildDataQualityDigest', () => {
  it('renders an all-clear subject when nothing is found', () => {
    const digest = buildDataQualityDigest(
      [result({ id: 'a' }), result({ id: 'b', skipped: true, note: 'no creds' })],
      OPTS,
    );
    expect(digest.subject).toBe('AECi data quality (production) — all clear');
    expect(digest.text).toContain('Environment: production');
    expect(digest.text).toContain('Skipped');
    expect(digest.html).toContain('<h2>');
  });

  it('counts issues across checks in the subject and lists samples', () => {
    const digest = buildDataQualityDigest(
      [
        result({ id: 'orphans', label: 'Orphan products', count: 2, sample: ['p1', 'p2'] }),
        result({
          id: 'broken',
          label: 'Broken refs',
          severity: 'error',
          count: 1,
          sample: ['i1'],
        }),
        result({ id: 'clean', label: 'Clean check' }),
      ],
      OPTS,
    );
    expect(digest.subject).toBe('AECi data quality (production) — 3 issue(s) across 2 check(s)');
    // Error severity sorts first.
    expect(digest.text.indexOf('Broken refs')).toBeLessThan(digest.text.indexOf('Orphan products'));
    expect(digest.text).toContain('• p1');
    expect(digest.text).toContain('Clean check');
  });

  it('notes the sample overflow when count exceeds the shown sample', () => {
    const digest = buildDataQualityDigest(
      [result({ id: 'dup', label: 'Dups', count: 12, sample: ['x', 'y', 'z'] })],
      OPTS,
    );
    expect(digest.text).toContain('…and 9 more');
  });

  it('surfaces a check error in the subject and a dedicated section', () => {
    const digest = buildDataQualityDigest(
      [result({ id: 'drift', label: 'Drift', severity: 'error', error: 'algolia unreachable' })],
      OPTS,
    );
    expect(digest.subject).toContain('1 check error(s)');
    expect(digest.text).toContain('Check errors');
    expect(digest.text).toContain('algolia unreachable');
  });

  it('html-escapes sample content', () => {
    const digest = buildDataQualityDigest(
      [result({ id: 'x', label: 'X', count: 1, sample: ['<script>'] })],
      OPTS,
    );
    expect(digest.html).toContain('&lt;script&gt;');
    expect(digest.html).not.toContain('<script>');
  });
});
