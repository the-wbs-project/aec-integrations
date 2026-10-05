#!/usr/bin/env node
//
// payload.mjs — prints the Rulesets API body for one of the two AECI-1138 rules.
//
// The expression is read from the matching ```wirefilter title="…"``` block in
// docs/waf-rate-limits.md §2a, never retyped, so the rule that reaches the zone is the rule
// the doc records and check-corpus.mjs tested. Line breaks are collapsed to single spaces.
//
//   node payload.mjs 1   -> "Block secret-file probes (AECI-1138)", after "Blocker 2"
//   node payload.mjs 2 <rule-1-id>
//                        -> "Block framework and endpoint probes (AECI-1138)", after rule 1
//
// STRICTLY LOCAL. It prints JSON to stdout and calls nothing.

import { readFileSync } from 'node:fs';

const BLOCKER_2 = '2e2e7ae15d69446a872dcb142e7ed82c'; // WBS zone id since 2026-10-04 (was 4781ac7e… on the old zone)
const TITLES = {
  1: 'Block secret-file probes (AECI-1138)',
  2: 'Block framework and endpoint probes (AECI-1138)',
};

const [which, afterId] = process.argv.slice(2);
const title = TITLES[which];
if (!title) throw new Error('Usage: payload.mjs 1 | payload.mjs 2 <rule-1-id>');
if (which === '2' && !/^[0-9a-f]{32}$/.test(afterId ?? ''))
  throw new Error("Rule 2 goes after rule 1: pass rule 1's 32-hex id as the second argument");

const doc = readFileSync(new URL('../../../docs/waf-rate-limits.md', import.meta.url), 'utf8');
const escaped = title.replace(/[()]/g, '\\$&');
const block = doc.match(new RegExp('```wirefilter title="' + escaped + '"\\n([\\s\\S]*?)```'));
if (!block) throw new Error(`No wirefilter block titled "${title}" in docs/waf-rate-limits.md`);
const expression = block[1].replace(/\s+/g, ' ').trim();

process.stdout.write(
  `${JSON.stringify(
    {
      description: title,
      expression,
      action: 'block',
      enabled: true,
      position: { after: which === '1' ? BLOCKER_2 : afterId },
    },
    null,
    2,
  )}\n`,
);
