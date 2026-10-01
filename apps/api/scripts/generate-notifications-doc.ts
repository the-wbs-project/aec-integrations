/**
 * generate-notifications-doc.ts — writes `docs/NOTIFICATIONS.md` from the notification
 * registry (AECI-1200). The Node shell around the tested core,
 * `src/lib/notifications/render-doc.ts`: it reads the PostHog alert config, renders, and
 * writes or compares.
 *
 * USAGE (from the repo root):
 *   pnpm docs:notifications          # regenerate docs/NOTIFICATIONS.md
 *   pnpm docs:notifications:check    # exit 1 when the committed file is stale
 *
 * Root `pnpm lint` runs the check, so it gates the required "Lint & typecheck" CI job.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NOTIFICATIONS } from '../src/lib/notifications/registry';
import {
  checkNotificationsDoc,
  NOTIFICATIONS_DOC_PATH,
  renderNotificationsDoc,
  type MonitoringAlert,
  type MonitoringAlerts,
} from '../src/lib/notifications/render-doc';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
}

/** The alert list is required. A malformed file fails the run rather than render a gap. */
function readAlerts(): Pick<MonitoringAlerts, 'alerts' | 'appliesTo'> {
  const raw = readJson('observability/posthog/alerts.json') as {
    alerts?: unknown;
    appliesTo?: unknown;
  };
  if (!Array.isArray(raw.alerts)) throw new Error('alerts.json has no "alerts" array');
  const alerts = raw.alerts.map((a: Partial<MonitoringAlert>, i): MonitoringAlert => {
    if (
      typeof a.key !== 'string' ||
      typeof a.name !== 'string' ||
      typeof a.calculationInterval !== 'string'
    ) {
      throw new Error(`alerts.json alerts[${i}] lacks key, name or calculationInterval`);
    }
    return { key: a.key, name: a.name, calculationInterval: a.calculationInterval };
  });
  const appliesTo = Array.isArray(raw.appliesTo)
    ? raw.appliesTo.filter((t): t is string => typeof t === 'string')
    : [];
  return { alerts, appliesTo };
}

/** Subscribers are best-effort: an unreadable config renders a pointer instead. */
function readSubscribers(): string[] {
  try {
    const raw = readJson('observability/posthog/project-config.json') as {
      alertSubscribers?: Array<{ email?: unknown }>;
    };
    return (raw.alertSubscribers ?? [])
      .map((s) => s.email)
      .filter((e): e is string => typeof e === 'string');
  } catch {
    return [];
  }
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const rendered = renderNotificationsDoc(NOTIFICATIONS, {
    ...readAlerts(),
    subscribers: readSubscribers(),
  });
  const target = join(REPO_ROOT, NOTIFICATIONS_DOC_PATH);

  if (check) {
    const committed = existsSync(target) ? readFileSync(target, 'utf8') : null;
    const problem = checkNotificationsDoc(committed, rendered);
    if (problem) {
      console.error(problem);
      return 1;
    }
    console.log(`${NOTIFICATIONS_DOC_PATH} is current.`);
    return 0;
  }

  writeFileSync(target, rendered);
  console.log(`Wrote ${NOTIFICATIONS_DOC_PATH}.`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
