#!/usr/bin/env node
/**
 * Fails a PR that changes how traffic is classified and leaves
 * docs/BOT_TRAFFIC_CLASSIFICATION.md alone (AECI-1577). Run by
 * `.github/workflows/classification-doc-check.yml`.
 *
 * It passes when no watched file changed, when the doc changed, or when the PR description
 * opts out with one line:
 *
 *   **Classification doc:** no rule impact — <one sentence>
 *
 * It reads the file list and the line's shape only. Whether the doc edit is right, or the
 * opt-out is true, is the reviewer's job (docs/CODE_REVIEW_CHECKLIST.md).
 *
 * Inputs (env): PR_BODY (github.event.pull_request.body, untrusted text).
 * The PR checkout must be the merge ref with fetch-depth >= 2, so HEAD^1 is the base tip.
 *
 * Exit codes: 0 pass, 1 the doc is missing, 2 git could not list the changes.
 */

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DOC_PATH = 'docs/BOT_TRAFFIC_CLASSIFICATION.md';

const OPT_OUT_LINE = '**Classification doc:** no rule impact — <one sentence>';
const MIN_REASON_LENGTH = 12;

/** The files that decide a class, a signal, an internal-traffic rule, or who reads the classes. */
export const WATCHED_FILES = [
  'apps/api/src/lib/admin-analytics.ts',
  'apps/api/src/lib/admin-classification.ts',
  'apps/api/src/lib/analytics-digest.ts',
  'apps/api/src/lib/arrival-coverage.ts',
  'apps/api/src/lib/asn-registry.ts',
  'apps/api/src/lib/bot-classification.ts',
  'apps/api/src/lib/client-signals.ts',
  'apps/api/src/lib/home-stats.ts',
  'apps/api/src/lib/page-view-predicates.ts',
  'apps/api/src/lib/swarm-detection.ts',
  'apps/api/src/lib/traffic-classification-writer.ts',
  'apps/api/src/lib/traffic-classifier.ts',
  'apps/api/src/lib/traffic-shadow-candidates.ts',
  'apps/api/src/lib/traffic-shadow.ts',
  'apps/api/src/routes/admin-overview.ts',
  'apps/api/src/routes/admin-page-views.ts',
  'apps/api/src/routes/page-views.ts',
  'scripts/ops/backfill-page-view-bots.sql',
];

/** True when the description carries the opt-out line with a real reason. */
export function hasOptOut(body) {
  const line = String(body ?? '')
    .split(/\r?\n/)
    .find((l) => l.startsWith('**Classification doc:**'));
  if (line === undefined) return false;
  const m = line.match(/^\*\*Classification doc:\*\*\s*no rule impact\s*(?:—|-|:)\s*(.*)$/i);
  if (m === null) return false;
  const reason = m[1].trim();
  return reason.length >= MIN_REASON_LENGTH && !reason.startsWith('<');
}

/** The check's answer: the watched files that went undocumented, empty when it passes. */
export function undocumentedChanges(changedFiles, body) {
  if (changedFiles.includes(DOC_PATH) || hasOptOut(body)) return [];
  return changedFiles.filter((f) => WATCHED_FILES.includes(f));
}

function main() {
  let changed;
  try {
    changed = execFileSync('git', ['diff', '--name-only', '--no-renames', 'HEAD^1', 'HEAD'], {
      encoding: 'utf8',
    });
  } catch (err) {
    console.error(`::error::Could not list the PR's changes: ${err.message}`);
    process.exit(2);
  }
  const missing = undocumentedChanges(changed.split('\n').filter(Boolean), process.env.PR_BODY);
  if (missing.length === 0) {
    console.log('No undocumented change to how traffic is classified.');
    return;
  }
  console.error(
    `::error::This PR changes ${missing.join(', ')} but not ${DOC_PATH}. Update the doc in this PR. If the change has no rule impact, add this line to the PR description: ${OPT_OUT_LINE}`,
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
