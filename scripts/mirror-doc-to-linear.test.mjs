/**
 * `scripts/mirror-doc-to-linear.mjs` (AECI-1201, AECI-1431). Runs under `node --test` from root
 * `pnpm test:scripts`, which root `pnpm test:unit` (the CI "Unit tests" check) calls first.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOCUMENT_UPDATE_MUTATION,
  MIRRORED_DOCS,
  buildMirrorPayload,
  interpretResponse,
  parseSource,
} from './mirror-doc-to-linear.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.com/the-wbs-project/aec-integrations/actions/runs/42';
const SOURCE = 'docs/NOTIFICATIONS.md';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

test('payload is a documentUpdate mutation with the id and content variables', () => {
  const payload = buildMirrorPayload(FIXTURE, ' doc-123 ', {
    sourcePath: SOURCE,
    sha: SHA,
    runUrl: RUN_URL,
  });
  assert.deepEqual(Object.keys(payload).sort(), ['query', 'variables']);
  assert.equal(payload.query, DOCUMENT_UPDATE_MUTATION);
  assert.match(payload.query, /documentUpdate\(id: \$id, input: \$input\)/);
  assert.match(payload.query, /success/);
  assert.equal(payload.variables.id, 'doc-123');
  assert.deepEqual(Object.keys(payload.variables.input), ['content']);
});

test('header names the source, the commit and the overwrite rule, under the H1', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', {
    sourcePath: SOURCE,
    sha: SHA,
    runUrl: RUN_URL,
  }).variables.input;
  const lines = content.split('\n');
  assert.equal(lines[0], '# Notifications');
  assert.equal(lines[1], '');
  assert.match(
    lines[2],
    /^> Generated from `docs\/NOTIFICATIONS\.md` in the-wbs-project\/aec-integrations at /,
  );
  assert.ok(lines[2].includes(SHA.slice(0, 12)));
  assert.ok(lines[2].includes(`/commit/${SHA}`));
  assert.ok(lines[2].endsWith('Edits made in Linear are overwritten on the next merge.'));
  assert.ok(content.includes(RUN_URL));
});

test('the repo-side "do not edit, run pnpm" banner is dropped', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', { sourcePath: SOURCE, sha: SHA })
    .variables.input;
  assert.ok(!content.includes('<!--'));
  assert.ok(!content.includes('Do not edit by hand'));
});

test('markdown tables pass through verbatim', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', { sourcePath: SOURCE, sha: SHA })
    .variables.input;
  const table = FIXTURE.slice(FIXTURE.indexOf('## Counts'));
  assert.ok(content.endsWith(table));
});

for (const [sourcePath, minRows] of [
  ['docs/NOTIFICATIONS.md', 10],
  ['docs/PRICING_RULES.md', 10],
]) {
  test(`the real committed ${sourcePath} keeps every table row verbatim`, () => {
    const doc = readFileSync(join(ROOT, sourcePath), 'utf8');
    const { content } = buildMirrorPayload(doc, 'doc-123', { sourcePath, sha: SHA }).variables
      .input;
    const rows = doc.split('\n').filter((l) => l.startsWith('|'));
    assert.ok(rows.length > minRows);
    const mirrored = content.split('\n').filter((l) => l.startsWith('|'));
    assert.deepEqual(mirrored, rows);
    assert.ok(content.includes(`Generated from \`${sourcePath}\``));
  });
}

test('every mirrored doc exists and has its own id variable', () => {
  const vars = Object.values(MIRRORED_DOCS);
  assert.equal(new Set(vars).size, vars.length);
  for (const [sourcePath, docIdVar] of Object.entries(MIRRORED_DOCS)) {
    assert.ok(readFileSync(join(ROOT, sourcePath), 'utf8').trim().length > 0);
    assert.match(docIdVar, /^LINEAR_[A-Z_]+_DOC_ID$/);
  }
});

test('a source outside MIRRORED_DOCS is refused', () => {
  assert.throws(() => buildMirrorPayload(FIXTURE, 'doc-123'), /not a mirrored doc/);
  assert.throws(
    () => buildMirrorPayload(FIXTURE, 'doc-123', { sourcePath: '.dev.vars' }),
    /not a mirrored doc/,
  );
  assert.throws(
    () => buildMirrorPayload(FIXTURE, 'doc-123', { sourcePath: 'toString' }),
    /not a mirrored doc/,
  );
});

test('parseSource reads the value after --source', () => {
  assert.equal(parseSource(['--source', 'docs/PRICING_RULES.md']), 'docs/PRICING_RULES.md');
  assert.equal(
    parseSource(['--dry-run', '--source', 'docs/NOTIFICATIONS.md']),
    'docs/NOTIFICATIONS.md',
  );
  assert.equal(parseSource(['--dry-run']), undefined);
  assert.equal(parseSource(['--source']), undefined);
  assert.equal(parseSource(['--source', '--dry-run']), undefined);
});

test('a missing sha still produces a header, and no run URL omits that line', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', { sourcePath: SOURCE }).variables
    .input;
  assert.match(content, /at an unknown commit\. Edits made in Linear are overwritten/);
  assert.ok(!content.includes('Mirrored by'));
});

test('an empty doc or id is refused', () => {
  assert.throws(() => buildMirrorPayload('  \n', 'doc-123', { sourcePath: SOURCE }), /empty/);
  assert.throws(() => buildMirrorPayload(FIXTURE, '', { sourcePath: SOURCE }), /id is required/);
});

test('interpretResponse accepts only success: true', () => {
  const ok = JSON.stringify({
    data: { documentUpdate: { success: true, document: { id: 'd', updatedAt: 't' } } },
  });
  assert.deepEqual(interpretResponse(200, ok), { id: 'd', updatedAt: 't' });
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
