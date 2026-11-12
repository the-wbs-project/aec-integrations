/**
 * `scripts/legal-upcoming-overdue.mjs` (AECI-1689): the non-blocking reminder that a
 * bump-day cleanup is overdue. Runs under `node --test` from root `pnpm test:scripts`.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  MANIFEST,
  effectiveMomentMs,
  main,
  overdueEntries,
  upcomingEntries,
  warningLines,
} from './legal-upcoming-overdue.mjs';

const SOURCE = `
export const LEGAL_UPCOMING: readonly LegalUpcomingEntry[] = [
  { slug: 'vendor-terms', version: '1.4', effectiveOn: '2027-03-31' },
  {
    slug: 'privacy',
    effectiveOn: '2027-04-30',
    version: '1.2',
  },
];
`;

test('reads the entries in any field order', () => {
  assert.deepEqual(upcomingEntries(SOURCE), [
    { slug: 'vendor-terms', version: '1.4', effectiveOn: '2027-03-31' },
    { slug: 'privacy', version: '1.2', effectiveOn: '2027-04-30' },
  ]);
});

test('the real manifest parses, and holds what the shared maps mirror', () => {
  assert.ok(Array.isArray(upcomingEntries(readFileSync(MANIFEST, 'utf8'))));
});

test('overdue only beyond 14 days past 12:00 UTC of the day', () => {
  const at = effectiveMomentMs('2027-03-31');
  assert.equal(at, Date.UTC(2027, 2, 31, 12));
  const entries = upcomingEntries(SOURCE);
  assert.deepEqual(overdueEntries(entries, at + 14 * 86_400_000), []);
  assert.deepEqual(
    overdueEntries(entries, at + 14 * 86_400_000 + 1).map((e) => e.slug),
    ['vendor-terms'],
  );
  assert.match(warningLines(overdueEntries(entries, at + 15 * 86_400_000))[0], /^::warning /);
});

test('always exits 0, even when it cannot read the manifest', () => {
  const logs = [];
  assert.equal(
    main(
      Date.UTC(2099, 0, 1),
      (l) => logs.push(l),
      () => SOURCE,
    ),
    0,
  );
  assert.equal(logs.length, 2);
  assert.equal(
    main(
      0,
      (l) => logs.push(l),
      () => {
        throw new Error('missing');
      },
    ),
    0,
  );
  assert.match(logs.at(-1), /::warning title=Legal bump check::missing/);
});
