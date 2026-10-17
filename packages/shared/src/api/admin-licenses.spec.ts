/** `EntitlementTermDateSchema`, the license grant and extend term boundary. Moved
 *  from the deleted `admin-entitlements.spec.ts` (AECI-1358). */

import { describe, expect, it } from 'vitest';

import { EntitlementTermDateSchema } from './admin-licenses';

describe('EntitlementTermDateSchema', () => {
  it('accepts a date-only value and a full ISO timestamp', () => {
    expect(EntitlementTermDateSchema.safeParse('2027-09-01').success).toBe(true);
    expect(EntitlementTermDateSchema.safeParse('2027-09-01T00:00:00.000Z').success).toBe(true);
  });

  it('rejects a malformed term boundary', () => {
    expect(EntitlementTermDateSchema.safeParse('next year').success).toBe(false);
  });
});
