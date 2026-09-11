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

  // AECI-868 — the coverage tripwire reports a RATIO, so its one line plus its
  // note carry the numbers and its `count` is 1 rather than a row count. The
  // renderer is generic, so this asserts the shape a reader will actually see
  // (and that "…and 0 more" never appears for a one-line finding).
  it('renders the arrival-coverage finding with its note and no overflow line', () => {
    const digest = buildDataQualityDigest(
      [
        result({
          id: 'arrival_cf_coverage',
          label: 'Full-document arrivals missing their network metadata (`cf_asn`)',
          severity: 'error',
          count: 1,
          sample: ['2633 of 2633 full-document arrivals have a NULL cf_asn — coverage 0.0%'],
          note: '0/2633 arrivals carry cf_asn (0.0%, floor 95.0%)',
        }),
      ],
      OPTS,
    );
    expect(digest.subject).toBe('AECi data quality (production) — 1 issue(s) across 1 check(s)');
    expect(digest.text).toContain('floor 95.0%');
    expect(digest.text).toContain('• 2633 of 2633 full-document arrivals have a NULL cf_asn');
    expect(digest.text).not.toContain('…and');
    expect(digest.html).toContain('floor 95.0%');
  });

  it('renders a passing arrival-coverage check in the Clean section, note and all', () => {
    const digest = buildDataQualityDigest(
      [
        result({
          id: 'arrival_cf_coverage',
          label: 'Arrival coverage',
          severity: 'error',
          note: '1458/1458 arrivals carry cf_asn (100.0%, floor 95.0%)',
        }),
      ],
      OPTS,
    );
    expect(digest.subject).toBe('AECi data quality (production) — all clear');
    expect(digest.text).toContain('✓ Arrival coverage');
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
