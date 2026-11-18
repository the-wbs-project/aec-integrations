#!/usr/bin/env node
/**
 * Conflict-marker gate (AECI-1720). Fails `pnpm lint` when any tracked text file holds
 * git conflict markers left by a merge.
 *
 * Why: a merge of main into the redesign hold branch left conflict markers in an
 * archived, published version of the "How ranking works" page
 * (`apps/web/src/content/docs/trust/versions/how-ranking-works/v1.1.md`). No gate read
 * that file, so nothing failed. This scan reads every tracked file in the repo:
 * content, docs and source alike.
 *
 * What counts: a line that starts with seven `<` and then a space or the line end,
 * followed later in the file by a line that starts with seven `>` and then a space or
 * the line end. Both ends are required. The middle `=======` alone never counts,
 * because a line of `=` signs under a line of text is a legal Markdown heading.
 *
 * Binary files (a NUL byte in the first 8 KB) are skipped. This file and its test
 * build the markers with `repeat`, so neither holds one literally.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const START = '<'.repeat(7);
const END = '>'.repeat(7);

/** A line that opens or closes a conflict: seven marks, then a space or the end. */
const isMarker = (line, mark) =>
  line.startsWith(mark) && (line.length === mark.length || line[mark.length] === ' ');

/**
 * The conflicts in one file's text: each start marker that a later end marker closes.
 * Returns the 1-indexed line of each start. Pure, so the test exercises the real rule.
 */
export function findConflicts(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const found = [];
  let open = null;
  lines.forEach((line, i) => {
    if (isMarker(line, START)) {
      if (open === null) open = i + 1;
    } else if (isMarker(line, END) && open !== null) {
      found.push(open);
      open = null;
    }
  });
  return found;
}

/** True when the buffer looks binary: a NUL byte in its first 8 KB. */
export function isBinary(buffer) {
  return buffer.subarray(0, 8192).includes(0);
}

function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const hits = [];
  for (const file of files) {
    let buffer;
    try {
      buffer = readFileSync(join(root, file));
    } catch {
      continue; // listed but deleted in the working tree
    }
    if (isBinary(buffer)) continue;
    for (const line of findConflicts(buffer.toString('utf8'))) hits.push(`${file}:${line}`);
  }
  if (hits.length > 0) {
    console.error(`Git conflict markers in ${hits.length} place(s). Resolve the merge:`);
    for (const hit of hits) console.error(`  ${hit}`);
    process.exit(1);
  }
  console.log(`No git conflict markers in ${files.length} tracked files.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
