/**
 * AECI-1885 (ADR 0060): what differs between the nightly's three browsers by design.
 *
 * The keyboard, focus ring and announcement suites run in Chromium, and in
 * Playwright's own Firefox and WebKit builds. Where an engine differs on purpose,
 * the difference is one entry here, keyed by browser, with the reason and a
 * source. A spec reads the value for the browser it runs in. Nothing here may
 * change what Chromium checks: `browser-expectations.unit.spec.ts` pins every
 * Chromium value to the one the suites used before this lane existed.
 *
 * A real barrier in one browser is not an expectation. It is a Linear issue and
 * a `knownFailure` mark narrowed to that browser (`browsers` on the barrier
 * tables). A harness problem is fixed in the harness.
 *
 * Pure apart from `browserOf`, which reads the browser off a page.
 * `docs/TESTING_STRATEGY.md` §8.4.10 lists every entry.
 */
import type { Page } from '@playwright/test';

export const A11Y_BROWSERS = ['chromium', 'firefox', 'webkit'] as const;
export type A11yBrowser = (typeof A11Y_BROWSERS)[number];

export interface Expectation<T> {
  readonly value: T;
  /** Why this engine behaves this way. */
  readonly reason: string;
  /** The spec, engine source or bug the reason rests on. */
  readonly source: string;
}

export type PerBrowser<T> = { readonly [B in A11yBrowser]: Expectation<T> };

/** The key that moves focus forward and backward through the page's Tab stops. */
export interface SequentialKeys {
  readonly forward: string;
  readonly backward: string;
}

export const BROWSER_EXPECTATIONS: {
  readonly sequentialKeys: PerBrowser<SequentialKeys>;
  readonly keyboardFocusableScrollers: PerBrowser<boolean>;
  readonly sequentialFocusWraps: PerBrowser<boolean>;
  readonly scrollersWithFocusableContent: PerBrowser<boolean>;
  readonly pointerFocusesButtons: PerBrowser<boolean>;
} = {
  sequentialKeys: {
    chromium: {
      value: { forward: 'Tab', backward: 'Shift+Tab' },
      reason: 'Tab reaches every focusable element, links included.',
      source: 'HTML sequential focus navigation',
    },
    firefox: {
      value: { forward: 'Tab', backward: 'Shift+Tab' },
      reason:
        'Tab reaches every focusable element, links included. Playwright runs Firefox with ' +
        'tabbing to every element on, whatever the system setting.',
      source: 'Measured 2026-11-26 (AECI-1885): a Tab walk of home reaches the links',
    },
    webkit: {
      value: { forward: 'Alt+Tab', backward: 'Alt+Shift+Tab' },
      reason:
        "Safari's rule: Tab skips links and buttons unless 'Press Tab to highlight each item' " +
        'is on, and Option+Tab reaches every item. Playwright WebKit on macOS follows that ' +
        'rule. A plain Tab walk of home reached only the two text fields. Option+Tab gave the ' +
        'same order as Firefox. The walk is what a Safari user who presses Option+Tab, or has ' +
        'the setting on, meets. It does not test the default setting. Whether Linux WebKit ' +
        'treats Option+Tab as Tab is not measured yet: the first CI run shows it.',
      source: 'Measured 2026-11-26 (AECI-1885) on home, macOS WebKit 27.2',
    },
  },
  sequentialFocusWraps: {
    chromium: {
      value: true,
      reason:
        'Tab past the last stop moves focus to the document, and the next Tab to the first stop. ' +
        'The walk closes its cycle that way.',
      source: 'Measured 2026-11-26 (AECI-1885) on a page of two buttons and a link',
    },
    firefox: {
      value: false,
      reason:
        'In Playwright Firefox, Tab on the last stop leaves focus there, and Shift+Tab on the ' +
        'first stop leaves it there too. Real Firefox moves focus to its own toolbar, which ' +
        'Playwright does not draw. So the walk confirms the end with Shift+Tab, which must move ' +
        'focus, and walks back to the first stop. A stop that neither key leaves is still a trap.',
      source: 'Measured 2026-11-26 (AECI-1885) on a page of two buttons and a link',
    },
    webkit: {
      value: true,
      reason: 'As Chromium: Tab past the last stop goes to the document, then wraps.',
      source: 'Measured 2026-11-26 (AECI-1885) on a page of two buttons and a link',
    },
  },
  keyboardFocusableScrollers: {
    chromium: {
      value: true,
      reason:
        'Since Chrome 130 a scroll container with no focusable content is a Tab stop of its own.',
      source: 'https://developer.chrome.com/blog/keyboard-focusable-scrollers',
    },
    firefox: {
      value: true,
      reason:
        'Firefox makes a scroll container a Tab stop, so an empty one is a stop as in Chromium. ' +
        'The ADR guessed otherwise.',
      source: 'Measured 2026-11-26 (AECI-1885) on a page with an empty scroll container',
    },
    webkit: {
      value: false,
      reason: 'WebKit never makes a scroll container a Tab stop, empty or not.',
      source: 'Measured 2026-11-26 (AECI-1885) on a page with an empty scroll container',
    },
  },
  pointerFocusesButtons: {
    chromium: {
      value: true,
      reason:
        'A click on a button focuses it, so focus returns to it when a dialog it opened closes.',
      source: 'HTML focus fixup; measured 2026-11-26 (AECI-1885) on /auth/login',
    },
    firefox: {
      value: true,
      reason: 'As Chromium: a click on a button focuses it.',
      source: 'Measured 2026-11-26 (AECI-1885) on /auth/login',
    },
    webkit: {
      value: false,
      reason:
        'A click does not focus a button, as in Safari. Focus goes to the nearest focusable ' +
        'ancestor, `main` with tabindex -1, so a dialog gives focus back to `main` and the record ' +
        'hears all of `main`. The announcement flows that judge focus reach the button by Tab ' +
        'and press Enter there, as a keyboard or screen-reader user does.',
      source: 'Measured 2026-11-26 (AECI-1885) on /auth/login, macOS WebKit 27.2',
    },
  },
  scrollersWithFocusableContent: {
    chromium: {
      value: false,
      reason:
        'A scroll container with a focusable element inside is not a stop: Tab goes to the element.',
      source: 'https://developer.chrome.com/blog/keyboard-focusable-scrollers',
    },
    firefox: {
      value: true,
      reason:
        'Firefox stops on the scroll container itself, then on the elements inside it, even when ' +
        'it holds a link. The account page review list is one.',
      source: 'Measured 2026-11-26 (AECI-1885) on a page with a scroll container holding a link',
    },
    webkit: {
      value: false,
      reason: 'WebKit makes no scroll container a stop (keyboardFocusableScrollers is off).',
      source: 'Measured 2026-11-26 (AECI-1885) on a page with a scroll container holding a link',
    },
  },
};

export function isA11yBrowser(name: string | undefined | null): name is A11yBrowser {
  return (A11Y_BROWSERS as readonly string[]).includes(name ?? '');
}

/** The value of one expectation for one browser. */
export function expected<K extends keyof typeof BROWSER_EXPECTATIONS>(
  key: K,
  browser: A11yBrowser,
): (typeof BROWSER_EXPECTATIONS)[K][A11yBrowser]['value'] {
  return BROWSER_EXPECTATIONS[key][browser].value;
}

/** The browser engine a page runs in. Throws on an engine this lane does not know. */
export function browserOf(page: Page): A11yBrowser {
  const name = page.context().browser()?.browserType().name();
  if (!isA11yBrowser(name)) throw new Error(`the a11y nightly does not know the browser "${name}"`);
  return name;
}

/** The browser of a nightly project, by its name. Throws on a project this lane does not know. */
export function browserOfProject(projectName: string): A11yBrowser {
  if (!isA11yBrowser(projectName)) {
    throw new Error(`the a11y nightly has no browser for the project "${projectName}"`);
  }
  return projectName;
}

/**
 * The tags that keep a test out of every browser not in `foundIn`: one
 * `@not-<browser>` per missing browser. Each nightly project drops its own tag
 * with `grepInvert` (`NOT_IN_PROJECT`), so a barrier found in one engine adds no
 * test, and no skip, to the others. Empty when every browser is in `foundIn`.
 */
export function notInTags(foundIn: readonly A11yBrowser[]): string[] {
  return A11Y_BROWSERS.filter((b) => !foundIn.includes(b)).map((b) => `@not-${b}`);
}

/** The `grepInvert` of the nightly project for `browser`. */
export function notInProject(browser: A11yBrowser): RegExp {
  return new RegExp(`@not-${browser}\\b`);
}

/** The key to press for one sequential focus move in this page's browser. */
export function sequentialKey(page: Page, direction: 'Tab' | 'Shift+Tab'): string {
  const keys = expected('sequentialKeys', browserOf(page));
  return direction === 'Tab' ? keys.forward : keys.backward;
}
