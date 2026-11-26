#!/usr/bin/env node
/**
 * Nightly accessibility operator alert (AECI-1875).
 *
 * Run by the `alert` job in `.github/workflows/a11y-nightly.yml`, on SCHEDULED runs only.
 * Linear only. Unlike the Lighthouse alert, it sends no email.
 *
 *   linear --outcome=failure   Find an OPEN AECI issue labelled `a11y-nightly-regression`.
 *                              Found: comment on it (SHA, run URL, failing surfaces).
 *                              Not found: file a Bug, labelled `Bug` + `a11y-nightly-regression`
 *                              (the second label is created on the team if missing), assigned
 *                              to the operator.
 *   linear --outcome=success   Recovery. Comment "Recovered at <sha>, run <url>" on the open
 *                              issue, if one exists. Never closes it.
 *
 * The failing tests come from `apps/web/a11y-nightly-summary.json`, written by
 * `apps/web/e2e-a11y/summary-reporter.ts`. A missing or unreadable summary still alerts, with
 * "no test summary, see the run log". The merged summary names each shard's file in `parts`
 * (`scripts/a11y-nightly-merge-summary.mjs`). A part that was never uploaded fails the run
 * with no failing test, so the alert names the missing parts instead (AECI-1874).
 *
 * The transport, the dry-run client, the label picker and the run URL come from
 * `scripts/lighthouse-alert.mjs`. Only the GraphQL operation names, the label and the copy
 * are this file's own.
 *
 * Env:
 *   LINEAR_API_KEY    Linear API key. Sent as a bare `Authorization` header.
 *   MEASURED_SHA      The commit the suite ran against. Falls back to the summary's commitSha.
 *   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID  Set by Actions.
 *
 * Flags:
 *   --outcome=failure|success  Required.
 *   --summary=<path>           Default apps/web/a11y-nightly-summary.json.
 *   --dry-run                  Print every GraphQL payload. Send nothing. No key required.
 *                              The lookup is answered by a canned "no open issue" context.
 *   --dry-run-open-issue       With --dry-run: answer the lookup with an open issue instead.
 *
 * Exit codes: 0 done (or dry run), 1 a request failed, 2 a required env var is unset or a flag
 * is wrong. No dependencies, so the job needs no `pnpm install`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import {
  ASSIGNEE_EMAIL,
  BUG_LABEL,
  TEAM_KEY,
  dryRunLinearClient,
  linearClient,
  parseArgs,
  pickLabel,
  runUrlFromEnv,
} from './lighthouse-alert.mjs';

export const REGRESSION_LABEL = 'a11y-nightly-regression';
export const DEFAULT_SUMMARY_PATH = 'apps/web/a11y-nightly-summary.json';
const REGRESSION_LABEL_COLOR = '#eb5757';
const TITLE_MAX = 200;
/** Rows in the failing-tests table. The run's HTML report has the rest. */
const TABLE_MAX = 25;

// ---------------------------------------------------------------------------
// GraphQL documents. Same shape as the Lighthouse alert, own operation names.
// ---------------------------------------------------------------------------

export const CONTEXT_QUERY = `query A11yNightlyAlertContext($teamKey: String!, $label: String!, $bug: String!, $email: String!) {
  teams(filter: { key: { eq: $teamKey } }) {
    nodes { id key }
  }
  openIssues: issues(
    first: 1
    filter: {
      team: { key: { eq: $teamKey } }
      labels: { some: { name: { eqIgnoreCase: $label } } }
      state: { type: { nin: ["completed", "canceled"] } }
    }
  ) {
    nodes { id identifier url title }
  }
  regressionLabels: issueLabels(filter: { name: { eqIgnoreCase: $label } }) {
    nodes { id name team { key } }
  }
  bugLabels: issueLabels(filter: { name: { eqIgnoreCase: $bug } }) {
    nodes { id name team { key } }
  }
  users(filter: { email: { eq: $email } }) {
    nodes { id email }
  }
}`;

export const LABEL_CREATE_MUTATION = `mutation A11yNightlyAlertLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name }
  }
}`;

export const ISSUE_CREATE_MUTATION = `mutation A11yNightlyAlertIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

export const COMMENT_CREATE_MUTATION = `mutation A11yNightlyAlertComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`;

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

/**
 * Read the run summary. Never throws: a missing or unreadable file means the run failed
 * before the reporter wrote it (boot failure, timeout), which is still an alert.
 */
export function loadSummary(path) {
  const out = { found: false, error: null, totals: null, failing: [], missingParts: [] };
  if (!existsSync(path)) {
    out.error = `${path} does not exist`;
    return out;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tests)) {
      throw new Error('expected an object with a tests array');
    }
    out.found = true;
    out.totals = parsed.totals ?? null;
    out.commitSha = typeof parsed.commitSha === 'string' ? parsed.commitSha : undefined;
    out.failing = parsed.tests
      .filter((t) => t && t.outcome === 'failed')
      .map((t) => ({
        title: String(t.title ?? ''),
        surfaceId: t.surfaceId ? String(t.surfaceId) : null,
        route: t.route ? String(t.route) : null,
        // AECI-1876: an e2e sweep test has no surface. Its spec file names it instead.
        file: t.file ? String(t.file) : null,
        // AECI-1885: the browser project that ran it. Null in a summary from before the lane.
        browser: t.browser ? String(t.browser) : null,
      }));
    // Only the merged summary has `parts`. A single shard's file has none.
    out.missingParts = Array.isArray(parsed.parts)
      ? parsed.parts
          .filter((part) => part && part.found === false)
          .map((part) => ({
            file: String(part.file ?? 'unknown'),
            error: part.error ? String(part.error) : null,
          }))
      : [];
  } catch (err) {
    out.error = `${path} is unreadable: ${err?.message ?? err}`;
  }
  return out;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function where(f) {
  const name = f.surfaceId ?? f.file;
  return name ? `\`${cell(name)}\`` : '-';
}

export function failingTable(failing) {
  const shown = failing.slice(0, TABLE_MAX);
  const rows = shown.map(
    (f) =>
      `| ${where(f)} | ${f.route ? `\`${cell(f.route)}\`` : '-'} | ${cell(f.title)} | ${
        f.browser ? cell(f.browser) : '-'
      } |`,
  );
  const lines = ['| Surface or spec | Route | Test | Browser |', '|---|---|---|---|', ...rows];
  if (failing.length > shown.length) {
    lines.push('', `${failing.length - shown.length} more. The run's HTML report lists them.`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

function commitLink(meta) {
  const short = meta.sha ? meta.sha.slice(0, 12) : 'unknown';
  if (!meta.sha || !meta.serverUrl || !meta.repository) return `\`${short}\``;
  return `[\`${short}\`](${meta.serverUrl}/${meta.repository}/commit/${meta.sha})`;
}

/** Short summary for the title. */
export function failureSummary(summary) {
  if (!summary.found) return 'no test summary';
  const surfaces = [...new Set(summary.failing.map((f) => f.surfaceId ?? f.file ?? f.title))];
  const missing = summary.missingParts?.length ?? 0;
  const parts = missing > 0 ? [`${missing} summary file(s) missing`] : [];
  if (surfaces.length === 0 && parts.length === 0) return 'run failed outside the tests';
  return [...parts, ...surfaces].join(', ');
}

/** The shard summaries the merge expected and never got, as a section. Empty when none. */
export function missingPartsSection(summary) {
  const missing = summary.missingParts ?? [];
  if (missing.length === 0) return [];
  return [
    '## Missing summaries',
    '',
    `${missing.length} shard summary file(s) never arrived, so the run failed even if every test it read passed. The shard either did not finish or did not upload. Read its job log.`,
    '',
    ...missing.map((p) => `- \`${cell(p.file)}\`${p.error ? `: ${cell(p.error)}` : ''}`),
    '',
  ];
}

export function issueTitle(summary) {
  const title = `Accessibility nightly failed on main: ${failureSummary(summary)}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function totalsLine(totals) {
  if (!totals) return null;
  const n = (k) => (typeof totals[k] === 'number' ? totals[k] : 0);
  return `${n('passed')} passed, ${n('failed')} failed, ${n('skipped')} skipped, ${n('expectedFailures')} known failures.`;
}

function failingSection(summary) {
  if (!summary.found) {
    return [
      '## Failing tests',
      '',
      `No test summary, see the run log. (${summary.error ?? 'unknown reason'})`,
    ].join('\n');
  }
  const totals = totalsLine(summary.totals);
  const missing = missingPartsSection(summary);
  if (summary.failing.length === 0) {
    return [
      ...missing,
      '## Failing tests',
      '',
      missing.length > 0
        ? `None recorded in the summaries that arrived.${totals ? ` ${totals}` : ''}`
        : `None recorded.${totals ? ` ${totals}` : ''} The run failed outside the tests. Read the run log.`,
    ].join('\n');
  }
  return [
    ...missing,
    '## Failing tests',
    '',
    ...(totals ? [totals, ''] : []),
    ...harnessNote(summary.failing),
    failingTable(summary.failing),
  ].join('\n');
}

/**
 * AECI-1885: the browser every failing row ran in, when that is one browser
 * other than Chromium. Else null. Such a night may be a difference in
 * Playwright's build of that browser, not a site regression.
 */
export function singleOtherBrowser(failing) {
  const browsers = new Set(failing.map((f) => f.browser ?? 'unknown'));
  if (browsers.size !== 1) return null;
  const [only] = browsers;
  return only === 'firefox' || only === 'webkit' ? only : null;
}

function harnessNote(failing) {
  const browser = singleOtherBrowser(failing);
  if (!browser) return [];
  return [
    `Every failing test ran in ${browser} only. This may be a difference in Playwright's ${browser} build, not a regression on the site. Before fixing anything, follow "First run on Linux, and a red night in one browser" in \`docs/TESTING_STRATEGY.md\` §8.4.10.`,
    '',
  ];
}

export function issueDescription(summary, meta) {
  return [
    'The nightly accessibility run failed on `main`.',
    '',
    'A red here means main regressed. Fix forward or revert. A barrier we cannot fix yet gets `knownFailure()` with its own issue, never a bare `test.fail()`.',
    '',
    `- Commit: ${commitLink(meta)}`,
    `- Run: ${meta.runUrl}`,
    '',
    failingSection(summary),
    '',
    'The suite is `apps/web/e2e-a11y/`. The workflow is `.github/workflows/a11y-nightly.yml`.',
    'Later failing nights comment here instead of opening a new issue. A passing night comments "Recovered". Nobody closes this automatically.',
  ].join('\n');
}

export function stillFailingComment(summary, meta) {
  return [
    `Still failing at ${commitLink(meta)}.`,
    '',
    `Run: ${meta.runUrl}`,
    '',
    failingSection(summary),
  ].join('\n');
}

export function recoveryComment(meta) {
  return [
    `Recovered at ${commitLink(meta)}, run ${meta.runUrl}`,
    '',
    'The nightly accessibility run passed. This issue stays open until someone closes it.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Linear
// ---------------------------------------------------------------------------

async function comment(graphql, issueId, body) {
  const data = await graphql(COMMENT_CREATE_MUTATION, { input: { issueId, body } });
  if (data?.commentCreate?.success !== true) {
    throw new Error(`Linear commentCreate did not report success: ${JSON.stringify(data)}`);
  }
}

/**
 * Returns { action, issueUrl, identifier }. Throws on any Linear failure.
 * action: 'created' | 'commented' | 'recovered' | 'noop'.
 */
export async function runLinear({ outcome, summary, meta, graphql, warn = () => {} }) {
  const ctx = await graphql(CONTEXT_QUERY, {
    teamKey: TEAM_KEY,
    label: REGRESSION_LABEL,
    bug: BUG_LABEL,
    email: ASSIGNEE_EMAIL,
  });
  const open = ctx?.openIssues?.nodes?.[0] ?? null;

  if (outcome === 'success') {
    if (!open) return { action: 'noop', issueUrl: '', identifier: '' };
    await comment(graphql, open.id, recoveryComment(meta));
    return { action: 'recovered', issueUrl: open.url, identifier: open.identifier };
  }

  if (open) {
    await comment(graphql, open.id, stillFailingComment(summary, meta));
    return { action: 'commented', issueUrl: open.url, identifier: open.identifier };
  }

  const team = ctx?.teams?.nodes?.find((t) => t.key === TEAM_KEY);
  if (!team?.id) throw new Error(`Linear has no team with key ${TEAM_KEY}.`);

  const labelIds = [];
  const bug = pickLabel(ctx?.bugLabels?.nodes);
  if (bug) labelIds.push(bug.id);
  else warn(`Linear has no "${BUG_LABEL}" label usable on ${TEAM_KEY}. Filing without it.`);

  let regression = pickLabel(ctx?.regressionLabels?.nodes);
  if (!regression) {
    const data = await graphql(LABEL_CREATE_MUTATION, {
      input: { name: REGRESSION_LABEL, teamId: team.id, color: REGRESSION_LABEL_COLOR },
    });
    if (data?.issueLabelCreate?.success !== true || !data.issueLabelCreate.issueLabel?.id) {
      throw new Error(`Linear issueLabelCreate did not report success: ${JSON.stringify(data)}`);
    }
    regression = data.issueLabelCreate.issueLabel;
  }
  labelIds.push(regression.id);

  const assignee = ctx?.users?.nodes?.[0];
  if (!assignee) warn(`Linear has no user ${ASSIGNEE_EMAIL}. Filing unassigned.`);

  const input = {
    teamId: team.id,
    title: issueTitle(summary),
    description: issueDescription(summary, meta),
    labelIds,
  };
  if (assignee?.id) input.assigneeId = assignee.id;
  const data = await graphql(ISSUE_CREATE_MUTATION, { input });
  const issue = data?.issueCreate?.issue;
  if (data?.issueCreate?.success !== true || !issue?.url) {
    throw new Error(`Linear issueCreate did not report success: ${JSON.stringify(data)}`);
  }
  return { action: 'created', issueUrl: issue.url, identifier: issue.identifier };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv, env, { fetchImpl = fetch, log = console.log } = {}) {
  const inActions = env.GITHUB_ACTIONS === 'true';
  const errorLine = (msg) => console.error(`${inActions ? '::error::' : ''}${msg}`);
  const warn = (msg) => console.error(`${inActions ? '::warning::' : ''}${msg}`);

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    errorLine(err.message);
    return 2;
  }
  const { command, flags } = parsed;
  if (command !== 'linear') {
    errorLine(`unknown command "${command ?? ''}". Use "linear".`);
    return 2;
  }
  const outcome = flags.outcome;
  if (outcome !== 'failure' && outcome !== 'success') {
    errorLine('linear needs --outcome=failure or --outcome=success');
    return 2;
  }
  const dryRun = flags['dry-run'] === true;
  const apiKey = env.LINEAR_API_KEY?.trim();
  if (!dryRun && !apiKey) {
    errorLine(
      'LINEAR_API_KEY is not set. No Linear issue was filed or updated for this accessibility run.',
    );
    return 2;
  }

  const summaryPath = typeof flags.summary === 'string' ? flags.summary : DEFAULT_SUMMARY_PATH;
  const summary =
    outcome === 'failure'
      ? loadSummary(summaryPath)
      : { found: false, error: null, totals: null, failing: [], missingParts: [] };
  const meta = {
    sha: env.MEASURED_SHA || summary.commitSha || undefined,
    runUrl: runUrlFromEnv(env),
    serverUrl: env.GITHUB_SERVER_URL,
    repository: env.GITHUB_REPOSITORY,
  };
  const graphql = dryRun
    ? dryRunLinearClient(log, { openIssue: flags['dry-run-open-issue'] === true })
    : linearClient(apiKey, fetchImpl);

  try {
    const r = await runLinear({ outcome, summary, meta, graphql, warn });
    const messages = {
      created: `Filed ${r.identifier}: ${r.issueUrl}`,
      commented: `Commented on open issue ${r.identifier}: ${r.issueUrl}`,
      recovered: `Commented "Recovered" on ${r.identifier}: ${r.issueUrl}. Left open.`,
      noop: `Green run and no open ${REGRESSION_LABEL} issue. Nothing to do.`,
    };
    log(`${dryRun ? '[dry run] ' : ''}${messages[r.action]}`);
    return 0;
  } catch (err) {
    errorLine(`Accessibility nightly alert, Linear step failed: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
