import { describe, expect, it, vi } from 'vitest';

import { appendAuditLog, type AuditLogClient, type AuditLogEntry } from './audit-log';

function fakeDb(): { db: AuditLogClient; created: Record<string, unknown>[] } {
  const created: Record<string, unknown>[] = [];
  const db: AuditLogClient = {
    auditLog: {
      create: async ({ data }) => {
        created.push(data);
        return data;
      },
    },
  };
  return { db, created };
}

const SYSTEM_CREATE: AuditLogEntry = {
  actorType: 'system',
  action: 'product.created',
  entityType: 'product',
  entityId: '11111111-1111-1111-1111-111111111111',
};

describe('appendAuditLog', () => {
  it('writes a row with the entry fields', async () => {
    const { db, created } = fakeDb();

    await appendAuditLog(db, SYSTEM_CREATE);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      actorType: 'system',
      action: 'product.created',
      entityType: 'product',
      entityId: '11111111-1111-1111-1111-111111111111',
    });
  });

  it('defaults a missing actorId to null (system/anonymous)', async () => {
    const { db, created } = fakeDb();

    await appendAuditLog(db, SYSTEM_CREATE);

    expect(created[0].actorId).toBeNull();
  });

  it('omits Json columns when unset (so Prisma stores DB NULL, not invalid null)', async () => {
    const { db, created } = fakeDb();

    await appendAuditLog(db, SYSTEM_CREATE);

    expect(created[0].beforeState).toBeUndefined();
    expect(created[0].afterState).toBeUndefined();
    expect(created[0].metadata).toBeUndefined();
  });

  it('passes through before/after/metadata when provided', async () => {
    const { db, created } = fakeDb();

    await appendAuditLog(db, {
      actorType: 'admin',
      action: 'product.updated',
      entityType: 'product',
      entityId: 'abc',
      beforeState: { slug: 'old' },
      afterState: { slug: 'new' },
      metadata: { source: 'migration' },
    });

    expect(created[0]).toMatchObject({
      beforeState: { slug: 'old' },
      afterState: { slug: 'new' },
      metadata: { source: 'migration' },
    });
  });

  it('forwards the entry when a forwarder is supplied', async () => {
    const { db } = fakeDb();
    const forward = vi.fn();

    await appendAuditLog(db, SYSTEM_CREATE, forward);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(SYSTEM_CREATE);
  });

  it('swallows a forwarder rejection — the audit write still succeeds', async () => {
    const { db, created } = fakeDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forward = vi.fn().mockRejectedValue(new Error('datadog down'));

    await expect(appendAuditLog(db, SYSTEM_CREATE, forward)).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('propagates a DB write failure (rolls the caller transaction back)', async () => {
    const db: AuditLogClient = {
      auditLog: { create: () => Promise.reject(new Error('insert failed')) },
    };

    await expect(appendAuditLog(db, SYSTEM_CREATE)).rejects.toThrow('insert failed');
  });
});
