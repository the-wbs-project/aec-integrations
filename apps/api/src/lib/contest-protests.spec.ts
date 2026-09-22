/**
 * AECI-1009: "Nothing about a protest is public" (ruled 2026-09-22,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12.1).
 *
 * A source scan, because the failure it guards against is silent: a public read
 * that started selecting a `protest_*` column would render fine and leak a dispute
 * between two vendors onto a cached page. Every file in `src/` that names a protest
 * column must be on the allowlist below, and none of them serves a public route.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

const ALLOWED = new Set([
  'db/schema.ts',
  'lib/contest-protests.ts',
  'lib/admin-queue-counts.ts',
  'routes/account.ts',
  'routes/admin-contests.ts',
  'routes/admin-contest-protests.ts',
  'routes/vendor-contests.ts',
  'routes/vendor-contest-protests.ts',
]);

const PROTEST_COLUMN =
  /\bprotest(Status|Basis|Reason|Evidence|edBy|edAt|ReplyDueAt|Reply|ReplyEvidence|RepliedBy|RepliedAt|DecisionNote|DecidedBy|DecidedAt|WorkflowId)\b|\bprotest_(status|basis|reason|evidence|reply|decision|decided|workflow)|\bprotested_(by|at)\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('protest columns stay off public reads', () => {
  it('are named only by the allowlisted, non-public modules', () => {
    const offenders = sourceFiles(SRC)
      .filter((path) => PROTEST_COLUMN.test(readFileSync(path, 'utf8')))
      .map((path) => relative(SRC, path))
      .filter((path) => !ALLOWED.has(path));
    expect(offenders).toEqual([]);
  });
});
