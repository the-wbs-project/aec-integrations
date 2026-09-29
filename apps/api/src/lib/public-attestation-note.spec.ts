import { describe, expect, it } from 'vitest';

import * as helpers from './drizzle-helpers';

/**
 * AECI-1139 guard (ruling 2026-09-28: "No notes at all"). No attestation note is
 * reader-facing, so no PUBLIC read may select `attestations.note` from D1.
 *
 * Every public read config lives in `drizzle-helpers.ts`. The vendor and admin
 * reads that legitimately carry the note keep their own configs next to their
 * routes (`routes/vendor-attestations.ts`), so walking this module's exports
 * covers the public surface and nothing else.
 *
 * Two ways a config could leak the note, and this test fails on both:
 * - an `attestations` relation whose `columns` list includes `note`;
 * - an `attestations` relation with NO `columns` list, which Drizzle reads as
 *   "select every column", note included.
 */

type Json = Record<string, unknown>;

/** Every `attestations` relation block reachable from `value`, with its path. */
function attestationBlocks(
  value: unknown,
  path: string,
  seen = new Set<unknown>(),
): [string, Json][] {
  if (value === null || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const out: [string, Json][] = [];
  for (const [key, child] of Object.entries(value as Json)) {
    if (key === 'attestations' && child !== null && typeof child === 'object') {
      out.push([`${path}.${key}`, child as Json]);
    }
    out.push(...attestationBlocks(child, `${path}.${key}`, seen));
  }
  return out;
}

const blocks = Object.entries(helpers).flatMap(([name, value]) =>
  typeof value === 'object' ? attestationBlocks(value, name) : [],
);

describe('public read configs never select attestations.note (AECI-1139)', () => {
  it('finds the public pair and timeline configs, so the walk is not vacuous', () => {
    const paths = blocks.map(([path]) => path.split('.')[0]);
    for (const name of [
      'integrationPairConfig',
      'connectorEvidencedPairPairConfig',
      'integrationTimelineConfig',
      'connectorEvidencedPairTimelineConfig',
    ]) {
      expect(paths).toContain(name);
    }
  });

  it.each(blocks)('%s has an explicit column list without `note`', (_path, block) => {
    const columns = block.columns as Json | undefined;
    expect(columns, 'no column list selects every column, note included').toBeDefined();
    expect(Object.keys(columns!)).not.toContain('note');
  });
});
