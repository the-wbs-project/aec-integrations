/**
 * Shape guard for the committed PostHog plane (`observability/posthog/`). apply.sh is run
 * by hand, so a broken link between an alert and its source insight is otherwise found in
 * production, as an alert sitting in `Errored`. These checks run in the unit lane instead.
 *
 * - every alert's `insightKey` resolves to exactly one insight on the alert-sources board;
 * - every alert-source query is a single-row aggregate (no top-level GROUP BY);
 * - the AECI-1206 email alerts exist with the thresholds their notes justify.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface Insight {
  key: string;
  dashboardKey: string;
  query: string;
}

interface Alert {
  key: string;
  insightKey: string;
  calculationInterval: string;
  threshold: { configuration: { bounds: { upper: number } } };
  config: { column: string; label_column: string };
}

const DIR = join(process.cwd(), '..', '..', 'observability', 'posthog');
const insights = (
  JSON.parse(readFileSync(join(DIR, 'insights.json'), 'utf8')) as { insights: Insight[] }
).insights;
const alerts = (JSON.parse(readFileSync(join(DIR, 'alerts.json'), 'utf8')) as { alerts: Alert[] })
  .alerts;

/** The query with every parenthesised span removed, so a subquery's GROUP BY is ignored. */
function topLevel(query: string): string {
  const sql = query.replace(/--[^\n]*/g, '');
  let depth = 0;
  let out = '';
  for (const ch of sql) {
    if (ch === '(') depth += 1;
    if (depth === 0) out += ch;
    if (ch === ')') depth -= 1;
  }
  return out;
}

describe('observability/posthog alerts.json ↔ insights.json', () => {
  it('has unique alert and insight keys', () => {
    expect(new Set(alerts.map((a) => a.key)).size).toBe(alerts.length);
    expect(new Set(insights.map((i) => i.key)).size).toBe(insights.length);
  });

  it.each(alerts.map((a) => [a.key, a] as const))(
    '%s points at one alert-source insight',
    (_key, alert) => {
      const matches = insights.filter((i) => i.key === alert.insightKey);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.dashboardKey).toBe('alert-sources');
      expect(['hourly', 'daily']).toContain(alert.calculationInterval);
    },
  );

  it.each(
    insights.filter((i) => i.dashboardKey === 'alert-sources').map((i) => [i.key, i] as const),
  )(
    '%s returns exactly one row (no top-level GROUP BY) and names its alert columns',
    (key, insight) => {
      expect(topLevel(insight.query)).not.toMatch(/\bGROUP\s+BY\b/i);
      for (const alert of alerts.filter((a) => a.insightKey === key)) {
        expect(insight.query).toContain(`AS ${alert.config.column}`);
        expect(insight.query).toContain(`AS ${alert.config.label_column}`);
      }
    },
  );

  it('the topLevel helper sees through a subquery GROUP BY but not a top-level one', () => {
    expect(topLevel('SELECT 1 FROM (SELECT a FROM t GROUP BY a) AS s')).not.toMatch(/GROUP BY/);
    expect(topLevel('SELECT a FROM t GROUP BY a')).toMatch(/GROUP BY/);
  });

  it('carries the AECI-1206 email alerts with their documented thresholds', () => {
    const byKey = new Map(alerts.map((a) => [a.key, a]));
    const expected = [
      ['email-failure-rate', 'alert-email-failure-rate', 'daily', 20],
      ['email-volume-spike', 'alert-email-volume-spike', 'daily', 50],
      ['email-suppressed-in-production', 'alert-email-suppressed', 'hourly', 0],
    ] as const;
    for (const [key, insightKey, interval, upper] of expected) {
      const alert = byKey.get(key);
      expect(alert?.insightKey).toBe(insightKey);
      expect(alert?.calculationInterval).toBe(interval);
      expect(alert?.threshold.configuration.bounds.upper).toBe(upper);
    }
    const board = insights.find((i) => i.key === 'email-sends-by-template');
    expect(board?.dashboardKey).not.toBe('alert-sources');
    expect(board?.query).toContain("metric_name = 'aeci.email.send'");
  });
});
