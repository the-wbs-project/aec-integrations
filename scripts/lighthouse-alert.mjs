#!/usr/bin/env node
/**
 * Nightly Lighthouse operator alert.
 *
 * Run by the `alert` job in `.github/workflows/lighthouse.yml`, on SCHEDULED runs only. Two
 * subcommands, run as two separate workflow steps so one failing never suppresses the other:
 *
 *   linear --outcome=failure   Find an OPEN AECI issue labelled `lighthouse-regression`.
 *                              Found: comment on it (SHA, run URL, failing assertions).
 *                              Not found: create a Bug, labelled `Bug` + `lighthouse-regression`
 *                              (the second label is created on the team if missing), assigned
 *                              to the operator.
 *   linear --outcome=success   Recovery. Comment "recovered at <sha>" on the open issue, if one
 *                              exists. Never closes it.
 *   email                      One Resend email to support@. The workflow runs it only when the
 *                              linear step created a NEW issue, or when the linear step failed.
 *
 * Failing assertions come from LHCI's `.lighthouseci/assertion-results.json`. `pnpm lighthouse`
 * runs `lhci autorun` from `apps/web`, so the file is `apps/web/.lighthouseci/`. `lhci assert`
 * saves only non-passing results (no `includePassedAssertions` in `.lighthouserc.cjs`). This
 * script keeps the ones with `level: 'error'`: only those fail the run.
 *
 * Env:
 *   LINEAR_API_KEY    Linear API key (linear subcommand). Sent as a bare `Authorization` header.
 *   RESEND_API_KEY    Resend API key (email subcommand).
 *   MEASURED_SHA      The commit Lighthouse measured.
 *   GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT  Set by Actions.
 *   GITHUB_OUTPUT     Set by Actions. The linear subcommand writes issue_created / issue_url.
 *
 * Flags:
 *   --results=<path>     assertion-results.json (default apps/web/.lighthouseci/assertion-results.json)
 *   --links=<path>       LHCI links.json, url -> report (default alongside --results). Optional.
 *   --issue-url=<url>    email only: the Linear issue to link.
 *   --dry-run            Print every GraphQL / Resend payload. Send nothing. No key required.
 *                        The Linear lookup is answered by a canned "no open issue" context.
 *   --dry-run-open-issue With --dry-run: answer the lookup with an open issue instead.
 *
 * Exit codes: 0 done (or dry run), 1 a request failed, 2 a required env var is unset or a flag
 * is wrong. No dependencies, so the job needs no `pnpm install`.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
export const TEAM_KEY = 'AECI';
export const REGRESSION_LABEL = 'lighthouse-regression';
export const BUG_LABEL = 'Bug';
export const ASSIGNEE_EMAIL = 'chrisw@thewbsproject.com';
/** The only verified Resend sender (docs/email.md). */
export const EMAIL_FROM = 'AEC Integrations <notifications@aecintegrations.com>';
export const EMAIL_TO = 'support@aecintegrations.com';
export const DEFAULT_RESULTS_PATH = 'apps/web/.lighthouseci/assertion-results.json';
/** Linear's label colour for the auto-created team label. */
const REGRESSION_LABEL_COLOR = '#eb5757';
const TITLE_MAX = 200;

// ---------------------------------------------------------------------------
// GraphQL documents
// ---------------------------------------------------------------------------

/** One round trip for everything the alert needs to decide. */
export const CONTEXT_QUERY = `query LighthouseAlertContext($teamKey: String!, $label: String!, $bug: String!, $email: String!) {
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

export const LABEL_CREATE_MUTATION = `mutation LighthouseAlertLabel($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) {
    success
    issueLabel { id name }
  }
}`;

export const ISSUE_CREATE_MUTATION = `mutation LighthouseAlertIssue($input: IssueCreateInput!) {
  issueCreate(input: $input) {
    success
    issue { id identifier url }
  }
}`;

export const COMMENT_CREATE_MUTATION = `mutation LighthouseAlertComment($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id url }
  }
}`;

// ---------------------------------------------------------------------------
// Assertion results
// ---------------------------------------------------------------------------

/**
 * Read LHCI assertion output. Never throws: a missing or unreadable file means the run failed
 * before `lhci assert` wrote it (boot failure, guard step, timeout), which is still an alert.
 */
export function loadAssertionResults(resultsPath, linksPath) {
  const out = { found: false, error: null, failing: [], links: {} };
  if (!existsSync(resultsPath)) {
    out.error = `${resultsPath} does not exist`;
    return out;
  }
  try {
    const parsed = JSON.parse(readFileSync(resultsPath, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('expected a JSON array');
    out.found = true;
    out.failing = failingAssertions(parsed);
  } catch (err) {
    out.error = `${resultsPath} is unreadable: ${err?.message ?? err}`;
  }
  if (linksPath && existsSync(linksPath)) {
    try {
      const links = JSON.parse(readFileSync(linksPath, 'utf8'));
      if (links && typeof links === 'object' && !Array.isArray(links)) out.links = links;
    } catch {
      // Report links are a convenience. A bad links.json must not block the alert.
    }
  }
  return out;
}

/** The assertion key as written in `.lighthouserc.cjs`, e.g. `categories:seo`. */
export function assertionKey(result) {
  const prop = Array.isArray(result.auditProperty)
    ? result.auditProperty.join('.')
    : result.auditProperty;
  return prop ? `${result.auditId}:${prop}` : String(result.auditId ?? 'unknown');
}

/** Only error-level misses fail the run. Warn-level misses are expected today. */
export function failingAssertions(results) {
  return results
    .filter((r) => r && r.passed === false && (r.level ?? 'error') === 'error')
    .map((r) => ({
      url: String(r.url ?? ''),
      key: assertionKey(r),
      name: String(r.name ?? ''),
      operator: String(r.operator ?? ''),
      expected: r.expected,
      actual: r.actual,
    }));
}

/** Unique assertion keys, in first-seen order. */
export function failingKeys(failing) {
  return [...new Set(failing.map((f) => f.key))];
}

function pagePath(url) {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || '/';
  } catch {
    return url || '(unknown page)';
  }
}

function formatValue(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return 'not measured';
  if (Number.isInteger(value)) return String(value);
  return Math.abs(value) < 10 ? value.toFixed(2) : String(Math.round(value));
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

export function assertionTable(failing, links = {}) {
  const rows = failing.map((f) => {
    const page = links[f.url]
      ? `[${cell(pagePath(f.url))}](${links[f.url]})`
      : `\`${cell(pagePath(f.url))}\``;
    return `| ${page} | \`${cell(f.key)}\` | ${cell(f.operator)} ${cell(formatValue(f.expected))} | ${cell(formatValue(f.actual))} |`;
  });
  return ['| Page | Assertion | Expected | Found |', '|---|---|---|---|', ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export function runUrlFromEnv(env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return '(run URL unavailable)';
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function commitLink(meta) {
  const short = meta.sha ? meta.sha.slice(0, 12) : 'unknown';
  if (!meta.sha || !meta.serverUrl || !meta.repository) return `\`${short}\``;
  return `[\`${short}\`](${meta.serverUrl}/${meta.repository}/commit/${meta.sha})`;
}

/** Short summary for a title or subject line. */
export function failureSummary(results) {
  const keys = failingKeys(results.failing);
  if (keys.length === 0) return 'run failed before assertions finished';
  return keys.join(', ');
}

export function issueTitle(results) {
  const title = `Lighthouse regression on main: ${failureSummary(results)}`;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

function failingSection(results) {
  if (results.failing.length > 0) {
    return ['## Failing assertions', '', assertionTable(results.failing, results.links)].join('\n');
  }
  const why = results.found
    ? 'LHCI wrote assertion results, but none of them is an error-level miss.'
    : `No assertion results: ${results.error ?? 'unknown reason'}.`;
  return [
    '## Failing assertions',
    '',
    `None recorded. ${why} The run failed outside the assertions. Read the run log.`,
  ].join('\n');
}

export function issueDescription(results, meta) {
  return [
    'The nightly Lighthouse run failed on `main`.',
    '',
    'A red here means main regressed. Fix forward or revert. Do not ignore it.',
    '',
    `- Commit: ${commitLink(meta)}`,
    `- Run: ${meta.runUrl}`,
    '',
    failingSection(results),
    '',
    'Budgets live in `.lighthouserc.cjs`. The workflow is `.github/workflows/lighthouse.yml`.',
    'Later failing nights comment here instead of opening a new issue. A passing night comments "recovered". Nobody closes this automatically.',
  ].join('\n');
}

export function stillFailingComment(results, meta) {
  return [
    `Still failing at ${commitLink(meta)}.`,
    '',
    `Run: ${meta.runUrl}`,
    '',
    failingSection(results),
  ].join('\n');
}

export function recoveryComment(meta) {
  return [
    `Recovered at ${commitLink(meta)}, run ${meta.runUrl}`,
    '',
    'The nightly Lighthouse run passed. This issue stays open until someone closes it.',
  ].join('\n');
}

export function emailPayload(results, meta, issueUrl) {
  const issueLine = issueUrl
    ? `Linear issue: ${issueUrl}`
    : 'The Linear issue could not be filed. The run log has the error.';
  const lines = results.failing.map(
    (f) =>
      `- ${pagePath(f.url)}  ${f.key}  expected ${f.operator} ${formatValue(f.expected)}, found ${formatValue(f.actual)}`,
  );
  const text = [
    'The nightly Lighthouse run failed on main.',
    'A red here means main regressed. Fix forward or revert.',
    '',
    `Commit: ${meta.sha ?? 'unknown'}`,
    `Run: ${meta.runUrl}`,
    issueLine,
    '',
    'Failing assertions:',
    ...(lines.length > 0 ? lines : [`- none recorded (${failureSummary(results)})`]),
    '',
    'Later failing nights comment on the Linear issue instead of emailing again.',
  ].join('\n');
  return {
    from: EMAIL_FROM,
    to: [EMAIL_TO],
    subject: issueTitle(results),
    text,
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Parse a Linear response. Throws a readable error on any failure. */
export function interpretLinear(status, bodyText) {
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(
      `Linear returned HTTP ${status} with a non-JSON body: ${bodyText.slice(0, 500)}`,
    );
  }
  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const messages = body.errors.map((e) => e?.message ?? JSON.stringify(e)).join('; ');
    throw new Error(`Linear returned GraphQL errors (HTTP ${status}): ${messages}`);
  }
  if (status < 200 || status >= 300) {
    throw new Error(`Linear returned HTTP ${status}: ${bodyText.slice(0, 500)}`);
  }
  if (!body?.data) throw new Error(`Linear returned no data: ${bodyText.slice(0, 500)}`);
  return body.data;
}

export function linearClient(apiKey, fetchImpl = fetch) {
  return async function graphql(query, variables) {
    let res;
    try {
      res = await fetchImpl(LINEAR_GRAPHQL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: apiKey },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new Error(`Linear request failed before a response: ${err?.message ?? err}`);
    }
    // Always read the body so the connection is released, on every path.
    const bodyText = await res.text();
    return interpretLinear(res.status, bodyText);
  };
}

function operationName(query) {
  const m = String(query).match(/(?:query|mutation)\s+(\w+)/);
  return m ? m[1] : 'unknown';
}

/** Dry-run stand-in: prints each payload and answers with canned data. */
export function dryRunLinearClient(log, { openIssue = false } = {}) {
  return async function graphql(query, variables) {
    const op = operationName(query);
    log(`--- Linear ${op} (dry run, not sent) ---`);
    log(JSON.stringify({ query, variables }, null, 2));
    if (op === 'LighthouseAlertContext') {
      return {
        teams: { nodes: [{ id: 'dry-run-team-id', key: TEAM_KEY }] },
        openIssues: {
          nodes: openIssue
            ? [
                {
                  id: 'dry-run-issue-id',
                  identifier: 'AECI-0',
                  url: 'https://linear.app/dry-run/issue/AECI-0',
                  title: 'Lighthouse regression on main (dry run)',
                },
              ]
            : [],
        },
        regressionLabels: { nodes: [] },
        bugLabels: { nodes: [{ id: 'dry-run-bug-label-id', name: BUG_LABEL, team: null }] },
        users: { nodes: [{ id: 'dry-run-user-id', email: ASSIGNEE_EMAIL }] },
      };
    }
    if (op === 'LighthouseAlertLabel') {
      return { issueLabelCreate: { success: true, issueLabel: { id: 'dry-run-label-id' } } };
    }
    if (op === 'LighthouseAlertIssue') {
      return {
        issueCreate: {
          success: true,
          issue: {
            id: 'dry-run-issue-id',
            identifier: 'AECI-0',
            url: 'https://linear.app/dry-run/issue/AECI-0',
          },
        },
      };
    }
    if (op === 'LighthouseAlertComment') {
      return { commentCreate: { success: true, comment: { id: 'dry-run-comment-id' } } };
    }
    throw new Error(`dry run has no canned answer for ${op}`);
  };
}

/** A label usable on the AECI team: team-scoped to AECI, or workspace-wide (team null). */
export function pickLabel(nodes) {
  const usable = (nodes ?? []).filter((n) => !n.team || n.team.key === TEAM_KEY);
  return usable.find((n) => n.team?.key === TEAM_KEY) ?? usable[0] ?? null;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * Returns { action, created, issueUrl, identifier }. Throws on any Linear failure.
 * action: 'created' | 'commented' | 'recovered' | 'noop'.
 */
export async function runLinear({ outcome, results, meta, graphql, warn = () => {} }) {
  const ctx = await graphql(CONTEXT_QUERY, {
    teamKey: TEAM_KEY,
    label: REGRESSION_LABEL,
    bug: BUG_LABEL,
    email: ASSIGNEE_EMAIL,
  });
  const open = ctx?.openIssues?.nodes?.[0] ?? null;

  if (outcome === 'success') {
    if (!open) return { action: 'noop', created: false, issueUrl: '', identifier: '' };
    await comment(graphql, open.id, recoveryComment(meta));
    return { action: 'recovered', created: false, issueUrl: open.url, identifier: open.identifier };
  }

  if (open) {
    await comment(graphql, open.id, stillFailingComment(results, meta));
    return { action: 'commented', created: false, issueUrl: open.url, identifier: open.identifier };
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
    title: issueTitle(results),
    description: issueDescription(results, meta),
    labelIds,
  };
  if (assignee?.id) input.assigneeId = assignee.id;
  const data = await graphql(ISSUE_CREATE_MUTATION, { input });
  const issue = data?.issueCreate?.issue;
  if (data?.issueCreate?.success !== true || !issue?.url) {
    throw new Error(`Linear issueCreate did not report success: ${JSON.stringify(data)}`);
  }
  return { action: 'created', created: true, issueUrl: issue.url, identifier: issue.identifier };
}

async function comment(graphql, issueId, body) {
  const data = await graphql(COMMENT_CREATE_MUTATION, { input: { issueId, body } });
  if (data?.commentCreate?.success !== true) {
    throw new Error(`Linear commentCreate did not report success: ${JSON.stringify(data)}`);
  }
}

/** Send one email through Resend. Returns the Resend id. Throws on any failure. */
export async function sendEmail({ apiKey, payload, idempotencyKey, fetchImpl = fetch }) {
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  let res;
  try {
    res = await fetchImpl(RESEND_EMAILS_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Resend request failed before a response: ${err?.message ?? err}`);
  }
  const bodyText = await res.text();
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Resend returned HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
  }
  try {
    return JSON.parse(bodyText)?.id ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

class UsageError extends Error {}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (const arg of rest) {
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m) throw new UsageError(`unrecognised argument: ${arg}`);
    flags[m[1]] = m[2] ?? true;
  }
  return { command, flags };
}

function writeOutputs(env, outputs) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = Object.entries(outputs).map(([k, v]) => `${k}=${String(v).replace(/\n/g, ' ')}`);
  appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
}

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
  const dryRun = flags['dry-run'] === true;
  const resultsPath = typeof flags.results === 'string' ? flags.results : DEFAULT_RESULTS_PATH;
  const linksPath =
    typeof flags.links === 'string' ? flags.links : join(dirname(resultsPath), 'links.json');
  const meta = {
    sha: env.MEASURED_SHA || undefined,
    runUrl: runUrlFromEnv(env),
    serverUrl: env.GITHUB_SERVER_URL,
    repository: env.GITHUB_REPOSITORY,
  };

  if (command === 'linear') {
    const outcome = flags.outcome;
    if (outcome !== 'failure' && outcome !== 'success') {
      errorLine('linear needs --outcome=failure or --outcome=success');
      return 2;
    }
    const apiKey = env.LINEAR_API_KEY?.trim();
    if (!dryRun && !apiKey) {
      errorLine(
        'LINEAR_API_KEY is not set. No Linear issue was filed or updated for this Lighthouse run.',
      );
      return 2;
    }
    const results =
      outcome === 'failure'
        ? loadAssertionResults(resultsPath, linksPath)
        : { found: false, failing: [], links: {} };
    const graphql = dryRun
      ? dryRunLinearClient(log, { openIssue: flags['dry-run-open-issue'] === true })
      : linearClient(apiKey, fetchImpl);
    try {
      const r = await runLinear({ outcome, results, meta, graphql, warn });
      const messages = {
        created: `Filed ${r.identifier}: ${r.issueUrl}`,
        commented: `Commented on open issue ${r.identifier}: ${r.issueUrl}. No email.`,
        recovered: `Commented "recovered" on ${r.identifier}: ${r.issueUrl}. Left open.`,
        noop: 'Green run and no open lighthouse-regression issue. Nothing to do.',
      };
      log(`${dryRun ? '[dry run] ' : ''}${messages[r.action]}`);
      writeOutputs(env, {
        action: r.action,
        issue_created: r.created,
        issue_url: r.issueUrl,
        issue_identifier: r.identifier,
      });
      return 0;
    } catch (err) {
      errorLine(`Lighthouse alert, Linear step failed: ${err.message}`);
      return 1;
    }
  }

  if (command === 'email') {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!dryRun && !apiKey) {
      errorLine('RESEND_API_KEY is not set. The Lighthouse alert email was NOT sent.');
      return 2;
    }
    const results = loadAssertionResults(resultsPath, linksPath);
    const issueUrl = typeof flags['issue-url'] === 'string' ? flags['issue-url'] : '';
    const payload = emailPayload(results, meta, issueUrl);
    const idempotencyKey = env.GITHUB_RUN_ID
      ? `lighthouse-alert/${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT ?? 1}`
      : undefined;
    if (dryRun) {
      log('--- Resend POST /emails (dry run, not sent) ---');
      log(JSON.stringify({ idempotencyKey: idempotencyKey ?? null, payload }, null, 2));
      return 0;
    }
    try {
      const id = await sendEmail({ apiKey, payload, idempotencyKey, fetchImpl });
      log(`Sent the Lighthouse alert email to ${EMAIL_TO} (Resend id ${id ?? 'unknown'}).`);
      return 0;
    } catch (err) {
      errorLine(`Lighthouse alert, email step failed: ${err.message}`);
      return 1;
    }
  }

  errorLine(`unknown command "${command ?? ''}". Use "linear" or "email".`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2), process.env);
}
