import { describe, expect, it } from 'vitest';
import { haspopupMismatch } from './popup-roles';
import {
  candidateTabStops,
  diffCandidates,
  isLastCandidate,
  parseTabindex,
  type ElementFacts,
} from './tab-candidates';

// AECI-1877: the candidate half of the checklist §5 method. The walk is the
// evidence, so a wrong prediction here shows up as a false diff in the nightly.
// These pin the rules the prediction encodes.

let nextKey = 1;
function el(overrides: Partial<ElementFacts> = {}): ElementFacts {
  return {
    key: nextKey++,
    tag: 'a',
    label: 'a',
    nativelyFocusable: true,
    tabindexAttr: null,
    rendered: true,
    visible: true,
    inert: false,
    disabled: false,
    ariaHidden: false,
    radio: null,
    scroller: false,
    hasFocusableDescendant: false,
    ...overrides,
  };
}

const keys = (list: readonly ElementFacts[]) => list.map((e) => e.key);

describe('parseTabindex', () => {
  it('reads a leading integer the way HTML does', () => {
    expect(parseTabindex(null)).toBeNull();
    expect(parseTabindex('0')).toBe(0);
    expect(parseTabindex(' -1')).toBe(-1);
    expect(parseTabindex('+3')).toBe(3);
    expect(parseTabindex('2px')).toBe(2);
    expect(parseTabindex('')).toBeNull();
    expect(parseTabindex('abc')).toBeNull();
  });
});

describe('candidateTabStops', () => {
  it('keeps natively focusable elements in document order', () => {
    const a = el();
    const b = el({ tag: 'button' });
    expect(keys(candidateTabStops([a, b]))).toEqual([a.key, b.key]);
  });

  it('drops what is not rendered, hidden, inert or disabled', () => {
    const list = [
      el({ rendered: false }),
      el({ visible: false }),
      el({ inert: true }),
      el({ disabled: true }),
    ];
    expect(candidateTabStops(list)).toEqual([]);
  });

  it('keeps an aria-hidden element: Tab still reaches it, which the diff reports', () => {
    const hidden = el({ ariaHidden: true });
    expect(keys(candidateTabStops([hidden]))).toEqual([hidden.key]);
  });

  it('drops a negative tabindex, adds a non-native element with tabindex 0', () => {
    const minus = el({ tabindexAttr: '-1' });
    const div = el({ tag: 'div', nativelyFocusable: false, tabindexAttr: '0' });
    const plain = el({ tag: 'div', nativelyFocusable: false });
    expect(keys(candidateTabStops([minus, div, plain]))).toEqual([div.key]);
  });

  it('puts positive tabindex first, ascending, and stable within a value', () => {
    const zero = el();
    const two = el({ tabindexAttr: '2' });
    const oneA = el({ tabindexAttr: '1' });
    const oneB = el({ tabindexAttr: '1' });
    expect(keys(candidateTabStops([zero, two, oneA, oneB]))).toEqual([
      oneA.key,
      oneB.key,
      two.key,
      zero.key,
    ]);
  });

  it('keeps one radio per group: the checked one, else the first', () => {
    const r1 = el({ tag: 'input', radio: { group: 'f|size', checked: false } });
    const r2 = el({ tag: 'input', radio: { group: 'f|size', checked: true } });
    const r3 = el({ tag: 'input', radio: { group: 'f|size', checked: false } });
    const s1 = el({ tag: 'input', radio: { group: 'f|plan', checked: false } });
    const s2 = el({ tag: 'input', radio: { group: 'f|plan', checked: false } });
    expect(keys(candidateTabStops([r1, r2, r3, s1, s2]))).toEqual([r2.key, s1.key]);
  });

  it('a disabled checked radio does not hide the group', () => {
    const r1 = el({ tag: 'input', radio: { group: 'g', checked: true }, disabled: true });
    const r2 = el({ tag: 'input', radio: { group: 'g', checked: false } });
    expect(keys(candidateTabStops([r1, r2]))).toEqual([r2.key]);
  });

  it('adds a scroller with focusable content too, as Firefox does (AECI-1885)', () => {
    const withLinks = el({
      tag: 'div',
      nativelyFocusable: false,
      scroller: true,
      hasFocusableDescendant: true,
    });
    expect(keys(candidateTabStops([withLinks], { scrollersWithFocusableContent: true }))).toEqual([
      withLinks.key,
    ]);
    // Only while scrollers are stops at all, as in WebKit they are not.
    expect(
      candidateTabStops([withLinks], {
        keyboardFocusableScrollers: false,
        scrollersWithFocusableContent: true,
      }),
    ).toEqual([]);
  });

  it('adds a scroller with no focusable content, in Chromium only', () => {
    const scroller = el({ tag: 'div', nativelyFocusable: false, scroller: true });
    const withLinks = el({
      tag: 'div',
      nativelyFocusable: false,
      scroller: true,
      hasFocusableDescendant: true,
    });
    expect(keys(candidateTabStops([scroller, withLinks]))).toEqual([scroller.key]);
    expect(candidateTabStops([scroller], { keyboardFocusableScrollers: false })).toEqual([]);
  });
});

describe('diffCandidates', () => {
  it('reports never reached, unexpected, and hidden stops', () => {
    const a = el();
    const b = el();
    const c = el();
    const walk = [
      { key: a.key, ariaHidden: false, visible: true },
      { key: 999, ariaHidden: false, visible: true },
      { key: c.key, ariaHidden: true, visible: true },
    ];
    const diff = diffCandidates([a, b, c], walk);
    expect(keys(diff.neverReached)).toEqual([b.key]);
    expect(diff.unexpected.map((s) => s.key)).toEqual([999]);
    expect(diff.focusableButHidden.map((s) => s.key)).toEqual([c.key]);
  });

  it('is empty when the walk matches the prediction', () => {
    const a = el();
    const diff = diffCandidates([a], [{ key: a.key, ariaHidden: false, visible: true }]);
    expect(diff).toEqual({ neverReached: [], unexpected: [], focusableButHidden: [] });
  });

  it('counts a stop with no box as hidden', () => {
    const a = el();
    const diff = diffCandidates([a], [{ key: a.key, ariaHidden: false, visible: false }]);
    expect(diff.focusableButHidden).toHaveLength(1);
  });
});

describe('haspopupMismatch', () => {
  it('accepts a popup whose role matches', () => {
    expect(haspopupMismatch('true', ['menu'])).toBeNull();
    expect(haspopupMismatch('dialog', ['alertdialog'])).toBeNull();
    expect(haspopupMismatch('listbox', ['listbox'])).toBeNull();
  });

  it('does not judge a trigger that controls nothing, or says false', () => {
    expect(haspopupMismatch('true', null)).toBeNull();
    expect(haspopupMismatch('false', ['region'])).toBeNull();
  });

  it('reports a menu promise over a panel with no menu role', () => {
    expect(haspopupMismatch('true', [null])).toBe(
      'aria-haspopup="true" promises a menu, but the popup it controls has no role',
    );
    expect(haspopupMismatch('menu', ['region'])).toMatch(/promises a menu/);
  });

  it('reports a value ARIA does not define', () => {
    expect(haspopupMismatch('yes', ['menu'])).toBe('aria-haspopup="yes" is not a valid value');
  });
});

describe('isLastCandidate', () => {
  // AECI-1885: in Playwright Firefox, Tab leaves focus where it is on the last
  // stop. Only that stop may pass for the end of the page. A stop in the middle
  // that Tab cannot leave is a forward-only trap, even when Shift+Tab leaves it.
  it('takes only the last predicted stop for the end of the page', () => {
    const first = el();
    const trap = el();
    const last = el();
    const hidden = el({ rendered: false });
    const facts = [first, trap, last, hidden];
    expect(isLastCandidate(last.key, facts)).toBe(true);
    expect(isLastCandidate(trap.key, facts)).toBe(false);
    expect(isLastCandidate(hidden.key, facts)).toBe(false);
    expect(isLastCandidate(first.key, [])).toBe(false);
  });

  it('reads the order the walk takes: positive tabindex first, then the rest', () => {
    const early = el({ tabindexAttr: '1' });
    const later = el();
    expect(isLastCandidate(later.key, [later, early])).toBe(true);
    expect(isLastCandidate(early.key, [later, early])).toBe(false);
  });

  it('uses the browser scroller rules', () => {
    const link = el();
    const scroller = el({ tag: 'div', nativelyFocusable: false, scroller: true });
    expect(isLastCandidate(scroller.key, [link, scroller])).toBe(true);
    expect(isLastCandidate(link.key, [link, scroller], { keyboardFocusableScrollers: false })).toBe(
      true,
    );
  });
});
