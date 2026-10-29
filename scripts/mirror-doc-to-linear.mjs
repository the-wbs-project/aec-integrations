#!/usr/bin/env node
/**
 * Mirror one repo doc into one Linear Document (AECI-1201, generalized by AECI-1431).
 *
 * Run by one workflow per doc (`.github/workflows/mirror-*-doc.yml`) on every push to `main`
 * that changes it. The repo file is the source of truth. The Linear Document is a read-only
 * copy for people who do not read the repo, and every run overwrites it whole.
 *
 * Only the docs in MIRRORED_DOCS can be mirrored, each into the Linear Document named by its
 * own repository variable. The job holds a write-capable key, so the source is not free-form.
 *
 * Env:
 *   LINEAR_DOCS_MIRROR_API_KEY   Linear API key. Sent as a bare `Authorization` header.
 *   The doc's id variable        From MIRRORED_DOCS, e.g. LINEAR_NOTIFICATIONS_DOC_ID.
 *   GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID  Set by Actions.
 *
 * Flags:
 *   --source <path>  Required. A key of MIRRORED_DOCS.
 *   --dry-run        Build the payload and print its size and first lines. No network call,
 *                    and neither env var is required.
 *
 * Exit codes: 0 updated (or dry run), 1 the update failed, 2 a required env var is unset or
 * the source is missing or not allowed.
 * No dependencies, so the workflow needs no `pnpm install`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
/** Each mirrored doc and the repository variable holding its Linear Document id. */
export const MIRRORED_DOCS = Object.freeze({
  'docs/NOTIFICATIONS.md': 'LINEAR_NOTIFICATIONS_DOC_ID',
  'docs/PRICING_RULES.md': 'LINEAR_PRICING_RULES_DOC_ID',
});
export const SOURCE_REPO = 'the-wbs-project/aec-integrations';

export const DOCUMENT_UPDATE_MUTATION = `mutation MirrorDocToLinear($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) {
    success
    document {
      id
      updatedAt
    }
  }
}`;

/**
 * The repo-side banner tells a repo editor to run `pnpm docs:notifications`. A Linear
 * reader cannot act on that, so the mirror drops it and carries its own header instead.
 */
const REPO_BANNER_LINES = [
  /^<!-- Generated from .*-->$/,
  /^> Generated from .*Do not edit by hand/,
];

function stripRepoBanner(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (REPO_BANNER_LINES.some((re) => re.test(lines[i]))) {
      if (lines[i + 1] === '') i++;
      continue;
    }
    out.push(lines[i]);
  }
  return out;
}

function mirrorHeader({ sourcePath, sha, runUrl }) {
  const commit = sha
    ? `[\`${sha.slice(0, 12)}\`](https://github.com/${SOURCE_REPO}/commit/${sha})`
    : 'an unknown commit';
  const lines = [
    `> Generated from \`${sourcePath}\` in ${SOURCE_REPO} at ${commit}. Edits made in Linear are overwritten on the next merge.`,
  ];
  if (runUrl) {
    lines.push('>', `> Mirrored by ${runUrl}`);
  }
  return lines;
}

/**
 * Build the GraphQL request body that overwrites the Linear Document with the doc.
 *
 * The header goes directly under the H1 when the doc opens with one, else at the top.
 * Everything else, tables included, passes through byte for byte.
 */
export function buildMirrorPayload(markdown, docId, { sourcePath, sha, runUrl } = {}) {
  if (!Object.hasOwn(MIRRORED_DOCS, sourcePath ?? '')) {
    throw new Error(`${sourcePath ?? 'No source'} is not a mirrored doc (MIRRORED_DOCS).`);
  }
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new Error(`${sourcePath} is empty; refusing to blank the Linear Document.`);
  }
  if (typeof docId !== 'string' || docId.trim() === '') {
    throw new Error('A Linear Document id is required.');
  }
  const lines = stripRepoBanner(markdown.replace(/\r\n/g, '\n').split('\n'));
  const header = mirrorHeader({ sourcePath, sha, runUrl });
  const content = /^# /.test(lines[0] ?? '')
    ? [lines[0], '', ...header, '', ...lines.slice(lines[1] === '' ? 2 : 1)]
    : [...header, '', ...lines];
  return {
    query: DOCUMENT_UPDATE_MUTATION,
    variables: { id: docId.trim(), input: { content: content.join('\n') } },
  };
}

/**
 * Read a Linear response and decide whether the update landed. Returns the updated
 * document on success. Throws with a readable message on any failure.
 */
export function interpretResponse(status, bodyText) {
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
  const result = body?.data?.documentUpdate;
  if (result?.success !== true) {
    throw new Error(`Linear documentUpdate did not report success: ${bodyText.slice(0, 500)}`);
  }
  return result.document ?? null;
}

function runUrlFromEnv(env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function fail(message, code) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(`${prefix}${message}`);
  process.exit(code);
}

/** The value after `--source`, or undefined when the flag or its value is missing. */
export function parseSource(argv) {
  const i = argv.indexOf('--source');
  const value = i === -1 ? undefined : argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

async function main(argv, env) {
  const dryRun = argv.includes('--dry-run');
  const sourcePath = parseSource(argv);
  if (!Object.hasOwn(MIRRORED_DOCS, sourcePath ?? '')) {
    fail(
      `--source must be one of ${Object.keys(MIRRORED_DOCS).join(', ')}. Got ${sourcePath ?? 'nothing'}.`,
      2,
    );
  }
  const docIdVar = MIRRORED_DOCS[sourcePath];
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const markdown = readFileSync(join(repoRoot, sourcePath), 'utf8');
  const apiKey = env.LINEAR_DOCS_MIRROR_API_KEY?.trim();
  const docId = env[docIdVar]?.trim();
  const meta = { sourcePath, sha: env.GITHUB_SHA, runUrl: runUrlFromEnv(env) };

  if (dryRun) {
    const payload = buildMirrorPayload(markdown, docId || 'dry-run-document-id', meta);
    const json = JSON.stringify(payload);
    const content = payload.variables.input.content;
    console.log(`Dry run. No request sent.`);
    console.log(`Payload: ${Buffer.byteLength(json)} bytes. Content: ${content.length} chars.`);
    console.log(`Document id: ${payload.variables.id}`);
    console.log('First lines of content:');
    console.log(content.split('\n').slice(0, 8).join('\n'));
    return;
  }

  const missing = [];
  if (!apiKey) missing.push('LINEAR_DOCS_MIRROR_API_KEY (repository secret)');
  if (!docId) missing.push(`${docIdVar} (repository variable)`);
  if (missing.length > 0) {
    fail(
      `Cannot mirror ${sourcePath}: ${missing.join(' and ')} not set. ` +
        'The Linear Document was NOT updated. Setup steps: docs/CICD_PLAN.md §7.1.',
      2,
    );
  }

  const payload = buildMirrorPayload(markdown, docId, meta);
  let res;
  try {
    res = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    fail(`Linear request failed before a response: ${err?.message ?? err}`, 1);
  }
  // Always consume the body, on every path, so the connection is released.
  const bodyText = await res.text();
  try {
    const doc = interpretResponse(res.status, bodyText);
    console.log(
      `Mirrored ${sourcePath} to Linear Document ${doc?.id ?? docId} (updatedAt ${doc?.updatedAt ?? 'unknown'}).`,
    );
  } catch (err) {
    fail(err.message, 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2), process.env);
}
