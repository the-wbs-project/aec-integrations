import { describe, expect, it } from 'vitest';

import { liveIntegrationSql, retiredIntegrationSql } from './live-integration';

describe('live-integration predicate, raw-SQL form (AECI-1010)', () => {
  it('is IS NULL on the aliased column, never = NULL', () => {
    expect(liveIntegrationSql('i')).toBe('i."retired_at" IS NULL');
    expect(liveIntegrationSql('i')).not.toMatch(/=\s*NULL/i);
  });

  it('has an exact complement', () => {
    expect(retiredIntegrationSql('bi')).toBe('bi."retired_at" IS NOT NULL');
  });
});
