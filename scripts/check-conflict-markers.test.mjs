/**
 * `scripts/check-conflict-markers.mjs` (AECI-1720): the conflict-marker gate in root
 * `pnpm lint`. Runs under `node --test` from root `pnpm test:scripts`. The markers are
 * built with `repeat`, so this file never holds one literally and never trips the gate.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { findConflicts, isBinary } from './check-conflict-markers.mjs';

const START = '<'.repeat(7);
const MID = '='.repeat(7);
const END = '>'.repeat(7);

test('finds a merge conflict and reports the line it opens on', () => {
  const text = ['# Title', '', `${START} HEAD`, 'ours', MID, 'theirs', `${END} main`, ''].join(
    '\n',
  );
  assert.deepEqual(findConflicts(text), [3]);
});

test('finds bare markers with no branch name, and a diff3 base section', () => {
  const text = [START, 'ours', '|'.repeat(7) + ' base', 'base', MID, 'theirs', END].join('\n');
  assert.deepEqual(findConflicts(text), [1]);
});

test('finds every conflict in a file, with CRLF line endings too', () => {
  const one = [`${START} a`, 'x', MID, 'y', `${END} b`];
  const text = [...one, 'between', ...one].join('\r\n');
  assert.deepEqual(findConflicts(text), [1, 7]);
});

test('ignores a Markdown setext heading underlined with = signs', () => {
  const text = ['How ranking works', MID, '', 'Body text.', '', 'Section', '='.repeat(20)].join(
    '\n',
  );
  assert.deepEqual(findConflicts(text), []);
});

test('ignores a Markdown table and a horizontal rule', () => {
  const text = ['| A | B |', '| --- | --- |', '| 1 | 2 |', '', '---', '', '***'].join('\n');
  assert.deepEqual(findConflicts(text), []);
});

test('needs both ends: a start or an end alone is not a conflict', () => {
  assert.deepEqual(findConflicts([`${START} HEAD`, 'text', MID].join('\n')), []);
  assert.deepEqual(findConflicts([MID, 'text', `${END} main`].join('\n')), []);
  // An end before the start does not close it.
  assert.deepEqual(findConflicts([`${END} x`, 'text', `${START} y`].join('\n')), []);
});

test('ignores marker characters that do not start a line or run on into text', () => {
  const text = [
    `Shift operators like a ${START} b are not markers.`,
    `  ${START} indented`,
    `${START}${'<'} eight`,
    `${END}> eight`,
    `${START}x`,
    `${END}x`,
  ].join('\n');
  assert.deepEqual(findConflicts(text), []);
});

test('treats a buffer with a NUL byte as binary', () => {
  assert.equal(isBinary(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])), true);
  assert.equal(isBinary(Buffer.from('plain text\n', 'utf8')), false);
});
