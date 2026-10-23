import { describe, expect, it } from 'vitest';

import {
  AdminAuditLogQuerySchema,
  AdminAuditLogResponseSchema,
  decodeAuditCursor,
  encodeAuditCursor,
} from './admin-audit';

const UUID = '44444444-4444-4444-8444-444444444444';

const issuePaths = (input: Record<string, string>) => {
  const result = AdminAuditLogQuerySchema.safeParse(input);
  return result.success ? [] : [...new Set(result.error.issues.map((i) => i.path.join('.')))];
};

/** AECI-653: the global audit-log filter contract. */
describe('AdminAuditLogQuerySchema', () => {
  it('defaults to 25 rows, newest first, counted, with no filters', () => {
    expect(AdminAuditLogQuerySchema.parse({})).toEqual({ perPage: 25, order: 'desc', count: 1 });
  });

  it('drops blank and whitespace-only values, as a form submits them', () => {
    expect(
      AdminAuditLogQuerySchema.parse({ action: '', entity_type: '  ', actor_type: '', to: '' }),
    ).toEqual({ perPage: 25, order: 'desc', count: 1 });
  });

  it('trims a filter value', () => {
    expect(AdminAuditLogQuerySchema.parse({ action: ' vendor.updated ' }).action).toBe(
      'vendor.updated',
    );
  });

  it('accepts entity_type with entity_id, and actor_type beside any other constraint', () => {
    expect(issuePaths({ entity_type: 'vendor', entity_id: 'x' })).toEqual([]);
    expect(issuePaths({ actor_type: 'system', from: '2026-10-01' })).toEqual([]);
    expect(issuePaths({ actor_type: 'system', to: '2026-10-01' })).toEqual([]);
    expect(issuePaths({ actor_type: 'system', action: 'vendor.updated' })).toEqual([]);
    expect(issuePaths({ actor_type: 'system', actor_id: UUID })).toEqual([]);
    expect(issuePaths({ actor_type: 'system', entity_type: 'vendor' })).toEqual([]);
  });

  it('refuses entity_id without entity_type, on entity_id', () => {
    expect(issuePaths({ entity_id: 'x' })).toEqual(['entity_id']);
  });

  it('refuses actor_type as the only constraint, on actor_type', () => {
    expect(issuePaths({ actor_type: 'system' })).toEqual(['actor_type']);
    expect(issuePaths({ actor_type: 'system', perPage: '50', order: 'asc' })).toEqual([
      'actor_type',
    ]);
  });

  it('refuses from after to, on from', () => {
    expect(issuePaths({ from: '2026-10-05', to: '2026-10-01' })).toEqual(['from']);
    expect(issuePaths({ from: '2026-10-01', to: '2026-10-01' })).toEqual([]);
  });

  it('refuses a malformed or impossible day', () => {
    expect(issuePaths({ from: '2026/10/01' })).toEqual(['from']);
    expect(issuePaths({ to: '2026-02-31' })).toEqual(['to']);
  });

  it('refuses a non-uuid actor_id and an unknown actor_type', () => {
    expect(issuePaths({ actor_id: 'someone@example.com' })).toEqual(['actor_id']);
    expect(issuePaths({ actor_type: 'robot', from: '2026-10-01' })).toEqual(['actor_type']);
  });

  it('accepts perPage 25, 50 and 100 only', () => {
    expect(AdminAuditLogQuerySchema.parse({ perPage: '50' }).perPage).toBe(50);
    expect(AdminAuditLogQuerySchema.parse({ perPage: '100' }).perPage).toBe(100);
    expect(issuePaths({ perPage: '30' })).toEqual(['perPage']);
    expect(issuePaths({ perPage: '24' })).toEqual(['perPage']);
    expect(issuePaths({ perPage: '101' })).toEqual(['perPage']);
  });

  it('accepts order asc and desc, and count 0 and 1', () => {
    expect(AdminAuditLogQuerySchema.parse({ order: 'asc', count: '0' })).toMatchObject({
      order: 'asc',
      count: 0,
    });
    expect(issuePaths({ order: 'up' })).toEqual(['order']);
    expect(issuePaths({ count: '2' })).toEqual(['count']);
  });

  it('parses after and before into a cursor, and refuses both together, on before', () => {
    const raw = encodeAuditCursor(CURSOR);
    expect(AdminAuditLogQuerySchema.parse({ after: raw }).after).toEqual(CURSOR);
    expect(AdminAuditLogQuerySchema.parse({ before: raw }).before).toEqual(CURSOR);
    expect(issuePaths({ after: raw, before: raw })).toEqual(['before']);
  });

  it('refuses a malformed cursor', () => {
    expect(issuePaths({ after: 'nonsense' })).toEqual(['after']);
    expect(issuePaths({ before: `${CURSOR.createdAt}|not-a-uuid` })).toEqual(['before']);
  });
});

const CURSOR = { createdAt: '2026-10-05T12:00:00.000Z', id: UUID };

/** ADR 0046: the keyset cursor grammar `"<created_at>|<id>"`. */
describe('encodeAuditCursor / decodeAuditCursor', () => {
  it('round-trips a row position', () => {
    const raw = encodeAuditCursor(CURSOR);
    expect(raw).toBe(`2026-10-05T12:00:00.000Z|${UUID}`);
    expect(decodeAuditCursor(raw)).toEqual(CURSOR);
  });

  it('splits on the last pipe, so the id is always the trailing uuid', () => {
    expect(decodeAuditCursor(`a|b|${UUID}`)).toEqual({ createdAt: 'a|b', id: UUID });
  });

  it('returns null for a malformed cursor', () => {
    for (const raw of [
      '',
      'no-pipe',
      `|${UUID}`,
      ` |${UUID}`,
      '2026-10-05T12:00:00.000Z|',
      '2026-10-05T12:00:00.000Z|not-a-uuid',
      `${'x'.repeat(41)}|${UUID}`,
    ]) {
      expect(decodeAuditCursor(raw), raw).toBeNull();
    }
  });
});

describe('AdminAuditLogResponseSchema', () => {
  const base = {
    data: [],
    perPage: 25,
    has_next: false,
    has_prev: false,
    next_cursor: null,
    prev_cursor: null,
    actor_emails_available: true,
  };

  it('accepts a counted page and an uncounted one', () => {
    expect(AdminAuditLogResponseSchema.safeParse({ ...base, total: 0 }).success).toBe(true);
    expect(AdminAuditLogResponseSchema.safeParse({ ...base, total: null }).success).toBe(true);
  });

  it('has no page number', () => {
    expect(AdminAuditLogResponseSchema.parse({ ...base, total: 3, page: 2 })).not.toHaveProperty(
      'page',
    );
  });
});
