#!/usr/bin/env node
/**
 * Mirror repo docs into Linear Documents (AECI-1549, replacing the one-workflow-per-doc
 * mirror of AECI-1201 and AECI-1431).
 *
 * `docs/linear-docs.json` maps each mirrored Markdown file to its Linear Document. The repo
 * file is the source of truth. The Linear Document is a read-only copy for people who do not
 * read the repo, and every sync overwrites it whole. The job holds a write-capable key, so
 * only the files in the mapping can be mirrored, and the mapping only changes through a PR.
 *
 * Commands:
 *   sync [--dry-run]
 *     Run by `.github/workflows/mirror-docs-to-linear.yml` on every push to `main` that
 *     touches Markdown or the mapping. Mirrors every mapped doc, every run. It never picks
 *     docs by the push's diff: GitHub cancels a superseded pending run, and a diff-based run
 *     after it would skip the cancelled push's doc with nothing going red.
 *   add <path> --title <title> [--dry-run]
 *     Run once from a workspace. Creates a Linear Document in the AECi team with the doc's
 *     content, then writes its id into the mapping. Commit the mapping with the doc.
 *   add <path> --id <id> [--dry-run]
 *     Registers a Linear Document that already exists. Reads it to get its UUID and title.
 *
 * Env:
 *   LINEAR_DOCS_MIRROR_API_KEY   Linear API key, sent as a bare `Authorization` header. `add`
 *                                falls back to LINEAR_API_KEY, which Conductor sets locally.
 *   GITHUB_SHA, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID  Set by Actions.
 *
 * Exit codes: 0 done (or dry run), 1 a Linear call failed, 2 a key is
 * unset, the arguments are wrong, or the mapping is invalid.
 * No dependencies, so the workflow needs no `pnpm install`.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';
export const MAPPING_PATH = 'docs/linear-docs.json';
/** The AECi team. `add` creates every Linear Document here. */
export const LINEAR_TEAM_ID = 'd7706bcb-c776-4064-b4da-0c350dfb8f16';
export const SOURCE_REPO = 'the-wbs-project/aec-integrations';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\.md$/;

export const DOCUMENT_UPDATE_MUTATION = `mutation MirrorDocToLinear($id: String!, $input: DocumentUpdateInput!) {
  documentUpdate(id: $id, input: $input) {
    success
    document {
      id
      updatedAt
    }
  }
}`;

export const DOCUMENT_CREATE_MUTATION = `mutation CreateMirroredDoc($input: DocumentCreateInput!) {
  documentCreate(input: $input) {
    success
    document {
      id
      title
      url
    }
  }
}`;

export const DOCUMENT_QUERY = `query MirroredDoc($id: String!) {
  document(id: $id) {
    id
    title
    url
  }
}`;

/**
 * Check the mapping's shape. Returns a list of problems, empty when it is valid.
 * `fileExists` is injectable so tests can check shape without touching the disk.
 */
export function validateMapping(
  mapping,
  { fileExists = (p) => existsSync(join(REPO_ROOT, p)) } = {},
) {
  if (mapping === null || typeof mapping !== 'object' || Array.isArray(mapping)) {
    return [`${MAPPING_PATH} must be a JSON object keyed by repo path.`];
  }
  const problems = [];
  const seenIds = new Map();
  for (const [path, entry] of Object.entries(mapping)) {
    if (!SAFE_PATH_RE.test(path) || path.split('/').some((seg) => seg === '..' || seg === '.')) {
      problems.push(`${path}: not a repo-relative .md path.`);
    } else if (!fileExists(path)) {
      problems.push(
        `${path}: the file does not exist. A renamed or deleted doc must update the mapping.`,
      );
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${path}: the entry must be an object with "title" and "id".`);
      continue;
    }
    const extra = Object.keys(entry).filter((k) => k !== 'title' && k !== 'id');
    if (extra.length > 0) problems.push(`${path}: unknown field ${extra.join(', ')}.`);
    if (typeof entry.title !== 'string' || entry.title.trim() === '') {
      problems.push(`${path}: "title" must be a non-empty string.`);
    }
    if (typeof entry.id !== 'string' || !UUID_RE.test(entry.id)) {
      problems.push(`${path}: "id" must be the Linear Document's lowercase UUID.`);
    } else if (seenIds.has(entry.id)) {
      problems.push(`${path}: id ${entry.id} is also mapped to ${seenIds.get(entry.id)}.`);
    } else {
      seenIds.set(entry.id, path);
    }
  }
  return problems;
}

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
  const at = sha
    ? ` at [\`${sha.slice(0, 12)}\`](https://github.com/${SOURCE_REPO}/commit/${sha})`
    : '';
  const lines = [
    `> Generated from \`${sourcePath}\` in ${SOURCE_REPO}${at}. Edits made in Linear are overwritten on the next merge.`,
  ];
  if (runUrl) {
    lines.push('>', `> Mirrored by ${runUrl}`);
  }
  return lines;
}

/**
 * The Markdown a Linear Document receives: the doc with the repo banner dropped and the
 * mirror header added. The header goes directly under the H1 when the doc opens with one,
 * else at the top. Everything else, tables included, passes through byte for byte.
 */
export function buildMirrorContent(markdown, { sourcePath, sha, runUrl } = {}) {
  if (typeof sourcePath !== 'string' || sourcePath === '') {
    throw new Error('A source path is required.');
  }
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new Error(`${sourcePath} is empty; refusing to blank the Linear Document.`);
  }
  const lines = stripRepoBanner(markdown.replace(/\r\n/g, '\n').split('\n'));
  const header = mirrorHeader({ sourcePath, sha, runUrl });
  const content = /^# /.test(lines[0] ?? '')
    ? [lines[0], '', ...header, '', ...lines.slice(lines[1] === '' ? 2 : 1)]
    : [...header, '', ...lines];
  return content.join('\n');
}

/** The GraphQL request body that overwrites one Linear Document, title included. */
export function buildMirrorPayload(markdown, entry, meta = {}) {
  if (typeof entry?.id !== 'string' || entry.id.trim() === '') {
    throw new Error('A Linear Document id is required.');
  }
  const input = { content: buildMirrorContent(markdown, meta) };
  if (typeof entry.title === 'string' && entry.title.trim() !== '')
    input.title = entry.title.trim();
  return { query: DOCUMENT_UPDATE_MUTATION, variables: { id: entry.id.trim(), input } };
}

/** The GraphQL request body that creates a Linear Document in the AECi team. */
export function buildCreatePayload(markdown, { sourcePath, title }) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('A title is required.');
  }
  return {
    query: DOCUMENT_CREATE_MUTATION,
    variables: {
      input: {
        title: title.trim(),
        teamId: LINEAR_TEAM_ID,
        content: buildMirrorContent(markdown, { sourcePath }),
      },
    },
  };
}

/**
 * Read a Linear response and return `data[field]`. Throws with a readable message on any
 * failure. Mutations must also report `success: true`.
 */
export function interpretResponse(status, bodyText, field = 'documentUpdate') {
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
  const result = body?.data?.[field];
  if (result === null || result === undefined) {
    throw new Error(`Linear returned no ${field}: ${bodyText.slice(0, 500)}`);
  }
  if (field !== 'document' && result.success !== true) {
    throw new Error(`Linear ${field} did not report success: ${bodyText.slice(0, 500)}`);
  }
  return field === 'document' ? result : (result.document ?? null);
}

/**
 * Parse `<command> [positional] [--flag value] [--switch]`. Unknown flags are errors, so a
 * typo never mirrors something unintended.
 */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const valueFlags = new Set(['--title', '--id']);
  const switches = new Set(['--dry-run']);
  const out = { command, positional: [], flags: {}, errors: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (valueFlags.has(arg)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) {
        out.errors.push(`${arg} needs a value.`);
      } else {
        out.flags[arg.slice(2)] = value;
        i++;
      }
    } else if (switches.has(arg)) {
      out.flags[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      out.errors.push(`Unknown flag ${arg}.`);
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

/** Serialize the mapping with keys in code-point order, so `add` produces stable diffs. */
export function serializeMapping(mapping) {
  const sorted = {};
  for (const key of Object.keys(mapping).sort()) sorted[key] = mapping[key];
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function readMapping() {
  return JSON.parse(readFileSync(join(REPO_ROOT, MAPPING_PATH), 'utf8'));
}

function runUrlFromEnv(env) {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return undefined;
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function errorLine(message) {
  const prefix = process.env.GITHUB_ACTIONS === 'true' ? '::error::' : '';
  console.error(`${prefix}${message}`);
}

function fail(message, code) {
  errorLine(message);
  process.exit(code);
}

async function linearCall(apiKey, payload, field) {
  let res;
  try {
    res = await fetch(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: apiKey },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new Error(`Linear request failed before a response: ${err?.message ?? err}`);
  }
  // Always consume the body, on every path, so the connection is released.
  const bodyText = await res.text();
  return interpretResponse(res.status, bodyText, field);
}

async function sync(flags, env) {
  const mapping = readMapping();
  const problems = validateMapping(mapping);
  if (problems.length > 0) fail(`${MAPPING_PATH} is invalid:\n${problems.join('\n')}`, 2);

  const targets = Object.keys(mapping);
  const meta = { sha: env.GITHUB_SHA, runUrl: runUrlFromEnv(env) };
  const payloads = targets.map((sourcePath) => [
    sourcePath,
    buildMirrorPayload(readFileSync(join(REPO_ROOT, sourcePath), 'utf8'), mapping[sourcePath], {
      ...meta,
      sourcePath,
    }),
  ]);

  if (flags['dry-run']) {
    for (const [sourcePath, payload] of payloads) {
      const { content } = payload.variables.input;
      console.log(`Dry run: ${sourcePath} -> ${payload.variables.id} (${content.length} chars).`);
    }
    console.log('No request sent.');
    return;
  }

  const apiKey = env.LINEAR_DOCS_MIRROR_API_KEY?.trim();
  if (!apiKey) {
    fail(
      'Cannot mirror: LINEAR_DOCS_MIRROR_API_KEY (repository secret) is not set. No Linear ' +
        'Document was updated. Setup: docs/CICD_PLAN.md §7.1.',
      2,
    );
  }

  // Sequential on purpose: a handful of docs, and one failure must not stop the rest.
  const failed = [];
  for (const [sourcePath, payload] of payloads) {
    try {
      const doc = await linearCall(apiKey, payload, 'documentUpdate');
      console.log(
        `Mirrored ${sourcePath} to Linear Document ${doc?.id ?? payload.variables.id} (updatedAt ${doc?.updatedAt ?? 'unknown'}).`,
      );
    } catch (err) {
      errorLine(`${sourcePath}: ${err.message}`);
      failed.push(sourcePath);
    }
  }
  if (failed.length > 0) {
    fail(`${failed.length} of ${payloads.length} docs were NOT mirrored: ${failed.join(', ')}.`, 1);
  }
}

async function add(positional, flags, env) {
  const [sourcePath] = positional;
  if (positional.length !== 1) fail('Usage: add <path> (--title <title> | --id <id>).', 2);
  if (Boolean(flags.title) === Boolean(flags.id)) fail('Pass exactly one of --title or --id.', 2);

  const mapping = readMapping();
  if (Object.hasOwn(mapping, sourcePath)) {
    fail(`${sourcePath} is already mapped to ${mapping[sourcePath].id}.`, 2);
  }
  // Check the path alone. The title and id here are stand-ins, replaced by Linear's answer.
  const probe = validateMapping({ [sourcePath]: { title: 'probe', id: LINEAR_TEAM_ID } });
  if (probe.length > 0) fail(probe.join('\n'), 2);
  const markdown = readFileSync(join(REPO_ROOT, sourcePath), 'utf8');

  if (flags['dry-run']) {
    console.log(
      flags.id
        ? `Dry run: would read Linear Document ${flags.id} and map ${sourcePath} to it.`
        : `Dry run: would create "${flags.title}" in the AECi team from ${sourcePath} (${markdown.length} chars).`,
    );
    return;
  }

  const apiKey = (env.LINEAR_DOCS_MIRROR_API_KEY || env.LINEAR_API_KEY)?.trim();
  if (!apiKey) fail('Set LINEAR_DOCS_MIRROR_API_KEY or LINEAR_API_KEY to call Linear.', 2);

  let doc;
  try {
    doc = flags.id
      ? await linearCall(apiKey, { query: DOCUMENT_QUERY, variables: { id: flags.id } }, 'document')
      : await linearCall(
          apiKey,
          buildCreatePayload(markdown, { sourcePath, title: flags.title }),
          'documentCreate',
        );
  } catch (err) {
    fail(err.message, 1);
  }

  const next = { ...mapping, [sourcePath]: { title: doc.title, id: doc.id } };
  const problems = validateMapping(next);
  if (problems.length > 0) {
    fail(`Linear returned ${doc.id}, but the mapping would be invalid:\n${problems.join('\n')}`, 2);
  }
  writeFileSync(join(REPO_ROOT, MAPPING_PATH), serializeMapping(next));
  console.log(`Mapped ${sourcePath} to "${doc.title}" (${doc.id}) ${doc.url ?? ''}`.trim());
  console.log(`Commit ${MAPPING_PATH} with the doc. The first merge to main mirrors it.`);
}

async function main(argv, env) {
  const { command, positional, flags, errors } = parseArgs(argv);
  if (errors.length > 0) fail(errors.join(' '), 2);
  if (command === 'sync') {
    if (positional.length > 0) fail('sync takes no paths. It mirrors every mapped doc.', 2);
    await sync(flags, env);
  } else if (command === 'add') {
    await add(positional, flags, env);
  } else {
    fail(
      'Usage: mirror-docs-to-linear.mjs sync [--dry-run] | add <path> (--title <t> | --id <id>) [--dry-run]',
      2,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2), process.env);
}
