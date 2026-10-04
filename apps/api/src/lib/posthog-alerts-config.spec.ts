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
  description?: string;
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
    // AECI-1197 review: an `unknown` send (timeout or thrown call) counts as failed.
    const failureRate = insights.find((i) => i.key === 'alert-email-failure-rate')?.query ?? '';
    expect(failureRate).toContain("s.labels['outcome'] IN ('failed', 'unknown')");
    expect(failureRate).toContain("s.labels['outcome'] IN ('sent', 'failed', 'unknown')");
    expect(failureRate).not.toContain("s.labels['outcome'] = 'failed'");
    const volume = insights.find((i) => i.key === 'alert-email-volume-spike')?.query ?? '';
    expect(volume).toContain("s.labels['outcome'] IN ('sent', 'failed', 'unknown')");
    const board = insights.find((i) => i.key === 'email-sends-by-template');
    expect(board?.dashboardKey).not.toBe('alert-sources');
    expect(board?.query).toContain("metric_name = 'aeci.email.send'");
    // Every outcome `emit()` in email.ts can send gets its own column.
    for (const outcome of ['sent', 'failed', 'unknown', 'skipped', 'duplicate', 'suppressed']) {
      expect(board?.query).toContain(`s.labels['outcome'] = '${outcome}'`);
    }
  });

  it('carries the AECI-1222 delivery alerts on recorded events only', () => {
    const byKey = new Map(alerts.map((a) => [a.key, a]));
    const expected = [
      ['email-bounce-rate', 'alert-email-bounce-rate', 'daily', 5],
      ['email-complaint-rate', 'alert-email-complaint-rate', 'daily', 0.1],
    ] as const;
    for (const [key, insightKey, interval, upper] of expected) {
      const alert = byKey.get(key);
      expect(alert?.insightKey).toBe(insightKey);
      expect(alert?.calculationInterval).toBe(interval);
      expect(alert?.threshold.configuration.bounds.upper).toBe(upper);
      const query = insights.find((i) => i.key === insightKey)?.query ?? '';
      expect(query).toContain("metric_name = 'aeci.email.delivery'");
      // Drops, replays and ignored types are not this tier's mail.
      expect(query).toContain("s.labels['outcome'] = 'recorded'");
      expect(query).toContain("s.labels['event'] = 'sent'");
    }
  });
});

describe('observability/posthog insights.json descriptions', () => {
  // PostHog rejects a description over 400 characters, and apply.sh refuses the
  // whole run. Catch it in CI instead of at apply time.
  it('keeps every insight description within 400 characters', () => {
    const tooLong = insights
      .filter((i) => (i.description ?? '').length > 400)
      .map((i) => `${i.key} (${i.description!.length})`);
    expect(tooLong).toEqual([]);
  });
});
