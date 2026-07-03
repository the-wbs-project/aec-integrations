import { describe, expect, it } from 'vitest';

import { resultsBucket, type ResultsBucket } from './search-rum';

/**
 * Pure unit test for the AECI-174 `results_bucket` mapping. Runs under plain-node
 * Vitest (`.spec.ts`, not `.component.spec.ts`) because it needs no Angular. The
 * dynamic-import `emitSearchQuery` is exercised via the controller specs' emit
 * seam, so it's intentionally not unit-tested here (it would load the real SDK).
 */
describe('resultsBucket (AECI-174)', () => {
  const cases: [number, ResultsBucket][] = [
    [0, 'none'],
    [1, '1-5'],
    [5, '1-5'],
    [6, '6-20'],
    [20, '6-20'],
    [21, '21+'],
    [1000, '21+'],
  ];

  for (const [nbHits, bucket] of cases) {
    it(`maps ${nbHits} → ${bucket}`, () => {
      expect(resultsBucket(nbHits)).toBe(bucket);
    });
  }

  it('treats negative counts as none (defensive)', () => {
    expect(resultsBucket(-1)).toBe('none');
  });
});
