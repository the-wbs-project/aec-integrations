import { describe, expect, it } from 'vitest';

import { TIERS } from '../entitlements';
import { EntitlementTermDateSchema, EntitlementTierSchema } from './admin-entitlements';

describe('EntitlementTierSchema', () => {
  it('derives its tier enum from the registry, so a new rung needs no schema edit', () => {
    expect(EntitlementTierSchema.options).toEqual([...TIERS]);
  });
});

describe('EntitlementTermDateSchema', () => {
  it('accepts a date-only value and a full ISO timestamp', () => {
    expect(EntitlementTermDateSchema.safeParse('2027-09-01').success).toBe(true);
    expect(EntitlementTermDateSchema.safeParse('2027-09-01T00:00:00.000Z').success).toBe(true);
  });

  it('rejects a malformed term boundary', () => {
    expect(EntitlementTermDateSchema.safeParse('next year').success).toBe(false);
  });
});
