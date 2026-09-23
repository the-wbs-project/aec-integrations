#!/usr/bin/env node
/**
 * Size gate for CLAUDE.md.
 *
 * CLAUDE.md is loaded into every Claude Code session and every spawned
 * sub-agent, so each byte is paid many times per day. It is a pointer file:
 * rules plus a route to the governing doc. Narrative, issue history and
 * incident detail belong in the doc the row names. This gate fails `pnpm lint`
 * when the file grows past the limit so the pattern of appending the lesson
 * learned here, rather than to the doc, cannot silently re-inflate it.
 */

import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIMIT_BYTES = 30_000;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'CLAUDE.md');
const size = statSync(file).size;

if (size > LIMIT_BYTES) {
  console.error(
    `CLAUDE.md is ${size} bytes; the limit is ${LIMIT_BYTES}. ` +
      'Move narrative into the governing doc and leave a one-line pointer here.',
  );
  process.exit(1);
}

console.log(`CLAUDE.md is ${size} bytes (limit ${LIMIT_BYTES}).`);
