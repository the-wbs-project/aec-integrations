import { describe, expect, it } from 'vitest';

import { queueFocusAfterRemoval } from './queue-focus';

describe('queueFocusAfterRemoval (AECI-2102)', () => {
  it('leaves focus alone when the decided row was not on screen', () => {
    expect(queueFocusAfterRemoval(-1, 2, 2, ['a', 'b'])).toEqual({ kind: 'none' });
  });

  it('goes to the heading when no row is left', () => {
    expect(queueFocusAfterRemoval(0, 1, 1, [])).toEqual({ kind: 'heading' });
  });

  it('goes to the row that took the decided row’s place', () => {
    expect(queueFocusAfterRemoval(1, 1, 1, ['a', 'c', 'd'])).toEqual({ kind: 'row', row: 'c' });
  });

  it('goes to the new last row when the decided row was last', () => {
    expect(queueFocusAfterRemoval(2, 1, 1, ['a', 'b'])).toEqual({ kind: 'row', row: 'b' });
  });

  it('goes to the last row of the new last page when its page went away', () => {
    // The only row on page 2 was decided: the pager steps back to page 1.
    expect(queueFocusAfterRemoval(0, 2, 1, ['a', 'b', 'c'])).toEqual({ kind: 'row', row: 'c' });
  });
});
