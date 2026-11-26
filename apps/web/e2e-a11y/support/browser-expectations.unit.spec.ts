import { describe, expect, it } from 'vitest';
import {
  A11Y_BROWSERS,
  BROWSER_EXPECTATIONS,
  expected,
  isA11yBrowser,
  notInProject,
  notInTags,
} from './browser-expectations';
import { candidateTabStops, type ElementFacts } from './tab-candidates';

// AECI-1885, ADR 0060 "How differences are handled" 2: an entry for Firefox or
// WebKit can never change what Chromium checks. These pin every Chromium value
// to the one the suites used before the lane existed. A change here is a change
// to the Chromium suites, and needs its own reason.

describe('browser expectations', () => {
  // Every entry's Chromium value, as the suites behaved before AECI-1885. The
  // next test fails when an entry is added without a line here.
  const CHROMIUM_PINNED: Record<keyof typeof BROWSER_EXPECTATIONS, unknown> = {
    sequentialKeys: { forward: 'Tab', backward: 'Shift+Tab' },
    keyboardFocusableScrollers: true,
    // The walk's old rule: a press that leaves focus in place is a trap.
    sequentialFocusWraps: true,
    scrollersWithFocusableContent: false,
    // The announcement flows click, as they always did.
    pointerFocusesButtons: true,
  };

  it('keeps every Chromium value as the suites had it before AECI-1885', () => {
    for (const [key, value] of Object.entries(CHROMIUM_PINNED)) {
      expect(expected(key as keyof typeof BROWSER_EXPECTATIONS, 'chromium'), key).toEqual(value);
    }
  });

  it('pins every entry, so a new one cannot land without its Chromium value', () => {
    expect(Object.keys(CHROMIUM_PINNED).sort()).toEqual(Object.keys(BROWSER_EXPECTATIONS).sort());
  });

  it('matches the candidate default for Chromium, so the Chromium prediction is unchanged', () => {
    const emptyScroller: ElementFacts = {
      key: 1,
      tag: 'div',
      label: 'div',
      nativelyFocusable: false,
      tabindexAttr: null,
      rendered: true,
      visible: true,
      inert: false,
      disabled: false,
      ariaHidden: false,
      radio: null,
      scroller: true,
      hasFocusableDescendant: false,
    };
    const byDefault = candidateTabStops([emptyScroller]);
    const fullScroller: ElementFacts = { ...emptyScroller, key: 2, hasFocusableDescendant: true };
    const chromiumOptions = {
      keyboardFocusableScrollers: expected('keyboardFocusableScrollers', 'chromium'),
      scrollersWithFocusableContent: expected('scrollersWithFocusableContent', 'chromium'),
    };
    expect(candidateTabStops([emptyScroller, fullScroller], chromiumOptions)).toEqual(
      candidateTabStops([emptyScroller, fullScroller]),
    );
    expect(candidateTabStops([emptyScroller, fullScroller])).toEqual(byDefault);
  });

  it('gives every entry a value, a reason and a source for each of the three browsers', () => {
    for (const [key, perBrowser] of Object.entries(BROWSER_EXPECTATIONS)) {
      expect(Object.keys(perBrowser).sort(), key).toEqual([...A11Y_BROWSERS].sort());
      for (const browser of A11Y_BROWSERS) {
        const entry = perBrowser[browser];
        expect(entry.value, `${key} ${browser}`).not.toBeUndefined();
        expect(entry.reason.length, `${key} ${browser} reason`).toBeGreaterThan(20);
        expect(entry.source.length, `${key} ${browser} source`).toBeGreaterThan(5);
        expect(`${entry.reason} ${entry.source}`, `${key} ${browser}`).not.toMatch(/PLACEHOLDER/);
      }
    }
  });

  it('tags a barrier test out of every browser it is not found in, and nothing out of Chromium by default', () => {
    expect(notInTags(['firefox'])).toEqual(['@not-chromium', '@not-webkit']);
    expect(notInTags([...A11Y_BROWSERS])).toEqual([]);
    expect(notInProject('chromium').test('known focus barriers: obscured @not-chromium')).toBe(
      true,
    );
    expect(notInProject('chromium').test('known focus barriers: obscured @not-webkit')).toBe(false);
    expect(notInProject('firefox').test('a plain test title')).toBe(false);
  });

  it('knows the three engines and nothing else', () => {
    expect(isA11yBrowser('chromium')).toBe(true);
    expect(isA11yBrowser('firefox')).toBe(true);
    expect(isA11yBrowser('webkit')).toBe(true);
    expect(isA11yBrowser('chrome')).toBe(false);
    expect(isA11yBrowser(undefined)).toBe(false);
  });
});
