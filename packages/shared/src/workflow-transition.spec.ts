import { describe, expect, it, vi } from 'vitest';

import { forwardWorkflowTransition, type WorkflowTransitionEntry } from './workflow-transition';

const GENESIS: WorkflowTransitionEntry = {
  workflowId: '11111111-1111-1111-1111-111111111111',
  fromState: null,
  toState: 'open',
  reason: 'request submitted',
};

describe('forwardWorkflowTransition', () => {
  it('forwards the entry when a forwarder is supplied', async () => {
    const forward = vi.fn();

    await forwardWorkflowTransition(GENESIS, forward);

    expect(forward).toHaveBeenCalledTimes(1);
    expect(forward).toHaveBeenCalledWith(GENESIS);
  });

  it('is a no-op when no forwarder is supplied', async () => {
    await expect(forwardWorkflowTransition(GENESIS)).resolves.toBeUndefined();
  });

  it('swallows a forwarder rejection — observability availability never blocks a write', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const forward = vi.fn().mockRejectedValue(new Error('datadog down'));

    await expect(forwardWorkflowTransition(GENESIS, forward)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });
});
