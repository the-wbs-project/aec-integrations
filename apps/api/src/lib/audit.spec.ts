/**
 * `auditInsert` mints the row id onto the caller's entry (AECI-1184).
 *
 * The recrawl cause linkage reads `entry.id` after the batch commits, so the id
 * must be on the caller's own object, must be the id the row was inserted under,
 * and must not be replaced when the caller already chose one.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { auditLog } from '../db/schema';
import { makeTestDb, type TestDb } from '../test/d1';

import { auditInsert, type BatchTuple } from './audit';

let t: TestDb;
beforeEach(async () => {
  t = await makeTestDb();
});
afterEach(() => t.dispose());

describe('auditInsert id stamping', () => {
  it('stamps a UUID onto the entry, and the row is inserted under it', async () => {
    const entry: AuditLogEntry = { actorType: 'system', action: 'product.updated' };
    const stmt = auditInsert(t.db, entry);
    expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    await t.db.batch([stmt] as BatchTuple);
    const rows = await t.db.select({ id: auditLog.id }).from(auditLog);
    expect(rows).toEqual([{ id: entry.id }]);
  });

  it('keeps a caller-supplied id', async () => {
    const entry: AuditLogEntry = {
      id: '11111111-1111-4111-8111-111111111111',
      actorType: 'system',
      action: 'product.updated',
    };
    await t.db.batch([auditInsert(t.db, entry)] as BatchTuple);
    expect(entry.id).toBe('11111111-1111-4111-8111-111111111111');
    const rows = await t.db.select({ id: auditLog.id }).from(auditLog);
    expect(rows).toEqual([{ id: entry.id }]);
  });

  it('gives distinct entries distinct ids', () => {
    const entries: AuditLogEntry[] = [
      { actorType: 'system', action: 'a' },
      { actorType: 'system', action: 'b' },
    ];
    for (const entry of entries) auditInsert(t.db, entry);
    expect(entries[0]!.id).not.toBe(entries[1]!.id);
  });

  it('a copy spread after stamping carries the same id', () => {
    const entry: AuditLogEntry = { actorType: 'system', action: 'a' };
    auditInsert(t.db, entry);
    expect({ ...entry, metadata: { x: 1 } }.id).toBe(entry.id);
  });
});
