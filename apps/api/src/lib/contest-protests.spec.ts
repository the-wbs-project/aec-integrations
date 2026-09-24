/**
 * AECI-1009: "Nothing about a protest is public" (ruled 2026-09-22,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11b.12.1).
 *
 * A source scan, because the failure it guards against is silent: a public read
 * that started selecting a `protest_*` column, or reading the contests table at
 * all, would render fine and leak a dispute between two vendors onto a cached
 * page. Two allowlists, both of non-public modules:
 *
 *   1. Every file that names a PROTEST column.
 *   2. Every file that names the contests TABLE (`integrationFieldChallenges` or
 *      `integration_field_challenges`). A new reader of the table must be added
 *      here on purpose, with the reason it is not a public read.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

/** Modules that may name a protest column. */
const PROTEST_ALLOWED = new Set([
  'db/schema.ts',
  'lib/contest-protests.ts',
  'lib/admin-queue-counts.ts',
  'routes/account.ts',
  'routes/admin-contests.ts',
  'routes/admin-contest-protests.ts',
  'routes/vendor-contests.ts',
  'routes/vendor-contest-protests.ts',
]);

/** Modules that may name the contests table, each for a non-public reason. */
const TABLE_ALLOWED = new Set([
  ...PROTEST_ALLOWED,
  'lib/integration-contests.ts', // the shared contest rules and the vendor scoping predicate
  'lib/linear.ts', // the REVIEW - issue persist on an AECi accept
  'lib/reconciliation-sweep.ts', // the Phase 6.7 retry of a missing REVIEW - issue
  'lib/retract-product.ts', // the operator CLI's cascade report
  'lib/integration-retire.ts', // a retire closes open contests (AECI-1010 / AECI-1046)
  'routes/integration-retire-write.ts', // the shared retire batch
  'routes/vendor-updates.ts', // the vendor `contests` freshness cursor, authenticated
  'lib/vendor-handback.ts', // seat loss re-routes owner contests (AECI-989)
  'routes/promote-contests.ts', // a promote cross-table move re-anchors contests (AECI-1110)
]);

const PROTEST_COLUMN =
  /\bprotest(Status|Basis|Reason|Evidence|edBy|edAt|ReplyDueAt|Reply|ReplyEvidence|RepliedBy|RepliedAt|DecisionNote|DecidedBy|DecidedAt|WorkflowId)\b|\bprotest_(status|basis|reason|evidence|reply|decision|decided|workflow)|\bprotested_(by|at)\b/;
const CONTEST_TABLE = /\bintegrationFieldChallenges\b|\bintegration_field_challenges\b/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sourceFiles(path);
    return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [path] : [];
  });
}

function offenders(pattern: RegExp, allowed: ReadonlySet<string>): string[] {
  return sourceFiles(SRC)
    .filter((path) => pattern.test(readFileSync(path, 'utf8')))
    .map((path) => relative(SRC, path))
    .filter((path) => !allowed.has(path));
}

describe('contests and protests stay off public reads', () => {
  it('protest columns are named only by the allowlisted, non-public modules', () => {
    expect(offenders(PROTEST_COLUMN, PROTEST_ALLOWED)).toEqual([]);
  });

  it('the contests table is named only by the allowlisted, non-public modules', () => {
    expect(offenders(CONTEST_TABLE, TABLE_ALLOWED)).toEqual([]);
  });
});
