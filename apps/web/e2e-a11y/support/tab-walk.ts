/**
 * AECI-1877: the Tab walk. Real key presses only.
 *
 * `tabWalk` presses Tab (or Shift+Tab) until focus comes back to the first stop,
 * and records each stop's role, accessible name and landmark. It never calls
 * `el.focus()`. `focus()` skips the browser's sequential focus navigation, so a
 * walk built on it tests a reimplementation, not the page.
 *
 * Call it on a hydrated page (`openSurface` in `./surface-page.ts`). A key press
 * before hydration is dropped or replayed late (`docs/TESTING_STRATEGY.md` §14.3).
 *
 * The walk records what it saw and stops early on a defect. It asserts nothing.
 * The spec decides what is a failure, so AECI-1878 (focus ring on every stop,
 * through `onStop`) and AECI-1885 (Firefox and WebKit) reuse the walk with their
 * own checks.
 *
 * Portable. Role and name come from Playwright's `ariaSnapshot()`, which works
 * in every engine Playwright drives. `key` names the direction. The key actually
 * pressed is the browser's, from `sequentialKey` in `./browser-expectations.ts`:
 * Tab in Chromium and Firefox, Option+Tab in WebKit, which skips links on a plain
 * Tab as Safari does (AECI-1885).
 */
import type { Page } from '@playwright/test';
import { browserOf, expected, sequentialKey } from './browser-expectations';
import { ensureProbe, focusFacts, locatorForKey, type FocusFacts } from './probe';

export interface TabStop {
  /** Position in the walk, from 0. */
  readonly index: number;
  /** The probe's key for the element, shared with `collectElementFacts`. */
  readonly key: number;
  /** The accessible role, from `ariaSnapshot()`. */
  readonly role: string;
  /** The accessible name, from `ariaSnapshot()`. Empty when there is none. */
  readonly name: string;
  readonly tag: string;
  readonly landmark: string;
  readonly inMain: boolean;
  readonly inSiteHeader: boolean;
  readonly ariaHidden: boolean;
  readonly visible: boolean;
  readonly hasPopup: string | null;
  readonly expanded: string | null;
  readonly href: string | null;
  readonly target: string | null;
  /** Number of presses it took to get here, from the start of the walk. */
  readonly press: number;
}

export type WalkEnd =
  /** Focus came back to the first stop. The cycle is closed. */
  | 'closed'
  /** A press left focus on the same element. A keyboard trap. */
  | 'stuck'
  /** Focus came back to a stop other than the first. A trap around a group. */
  | 'looped'
  /** A press changed the URL. Check 6 (WCAG 3.2.1) fails, and the walk cannot go on. */
  | 'navigated'
  /** `until` matched a stop. Only for a walk that looks for one element. */
  | 'matched'
  /** The press budget ran out before the cycle closed. */
  | 'budget';

export interface TabWalk {
  readonly stops: TabStop[];
  readonly end: WalkEnd;
  /** The URL the walk started on. */
  readonly startUrl: string;
  /** Set when `end` is `navigated`. */
  readonly navigatedTo: string | null;
  /** Stops at which more popups were open than at the start: a dialog, menu or list opened on focus. */
  readonly popupOpenedAt: TabStop[];
  /** Presses that left focus on the document between the last stop and the first. */
  readonly documentPresses: number;
  /** Total key presses sent. */
  readonly presses: number;
}

export interface TabWalkOptions {
  /**
   * `Tab` walks forward, `Shift+Tab` backward. Default `Tab`. The key pressed is
   * the browser's for that direction (`sequentialKey`).
   */
  readonly key?: 'Tab' | 'Shift+Tab';
  /** Stop after this many presses. Default 400. */
  readonly maxPresses?: number;
  /** Stop as soon as a recorded stop matches. The walk then ends `matched`. */
  readonly until?: (stop: TabStop) => boolean;
  /**
   * Runs at each new stop while it has focus, before the next press. AECI-1878
   * measures the focus ring here, so it shares this walk rather than walking the
   * page a second way. It must not move focus.
   */
  readonly onStop?: (stop: TabStop) => Promise<void>;
  /**
   * What to do at the end of the document in a browser that does not wrap
   * (`sequentialFocusWraps`). `wrap`, the default, wraps by hand and goes on, as
   * a wrapping browser does. `stop` checks the opposite key moves focus, so the
   * last stop is no trap, puts focus back on the last stop, and ends `closed`.
   * For a walk that only needs every stop once and must not scroll the page
   * again before it is done: the focus ring walk (AECI-1885).
   */
  readonly atDocumentEnd?: 'wrap' | 'stop';
}

/** Parse the first line of an `ariaSnapshot()`: `- link "Name" [attrs]:`. */
export function parseAriaLine(snapshot: string): { role: string; name: string } {
  const first = snapshot.split('\n')[0] ?? '';
  const match = first.match(/^-\s+([a-zA-Z]+)(?:\s+("(?:[^"\\]|\\.)*"))?/);
  if (!match) return { role: 'unknown', name: '' };
  let name = '';
  if (match[2]) {
    try {
      name = JSON.parse(match[2]) as string;
    } catch {
      name = match[2].slice(1, -1);
    }
  }
  return { role: match[1], name };
}

/** Role and accessible name of the focused element, from the accessibility tree. */
export async function describeFocused(
  page: Page,
  facts: FocusFacts,
): Promise<{ role: string; name: string }> {
  if (facts.key === null) return { role: 'document', name: '' };
  if (facts.inIframe) {
    const title = await page.evaluate(() => document.activeElement?.getAttribute('title') ?? '');
    return { role: 'iframe', name: title };
  }
  const element = await locatorForKey(page, facts.key);
  if (!element) return { role: 'unknown', name: '' };
  return parseAriaLine(await element.ariaSnapshot({ timeout: 5_000 }));
}

/**
 * Walk the page with real Tab presses, from wherever focus is now, until focus
 * returns to the first stop. Start from a fresh load so focus is on the document.
 */
export async function tabWalk(page: Page, options: TabWalkOptions = {}): Promise<TabWalk> {
  const key = sequentialKey(page, options.key ?? 'Tab');
  const maxPresses = options.maxPresses ?? 400;
  await ensureProbe(page);
  const start = await focusFacts(page);
  const startUrl = start.url;

  const stops: TabStop[] = [];
  const seen = new Map<number, TabStop>();
  const popupOpenedAt: TabStop[] = [];
  let documentPresses = 0;
  let previous: number | null = start.key;
  let end: WalkEnd = 'budget';
  let navigatedTo: string | null = null;
  let presses = 0;

  while (presses < maxPresses) {
    await page.keyboard.press(key);
    presses++;
    let facts = await focusFacts(page);

    if (facts.url !== startUrl) {
      end = 'navigated';
      navigatedTo = facts.url;
      break;
    }
    if (facts.onBody || facts.key === null) {
      documentPresses++;
      previous = null;
      continue;
    }
    if (facts.key === previous) {
      // An iframe holds focus while Tab moves through its own document.
      if (facts.inIframe) continue;
      // Playwright Firefox does not wrap past the last stop (`sequentialFocusWraps`
      // in `./browser-expectations.ts`). There, a press that leaves focus where
      // it is means the end of the document, not a trap, when the opposite key
      // moves it. `wrapByHand` then does the wrap, and the walk goes on from the
      // other end, as it does in a browser that wraps.
      if (expected('sequentialFocusWraps', browserOf(page)) || stops.length === 0) {
        end = 'stuck';
        break;
      }
      if (options.atDocumentEnd === 'stop') {
        end = await confirmDocumentEnd(page, options.key ?? 'Tab', facts.key, startUrl);
        presses += 2;
        break;
      }
      const wrap = await wrapByHand(page, options.key ?? 'Tab', maxPresses - presses, startUrl);
      presses += wrap.presses;
      if (wrap.kind === 'navigated') {
        end = 'navigated';
        navigatedTo = wrap.url;
        break;
      }
      if (wrap.kind !== 'wrapped') {
        end = wrap.kind;
        break;
      }
      facts = wrap.facts;
    }
    // `wrapByHand` never returns the document, so this only narrows the type.
    if (facts.key === null) continue;
    const again = seen.get(facts.key);
    if (again) {
      end = again.index === 0 ? 'closed' : 'looped';
      break;
    }

    const { role, name } = await describeFocused(page, facts);
    const stop: TabStop = {
      index: stops.length,
      key: facts.key,
      role,
      name,
      tag: facts.tag,
      landmark: facts.landmark,
      inMain: facts.inMain,
      inSiteHeader: facts.inSiteHeader,
      ariaHidden: facts.ariaHidden,
      visible: facts.visible,
      hasPopup: facts.hasPopup,
      expanded: facts.expanded,
      href: facts.href,
      target: facts.target,
      press: presses,
    };
    stops.push(stop);
    seen.set(stop.key, stop);
    if (facts.openPopups > start.openPopups) popupOpenedAt.push(stop);
    previous = facts.key;
    await options.onStop?.(stop);
    if (options.until?.(stop)) {
      end = 'matched';
      break;
    }
  }

  return { stops, end, startUrl, navigatedTo, popupOpenedAt, documentPresses, presses };
}

/**
 * In a browser that does not wrap: focus sits on the last stop of the document.
 * Do by real key presses what a wrapping browser does with one: press the
 * opposite key until focus stops moving, which is the other end of the
 * document. Its facts are what the wrapping press would have given. `stuck`
 * when the opposite key cannot move focus off the last stop either: a trap.
 * The way there only moves focus. It judges nothing: coming up from below, the
 * page is still scrolled, and a sticky bar can show stops a top-down walk never
 * meets (the product page's "back to top" link).
 */
async function wrapByHand(
  page: Page,
  direction: 'Tab' | 'Shift+Tab',
  budget: number,
  startUrl: string,
): Promise<
  | { kind: 'wrapped'; facts: FocusFacts; presses: number }
  | { kind: 'stuck' | 'budget'; presses: number }
  | { kind: 'navigated'; presses: number; url: string }
> {
  const back = sequentialKey(page, direction === 'Tab' ? 'Shift+Tab' : 'Tab');
  let previous = (await focusFacts(page)).key;
  let presses = 0;
  while (presses < budget) {
    await page.keyboard.press(back);
    presses++;
    const facts = await focusFacts(page);
    if (facts.url !== startUrl) return { kind: 'navigated', presses, url: facts.url };
    if (facts.onBody || facts.key === null || facts.inIframe) continue;
    if (facts.key === previous) {
      return presses === 1 ? { kind: 'stuck', presses } : { kind: 'wrapped', facts, presses };
    }
    previous = facts.key;
  }
  return { kind: 'budget', presses };
}

/**
 * In a browser that does not wrap, at the last stop: one press of the opposite
 * key must move focus, or the stop is a trap. The forward key then puts focus
 * back on the last stop, where the walk ended. Two presses, nothing else moves.
 */
async function confirmDocumentEnd(
  page: Page,
  direction: 'Tab' | 'Shift+Tab',
  last: number | null,
  startUrl: string,
): Promise<WalkEnd> {
  await page.keyboard.press(sequentialKey(page, direction === 'Tab' ? 'Shift+Tab' : 'Tab'));
  const back = await focusFacts(page);
  if (back.url !== startUrl) return 'navigated';
  if (back.key === last) return 'stuck';
  await page.keyboard.press(sequentialKey(page, direction));
  const again = await focusFacts(page);
  return again.key === last ? 'closed' : 'looped';
}

/**
 * Press Tab until the element with probe key `key` has focus, from wherever focus
 * is now. Returns the facts at that point, or `null` when the budget ran out.
 * The way to reach a known stop again without `el.focus()`.
 */
export async function tabTo(
  page: Page,
  key: number,
  options: Pick<TabWalkOptions, 'key' | 'maxPresses'> = {},
): Promise<FocusFacts | null> {
  const direction = options.key ?? 'Tab';
  let press = sequentialKey(page, direction);
  // In a browser that does not wrap, a target behind focus is reached the other way.
  const wraps = expected('sequentialFocusWraps', browserOf(page));
  const maxPresses = options.maxPresses ?? 400;
  const now = await focusFacts(page);
  if (now.key === key) return now;
  let previous = now.key;
  let turned = false;
  for (let i = 0; i < maxPresses; i++) {
    await page.keyboard.press(press);
    const facts = await focusFacts(page);
    if (facts.key === key) return facts;
    if (!wraps && !turned && facts.key !== null && facts.key === previous && !facts.inIframe) {
      press = sequentialKey(page, direction === 'Tab' ? 'Shift+Tab' : 'Tab');
      turned = true;
    }
    previous = facts.key;
  }
  return null;
}

/**
 * The committed form of a walk: one line per stop, `landmark  role "name"`.
 * Volatile text is masked by `normalizeName`, so the snapshot changes only when
 * the order, a role, or a stable name changes.
 */
export function walkSnapshot(stops: readonly TabStop[]): string {
  return (
    stops.map((s) => `${s.landmark.padEnd(6)}  ${s.role} "${normalizeName(s.name)}"`).join('\n') +
    '\n'
  );
}

/**
 * Mask the parts of an accessible name that change between runs without any
 * change to the page: relative times and calendar dates.
 */
export function normalizeName(name: string): string {
  return name
    .replace(/\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/gi, '<ago>')
    .replace(/\b(just now|yesterday|today)\b/gi, '<ago>')
    .replace(
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/g,
      '<date>',
    )
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>');
}
