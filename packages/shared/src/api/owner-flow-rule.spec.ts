import { describe, expect, it } from 'vitest';

import { countOwnerFlowsAwaitingAnswer, ownerFlowsAwaitingAnswer } from './owner-flow-rule';

const flows = [
  { id: 'a', answer: 'yes' as const },
  { id: 'b', answer: null },
  { id: 'c', answer: 'no' as const },
  { id: 'd', answer: null },
];

describe('ownerFlowsAwaitingAnswer (AECI-2045)', () => {
  it('lists the unanswered flows of an editable row, in order', () => {
    expect(ownerFlowsAwaitingAnswer({ flows_editable: true, flows }).map((f) => f.id)).toEqual([
      'b',
      'd',
    ]);
    expect(countOwnerFlowsAwaitingAnswer({ flows_editable: true, flows })).toBe(2);
  });

  it('counts a No as an answer', () => {
    expect(
      countOwnerFlowsAwaitingAnswer({ flows_editable: true, flows: [{ id: 'x', answer: 'no' }] }),
    ).toBe(0);
  });

  it('counts nothing on a row the owner cannot answer (unclaimed or retired)', () => {
    expect(countOwnerFlowsAwaitingAnswer({ flows_editable: false, flows })).toBe(0);
  });
});
