/**
 * `scripts/mirror-docs-to-linear.mjs` (AECI-1549). Runs under `node --test` from root
 * `pnpm test:scripts`, which root `pnpm test:unit` (the CI "Unit tests" check) calls first.
 * The committed-mapping test is the PR-time gate: a mapped doc that was renamed or deleted
 * fails here, before the merge, not in the post-merge mirror.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOCUMENT_CREATE_MUTATION,
  DOCUMENT_UPDATE_MUTATION,
  LINEAR_TEAM_ID,
  MAPPING_PATH,
  buildCreatePayload,
  buildMirrorContent,
  buildMirrorPayload,
  interpretResponse,
  parseArgs,
  serializeMapping,
  validateMapping,
} from './mirror-docs-to-linear.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.com/the-wbs-project/aec-integrations/actions/runs/42';
const SOURCE = 'docs/NOTIFICATIONS.md';
const ID_A = 'e21a9221-e47f-4acd-8cb7-37db5d0729df';
const ID_B = '11111111-2222-4333-8444-555555555555';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPPING = JSON.parse(readFileSync(join(ROOT, MAPPING_PATH), 'utf8'));
const exists = () => true;

const FIXTURE = [
  '# Notifications',
  '',
  '<!-- Generated from apps/api/src/lib/notifications/registry.ts. Do not edit by hand; run `pnpm docs:notifications`. -->',
  '',
  '> Generated from `apps/api/src/lib/notifications/registry.ts`. Do not edit by hand; run `pnpm docs:notifications`.',
  '',
  '## Counts',
  '',
  '| Channel | Entries |',
  '|---|---|',
  '| `email` | 3 |',
  '| Id | Sends a \\| pipe |',
  '',
].join('\n');

test('the committed mapping is valid: every doc exists, ids are unique UUIDs', () => {
  assert.deepEqual(validateMapping(MAPPING), []);
  assert.ok(Object.keys(MAPPING).length > 0);
});

test('the committed mapping is serialized the way add writes it', () => {
  assert.equal(readFileSync(join(ROOT, MAPPING_PATH), 'utf8'), serializeMapping(MAPPING));
});

for (const [sourcePath] of Object.entries(MAPPING)) {
  test(`the real committed ${sourcePath} keeps every table row verbatim`, () => {
    const doc = readFileSync(join(ROOT, sourcePath), 'utf8');
    const content = buildMirrorContent(doc, { sourcePath, sha: SHA });
    const rows = doc.split('\n').filter((l) => l.startsWith('|'));
    const mirrored = content.split('\n').filter((l) => l.startsWith('|'));
    assert.deepEqual(mirrored, rows);
    assert.ok(content.includes(`Generated from \`${sourcePath}\``));
  });
}

test('validateMapping refuses paths outside the repo or not Markdown', () => {
  for (const path of [
    '../secrets.md',
    '/etc/x.md',
    'docs/../x.md',
    './x.md',
    '.dev.vars',
    'a b.md',
  ]) {
    const problems = validateMapping({ [path]: { title: 'T', id: ID_A } }, { fileExists: exists });
    assert.ok(
      problems.some((p) => p.includes('not a repo-relative .md path')),
      path,
    );
  }
});

test('validateMapping refuses a missing file, a bad id, a duplicate id and extra fields', () => {
  assert.match(
    validateMapping({ 'docs/GONE.md': { title: 'T', id: ID_A } }, { fileExists: () => false })[0],
    /does not exist/,
  );
  assert.match(
    validateMapping({ 'docs/A.md': { title: 'T', id: '88c8005a9a19' } }, { fileExists: exists })[0],
    /lowercase UUID/,
  );
  assert.match(
    validateMapping({ 'docs/A.md': { title: ' ', id: ID_A } }, { fileExists: exists })[0],
    /non-empty string/,
  );
  assert.match(
    validateMapping(
      { 'docs/A.md': { title: 'A', id: ID_A }, 'docs/B.md': { title: 'B', id: ID_A } },
      { fileExists: exists },
    )[0],
    /also mapped to docs\/A\.md/,
  );
  assert.match(
    validateMapping(
      { 'docs/A.md': { title: 'A', id: ID_A, team: 'x' } },
      { fileExists: exists },
    )[0],
    /unknown field team/,
  );
  assert.match(validateMapping([])[0], /JSON object/);
});

test('update payload is a documentUpdate with the id, the title and the content', () => {
  const payload = buildMirrorPayload(
    FIXTURE,
    { title: ' Notifications ', id: ` ${ID_A} ` },
    { sourcePath: SOURCE, sha: SHA, runUrl: RUN_URL },
  );
  assert.equal(payload.query, DOCUMENT_UPDATE_MUTATION);
  assert.match(payload.query, /documentUpdate\(id: \$id, input: \$input\)/);
  assert.equal(payload.variables.id, ID_A);
  assert.deepEqual(Object.keys(payload.variables.input).sort(), ['content', 'title']);
  assert.equal(payload.variables.input.title, 'Notifications');
  assert.throws(
    () => buildMirrorPayload(FIXTURE, { id: '' }, { sourcePath: SOURCE }),
    /id is required/,
  );
});

test('create payload targets the AECi team and carries the content without a commit', () => {
  const payload = buildCreatePayload(FIXTURE, { sourcePath: SOURCE, title: 'Notifications' });
  assert.equal(payload.query, DOCUMENT_CREATE_MUTATION);
  assert.deepEqual(Object.keys(payload.variables.input).sort(), ['content', 'teamId', 'title']);
  assert.equal(payload.variables.input.teamId, LINEAR_TEAM_ID);
  assert.ok(!payload.variables.input.content.includes('/commit/'));
  assert.throws(() => buildCreatePayload(FIXTURE, { sourcePath: SOURCE, title: '' }), /title/);
});

test('header names the source, the commit and the overwrite rule, under the H1', () => {
  const lines = buildMirrorContent(FIXTURE, {
    sourcePath: SOURCE,
    sha: SHA,
    runUrl: RUN_URL,
  }).split('\n');
  assert.equal(lines[0], '# Notifications');
  assert.equal(lines[1], '');
  assert.match(
    lines[2],
    /^> Generated from `docs\/NOTIFICATIONS\.md` in the-wbs-project\/aec-integrations at /,
  );
  assert.ok(lines[2].includes(`/commit/${SHA}`));
  assert.ok(lines[2].endsWith('Edits made in Linear are overwritten on the next merge.'));
  assert.ok(lines.join('\n').includes(RUN_URL));
});

test('with no sha the header names no commit, and no run URL omits that line', () => {
  const content = buildMirrorContent(FIXTURE, { sourcePath: SOURCE });
  assert.match(content, /aec-integrations\. Edits made in Linear are overwritten/);
  assert.ok(!content.includes('Mirrored by'));
});

test('the repo-side banner is dropped and tables pass through verbatim', () => {
  const content = buildMirrorContent(FIXTURE, { sourcePath: SOURCE, sha: SHA });
  assert.ok(!content.includes('<!--'));
  assert.ok(!content.includes('Do not edit by hand'));
  assert.ok(content.endsWith(FIXTURE.slice(FIXTURE.indexOf('## Counts'))));
});

test('an empty doc or a missing source path is refused', () => {
  assert.throws(() => buildMirrorContent('  \n', { sourcePath: SOURCE }), /empty/);
  assert.throws(() => buildMirrorContent(FIXTURE), /source path is required/);
});

test('parseArgs reads the command, positionals, value flags and switches', () => {
  assert.deepEqual(parseArgs(['sync', '--dry-run']), {
    command: 'sync',
    positional: [],
    flags: { 'dry-run': true },
    errors: [],
  });
  const add = parseArgs(['add', 'docs/X.md', '--title', 'X doc']);
  assert.deepEqual(add.positional, ['docs/X.md']);
  assert.equal(add.flags.title, 'X doc');
  assert.deepEqual(parseArgs(['add', 'docs/X.md', '--title']).errors, ['--title needs a value.']);
  assert.deepEqual(parseArgs(['add', '--id', '--dry-run']).errors, ['--id needs a value.']);
  assert.deepEqual(parseArgs(['sync', '--source', 'x']).errors, ['Unknown flag --source.']);
  assert.deepEqual(parseArgs(['sync', '--all']).errors, ['Unknown flag --all.']);
});

test('serializeMapping orders keys and ends with a newline', () => {
  const out = serializeMapping({
    'docs/B.md': { title: 'B', id: ID_B },
    'docs/A.md': { title: 'A', id: ID_A },
  });
  assert.ok(out.indexOf('docs/A.md') < out.indexOf('docs/B.md'));
  assert.ok(out.endsWith('}\n'));
});

test('interpretResponse accepts only a successful mutation or a found document', () => {
  const ok = JSON.stringify({
    data: { documentUpdate: { success: true, document: { id: 'd', updatedAt: 't' } } },
  });
  assert.deepEqual(interpretResponse(200, ok), { id: 'd', updatedAt: 't' });
  const created = JSON.stringify({
    data: { documentCreate: { success: true, document: { id: ID_A, title: 'T', url: 'u' } } },
  });
  assert.equal(interpretResponse(200, created, 'documentCreate').id, ID_A);
  const found = JSON.stringify({ data: { document: { id: ID_A, title: 'T', url: 'u' } } });
  assert.equal(interpretResponse(200, found, 'document').title, 'T');
  assert.throws(
    () => interpretResponse(200, JSON.stringify({ data: { document: null } }), 'document'),
    /no document/,
  );
  assert.throws(
    () => interpretResponse(200, JSON.stringify({ data: { documentUpdate: { success: false } } })),
    /did not report success/,
  );
  assert.throws(
    () => interpretResponse(200, JSON.stringify({ errors: [{ message: 'Entity not found' }] })),
    /Entity not found/,
  );
  assert.throws(() => interpretResponse(401, '{"message":"no"}'), /HTTP 401/);
  assert.throws(() => interpretResponse(502, '<html>bad gateway</html>'), /non-JSON/);
});
