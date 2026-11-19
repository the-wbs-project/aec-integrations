import { describe, expect, it } from 'vitest';

import { THREAD_ACK_MATERIAL_SINCE, THREAD_ACK_TEXT_VERSION } from './vendor-threads';

/**
 * AECI-1641: the acknowledgment lookup compares versions as integers in SQL, so a
 * label like "1.1" would sort wrongly and silently skip a re-prompt.
 */
describe('acknowledgment versions', () => {
  it('are positive-integer strings', () => {
    expect(THREAD_ACK_TEXT_VERSION).toMatch(/^[1-9]\d*$/);
    expect(THREAD_ACK_MATERIAL_SINCE).toMatch(/^[1-9]\d*$/);
  });

  it('never marks a version material that the portal does not show yet', () => {
    expect(Number(THREAD_ACK_MATERIAL_SINCE)).toBeLessThanOrEqual(Number(THREAD_ACK_TEXT_VERSION));
  });
});
