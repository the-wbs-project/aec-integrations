import { describe, expect, it, vi } from 'vitest';

import { forwardAuditLog, type AuditLogEntry } from './audit-log';

const SYSTEM_CREATE: AuditLogEntry = {
  actorType: 'system',
  action: 'product.created',
  entityType: 'product',
  entityId: '11111111-1111-1111-1111-111111111111',
};

describe('forwardAuditLog', () => {
  it('forwards the entry when a forwarder is supplied', async () => {
    const forward = vi.fn();

    await forwardAuditLog(SYSTEM_CREATE, forward);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(SYSTEM_CREATE);
  });

  it('is a no-op when no forwarder is supplied', async () => {
    await expect(forwardAuditLog(SYSTEM_CREATE)).resolves.toBeUndefined();
  });

  it('swallows a forwarder rejection — observability availability never blocks a write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forward = vi.fn().mockRejectedValue(new Error('datadog down'));

    await expect(forwardAuditLog(SYSTEM_CREATE, forward)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
