/**
 * Read a source file with its comments stripped, for tests that scan SQL text.
 *
 * Needed because the docblocks in `src/tools/*.ts` say things like "No
 * `SELECT *`" and name the denied tables in prose. A naive source scan matches
 * the explanation as readily as a real violation, so the rule would be
 * unenforceable exactly where it is best documented.
 */
import { readFileSync } from 'node:fs';

export function readSourceWithoutComments(url: URL): string {
  return readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}
