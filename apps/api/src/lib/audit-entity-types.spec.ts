/**
 * `AUDIT_ENTITY_TYPES` (`@aeci/shared/audit-entity-types`) covers every
 * `audit_log.entity_type` the API writes (AECI-653).
 *
 * The list feeds the `/admin/audit` entity-type suggestions. It is not an enum
 * and the API never validates against it, so nothing else notices when a new
 * writer adds a value: the suggestion is just missing, and the operator has to
 * know the exact string. This spec reads module SOURCE, in the style of
 * `routes/audit-vendor-id-writers.spec.ts`, and fails when a literal the API
 * writes is not on the list.
 *
 * It finds three forms:
 *  1. `entityType: 'value'`, the `auditInsert` entry literal.
 *  2. A ternary's branches on an `entityType:` line, so
 *     `entityType: evidenced ? 'connector_evidenced_pair' : 'integration'` counts
 *     both values and skips the literal in its condition.
 *  3. `const SOMETHING_ENTITY_TYPE = 'value'`, the named constant some writers
 *     pass instead of a literal.
 *
 * A value built any other way is invisible here. List it by hand.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { AUDIT_ENTITY_TYPES } from '@aeci/shared/audit-entity-types';
import { describe, expect, it } from 'vitest';

/** Vitest runs with cwd = apps/api. */
const SRC = join(process.cwd(), 'src');

/** Every `.ts` under `src/`, excluding specs and the test harness. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'test') continue;
      sourceFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
    acc.push(full);
  }
  return acc;
}

/** `value` → the first `path:line` that writes it. */
function writtenEntityTypes(): Map<string, string> {
  const found = new Map<string, string>();
  const note = (value: string, file: string, line: number) => {
    if (!found.has(value)) found.set(value, `${file.slice(SRC.length + 1)}:${line}`);
  };
  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (/\bentityType: /.test(text)) {
        // A value sits after `entityType:` or a ternary's `?` / `:`. A literal
        // after `===` is the condition (`anchor === 'evidenced_pair'`), not a value.
        const rhs = text.slice(text.indexOf('entityType: '));
        for (const m of rhs.matchAll(/(?:entityType:|\?|:)\s*'([a-z][a-z_]*)'/g)) {
          note(m[1]!, file, i + 1);
        }
      }
      for (const m of text.matchAll(/const \w+_ENTITY_TYPE(?::[^=]+)? = '([a-z][a-z_]*)'/g)) {
        note(m[1]!, file, i + 1);
      }
    });
  }
  return found;
}

describe('AUDIT_ENTITY_TYPES covers every audit_log.entity_type the API writes', () => {
  const written = writtenEntityTypes();

  it('finds the writers, so a broken scan cannot pass vacuously', () => {
    for (const value of ['vendor', 'product', 'integration', 'connector_evidenced_pair']) {
      expect(written.has(value), value).toBe(true);
    }
    // Form 3: written only through a named constant.
    expect(written.has('review_response')).toBe(true);
  });

  it('lists every written value', () => {
    const missing = [...written]
      .filter(([value]) => !AUDIT_ENTITY_TYPES.includes(value))
      .map(([value, at]) => `${value} (first written at ${at})`);
    expect(missing, 'add these to packages/shared/src/audit-entity-types.ts').toEqual([]);
  });
});
