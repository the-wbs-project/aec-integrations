// AECI-1876: the pure half of the e2e axe sweep. Vitest, not Playwright (`*.unit.spec.ts`).
import { describe, expect, it } from 'vitest';

import {
  applyKnownFailures,
  axeSweepEnabled,
  isGateRule,
  isHydrationError,
  parseScanRecord,
  partitionViolations,
  summarizeAxe,
  type AxeFinding,
  type AxeScanRecord,
} from './axe-summary';

const violation = (id: string, tags: string[], nodes = 1, impact = 'serious') => ({
  id,
  impact,
  tags,
  help: `${id} help`,
  helpUrl: `https://example.test/${id}`,
  nodes: Array.from({ length: nodes }, (_, i) => ({
    target: [`#n${i}`],
    failureSummary: 'Fix   it\n now',
  })),
});

const finding = (id: string, over: Partial<AxeFinding> = {}): AxeFinding => ({
  id,
  impact: 'serious',
  help: `${id} help`,
  helpUrl: `https://example.test/${id}`,
  nodes: 1,
  targets: ['#a'],
  ...over,
});

describe('the flag', () => {
  it('is on only for the exact value 1', () => {
    expect(axeSweepEnabled({ AECI_E2E_AXE: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      expect(axeSweepEnabled({ AECI_E2E_AXE: v })).toBe(false);
    }
  });
});

describe('the gate and report split', () => {
  it('gates the four PR tags and nothing else', () => {
    for (const tag of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']) {
      expect(isGateRule([tag, 'cat.color'])).toBe(true);
    }
    for (const tags of [['wcag22aa'], ['best-practice'], ['wcag2aaa'], []]) {
      expect(isGateRule(tags)).toBe(false);
    }
  });

  it('never gates an experimental rule, even with a WCAG tag', () => {
    expect(isGateRule(['wcag2aa', 'experimental'])).toBe(false);
  });

  it('splits one run, keeps five selectors and a short summary', () => {
    const { gate, report } = partitionViolations([
      violation('color-contrast', ['wcag2aa'], 7),
      violation('region', ['best-practice'], 1, 'moderate'),
      violation('target-size', ['wcag22aa'], 0),
    ]);
    expect(gate.map((f) => f.id)).toEqual(['color-contrast']);
    expect(gate[0].nodes).toBe(7);
    expect(gate[0].targets).toHaveLength(5);
    expect(gate[0].summary).toBe('Fix it now');
    // A rule with no nodes is no finding.
    expect(report.map((f) => f.id)).toEqual(['region']);
  });
});

describe('hydration errors', () => {
  it('matches NG0500 and NG0602 only', () => {
    expect(isHydrationError('NG0500: During hydration Angular expected <div>')).toBe(true);
    expect(isHydrationError('Error: NG0602: toSignal() cannot be called')).toBe(true);
    expect(isHydrationError('NG05000 is not a code')).toBe(false);
    expect(isHydrationError('NG0100: changed after checked')).toBe(false);
  });
});

describe('known failures', () => {
  const entries = [
    { issue: 'AECI-1', rule: 'aria-prohibited-attr', path: '/_demo/spartan', targets: ['#a'] },
    { issue: 'AECI-2', rule: 'color-contrast', path: '/x' },
  ];

  it('moves a listed violation out of the gate on its page only', () => {
    const gate = [finding('aria-prohibited-attr'), finding('color-contrast')];
    const r = applyKnownFailures('/_demo/spartan', gate, entries);
    expect(r.known.map((k) => k.issue)).toEqual(['AECI-1']);
    expect(r.failing.map((f) => f.id)).toEqual(['color-contrast']);
    expect(r.stale).toEqual([]);
    expect(applyKnownFailures('/other', gate, entries).failing).toHaveLength(2);
  });

  it('still fails a new node of a listed rule', () => {
    const gate = [finding('aria-prohibited-attr', { targets: ['#a', '#b'], nodes: 2 })];
    expect(applyKnownFailures('/_demo/spartan', gate, entries).failing).toHaveLength(1);
    // More nodes than selectors kept: the unseen ones may be new.
    const many = [finding('aria-prohibited-attr', { targets: ['#a'], nodes: 9 })];
    expect(applyKnownFailures('/_demo/spartan', many, entries).failing).toHaveLength(1);
  });

  it('reports an entry whose rule now passes on its page as stale', () => {
    const r = applyKnownFailures('/x', [], entries);
    expect(r.stale.map((e) => e.issue)).toEqual(['AECI-2']);
  });

  it('reports an entry as stale when one of its listed targets passes', () => {
    const two = [{ issue: 'AECI-3', rule: 'color-contrast', path: '/p', targets: ['#a', '#b'] }];
    const both = [finding('color-contrast', { targets: ['#a', '#b'], nodes: 2 })];
    expect(applyKnownFailures('/p', both, two).stale).toEqual([]);
    const partial = [finding('color-contrast', { targets: ['#a'], nodes: 1 })];
    const r = applyKnownFailures('/p', partial, two);
    expect(r.stale.map((e) => e.issue)).toEqual(['AECI-3']);
    // The remaining node is still known, not a new failure.
    expect(r.known).toHaveLength(1);
  });
});

describe('the summary block', () => {
  const scan = (over: Partial<AxeScanRecord>): AxeScanRecord => ({
    status: 'scanned',
    url: 'http://localhost:8788/a?q=1',
    gate: [],
    report: [],
    ...over,
  });

  it('is an all-zero object when no test reached the sweep', () => {
    const s = summarizeAxe([{ title: 't', scan: null }]);
    expect(s.scans).toEqual({ scanned: 0, optedOut: 0, notScanned: 0 });
    expect(s.violationsByImpact).toEqual({ critical: 0, serious: 0, moderate: 0, minor: 0 });
    expect(s.gate.rules).toEqual([]);
    expect(s.reportOnly.rules).toEqual([]);
    expect(s.knownFailures).toEqual([]);
  });

  it('counts scans, lists opt-outs, and groups findings by rule', () => {
    const s = summarizeAxe([
      {
        title: 'one',
        scan: scan({ report: [finding('region', { impact: 'moderate', nodes: 2 })] }),
      },
      {
        title: 'two',
        scan: scan({
          url: 'http://localhost:8788/b',
          gate: [finding('color-contrast')],
          report: [finding('region', { impact: 'moderate', nodes: 3 })],
          known: [{ issue: 'AECI-9', finding: finding('list', { impact: 'critical' }) }],
        }),
      },
      { title: 'three', scan: scan({ status: 'opted-out', reason: 'why' }) },
      { title: 'four', scan: scan({ status: 'not-scanned', reason: 'JavaScript is off' }) },
      { title: 'five', scan: null },
    ])!;
    expect(s.scans).toEqual({ scanned: 2, optedOut: 1, notScanned: 1 });
    expect(s.optOuts).toEqual([{ title: 'three', reason: 'why' }]);
    expect(s.violationsByImpact).toEqual({ critical: 1, serious: 1, moderate: 0, minor: 0 });
    expect(s.gate.rules.map((r) => [r.id, r.tests])).toEqual([['color-contrast', 1]]);
    expect(s.knownFailures).toEqual([{ issue: 'AECI-9', rule: 'list', tests: 1 }]);
    expect(s.reportOnly.rules).toEqual([
      expect.objectContaining({ id: 'region', tests: 2, nodes: 5, paths: ['/a', '/b'] }),
    ]);
  });

  it('reads a scan annotation, and a broken one as null', () => {
    expect(parseScanRecord(JSON.stringify(scan({}))))!.toMatchObject({ status: 'scanned' });
    expect(parseScanRecord('{nope')).toBeNull();
    expect(parseScanRecord(undefined)).toBeNull();
  });
});
