/**
 * `scripts/mirror-notifications-doc.mjs` (AECI-1201). Runs under `node --test` from root
 * `pnpm test:scripts`, which root `pnpm test:unit` (the CI "Unit tests" check) calls first.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DOCUMENT_UPDATE_MUTATION,
  buildMirrorPayload,
  interpretResponse,
} from './mirror-notifications-doc.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const RUN_URL = 'https://github.com/the-wbs-project/aec-integrations/actions/runs/42';

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
  const payload = buildMirrorPayload(FIXTURE, ' doc-123 ', { sha: SHA, runUrl: RUN_URL });
  assert.deepEqual(Object.keys(payload).sort(), ['query', 'variables']);
  assert.equal(payload.query, DOCUMENT_UPDATE_MUTATION);
  assert.match(payload.query, /documentUpdate\(id: \$id, input: \$input\)/);
  assert.match(payload.query, /success/);
  assert.equal(payload.variables.id, 'doc-123');
  assert.deepEqual(Object.keys(payload.variables.input), ['content']);
});

test('header names the source, the commit and the overwrite rule, under the H1', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', { sha: SHA, runUrl: RUN_URL })
    .variables.input;
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
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', { sha: SHA }).variables.input;
  assert.ok(!content.includes('<!--'));
  assert.ok(!content.includes('Do not edit by hand'));
});

test('markdown tables pass through verbatim', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123', { sha: SHA }).variables.input;
  const table = FIXTURE.slice(FIXTURE.indexOf('## Counts'));
  assert.ok(content.endsWith(table));
});

test('the real committed doc keeps every table row verbatim', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const doc = readFileSync(join(root, 'docs/NOTIFICATIONS.md'), 'utf8');
  const { content } = buildMirrorPayload(doc, 'doc-123', { sha: SHA }).variables.input;
  const rows = doc.split('\n').filter((l) => l.startsWith('|'));
  assert.ok(rows.length > 10);
  const mirrored = content.split('\n').filter((l) => l.startsWith('|'));
  assert.deepEqual(mirrored, rows);
});

test('a missing sha still produces a header, and no run URL omits that line', () => {
  const { content } = buildMirrorPayload(FIXTURE, 'doc-123').variables.input;
  assert.match(content, /at an unknown commit\. Edits made in Linear are overwritten/);
  assert.ok(!content.includes('Mirrored by'));
});

test('an empty doc or id is refused', () => {
  assert.throws(() => buildMirrorPayload('  \n', 'doc-123'), /empty/);
  assert.throws(() => buildMirrorPayload(FIXTURE, ''), /id is required/);
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
