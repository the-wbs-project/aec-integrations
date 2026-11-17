/**
 * AECI-1689: the build's current-version constants are not "the version in force now".
 * A published upcoming version replaces them at its effective moment with no deploy, so
 * every reader that stamps or shows the current version asks the one rule
 * (`legal-in-force.ts`). This spec is the lint rule that keeps a stray read from coming
 * back: it fails on any source file outside the list below that names
 * `LEGAL_AGREEMENT_CURRENT_VERSIONS`, `LEGAL_READER_CURRENT_VERSIONS` (AECI-1637) or
 * `LEGAL_POLICY_CURRENT_VERSIONS` in code.
 *
 * Specs are exempt (they pin the constants to the Markdown). Each other entry says why
 * its read means the BUILD's version, not the one in force. Adding a file here needs
 * the same sentence.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = packages/shared. */
const ROOT = join(process.cwd(), '..', '..');
const SCANNED = ['apps/api/src', 'apps/web/src', 'packages/shared/src'];

const ALLOWED: Readonly<Record<string, string>> = {
  'packages/shared/src/api/agreements.ts': 'defines the constants',
  'packages/shared/src/api/legal-in-force.ts': 'the rule: the one reader',
  'apps/api/src/routes/admin-legal-versions.ts':
    '/admin/legal names the build version the upcoming one replaces',
  'apps/web/src/app/vendor/vendor-fixtures.ts': 'fixture rows for the portal previews',
  'apps/web/src/app/preview/admin-vendor-billing/admin-vendor-billing-preview.ts':
    'fixture rows for a preview page',
};

const NAMES =
  /\b(LEGAL_AGREEMENT_CURRENT_VERSIONS|LEGAL_READER_CURRENT_VERSIONS|LEGAL_POLICY_CURRENT_VERSIONS)\b/;

/** The source with comments removed, so a doc comment naming a constant is not a read. */
function codeOf(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') yield* sourceFiles(path);
    } else if (/\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
      yield path;
    }
  }
}

describe('readers of the build current-version constants (AECI-1689)', () => {
  it('only the listed files read them in code', () => {
    const offenders: string[] = [];
    for (const dir of SCANNED) {
      for (const path of sourceFiles(join(ROOT, dir))) {
        const rel = relative(ROOT, path).split('\\').join('/');
        if (rel in ALLOWED) continue;
        if (NAMES.test(codeOf(readFileSync(path, 'utf8')))) offenders.push(rel);
      }
    }
    expect(
      offenders,
      'Use legalAgreementVersionInForce / legalReaderVersionInForce / legalPolicyVersionInForce (lib/legal-in-force.ts on the API, LegalInForceClient on the web), or add the file to ALLOWED with the reason its read means the build version.',
    ).toEqual([]);
  });

  it('every listed file still exists and still reads one', () => {
    for (const rel of Object.keys(ALLOWED)) {
      expect(NAMES.test(codeOf(readFileSync(join(ROOT, rel), 'utf8'))), rel).toBe(true);
    }
  });
});
