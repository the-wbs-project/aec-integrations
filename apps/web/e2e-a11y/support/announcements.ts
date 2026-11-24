/**
 * AECI-1880: the announcement recorder.
 *
 * axe reads one moment of the page. A status message exists only after an
 * action, so axe cannot see whether one was announced (WCAG 4.1.3). This
 * recorder watches the page while the action runs and returns what changed in
 * the places a screen reader speaks from:
 *
 *   - `live`: the text of a live region changed. A live region is any element
 *     with `aria-live`, or `role="status"`, `role="alert"` or `role="log"`. The
 *     entry carries the region's politeness and whether the region was inserted
 *     with its text already in place.
 *   - `focus`: focus moved. A reader speaks the focused element's name and its
 *     `aria-describedby` text, so a focus move is an announcement too. Both are
 *     read one frame after the move. An option or radio with no description of
 *     its own takes its group's.
 *
 * It proves the DOM changed. It does not prove a screen reader spoke. NVDA and
 * VoiceOver runs are AECI-1886 and AECI-1887 (`docs/TESTING_STRATEGY.md` §8.4.4).
 *
 * Use:
 *
 *   const rec = await recordAnnouncements(page);   // after the hydration gate
 *   await submit.click();
 *   await expect(page.getByRole('heading', { name: 'Done' })).toBeVisible();
 *   expectHeardOnce(await rec.settle(), /Done/, 'focus');
 *
 * The recorder lives in the document, so a full page load ends it. A client
 * navigation keeps it. `settle()` throws if the document changed.
 *
 * This file imports only `@playwright/test`, so `e2e/` specs can use it too.
 */
import { expect, type Page } from '@playwright/test';

export type Politeness = 'polite' | 'assertive' | 'off';

export interface LiveChange {
  readonly channel: 'live';
  /** The region's text after the change, whitespace collapsed. */
  readonly text: string;
  readonly politeness: Politeness;
  /** The region's explicit role, or `null` for a bare `aria-live`. */
  readonly role: string | null;
  /** A short selector for the region, for messages. */
  readonly region: string;
  /** The region was added to the page during the recording with its text already in it. */
  readonly insertedFilled: boolean;
  /** The region is not rendered, or sits inside `aria-hidden="true"` or `inert`. */
  readonly hidden: boolean;
  /** Milliseconds since the recording started. */
  readonly atMs: number;
}

export interface FocusChange {
  readonly channel: 'focus';
  /** The focused element's accessible name, approximated. */
  readonly name: string;
  /** The text its `aria-describedby` points at, one frame after the focus move. */
  readonly description: string;
  /** The same, read at the instant of the focus move. */
  readonly descriptionAtFocus: string;
  readonly role: string | null;
  readonly target: string;
  readonly atMs: number;
}

export type Announcement = LiveChange | FocusChange;

export interface AnnouncementRecorder {
  /**
   * Wait until nothing has been recorded for `quietMs`, then return everything
   * recorded so far, in order. Waits at least `quietMs` even when nothing happens.
   */
  settle(options?: {
    readonly quietMs?: number;
    readonly timeoutMs?: number;
  }): Promise<readonly Announcement[]>;
  /** Everything recorded so far, without waiting. */
  read(): Promise<readonly Announcement[]>;
  /** Forget what was recorded so far. The recording goes on. */
  clear(): Promise<void>;
}

/** One live region as it stands now. */
export interface LiveRegionFact {
  readonly politeness: Politeness;
  readonly role: string | null;
  readonly region: string;
  readonly text: string;
  readonly hidden: boolean;
  readonly srOnly: boolean;
}

const KEY = '__aeciAnnouncements';

/**
 * Start recording on the current document. Call it after the hydration gate,
 * right before the action: hydration and boot fetches change regions too.
 */
export async function recordAnnouncements(page: Page): Promise<AnnouncementRecorder> {
  const token = await page.evaluate(installRecorder, { key: KEY, token: null });
  return recorderFor(page, token);
}

/**
 * Start recording on the next document this page loads, from the moment its HTML
 * is parsed. For a message that appears on arrival, such as a banner revealed
 * after hydration. The init script starts the recorder when the document's
 * `readyState` leaves `loading`: the parser has finished, and no deferred or
 * module script has run yet. So the regions in the server HTML are the starting
 * state, and everything the app's scripts add or change counts. Each document
 * gets its own token. The recorder holds the first one it reads, and a read from
 * a later document (a reload, a full navigation) throws. Call before `page.goto`.
 */
export async function recordAnnouncementsFromLoad(page: Page): Promise<AnnouncementRecorder> {
  const options = JSON.stringify({ key: KEY, token: null });
  await page.addInitScript(
    `(() => {
      const start = () => (${installRecorder.toString()})(${options});
      if (document.readyState !== 'loading') { start(); return; }
      const onState = () => {
        if (document.readyState === 'loading') return;
        document.removeEventListener('readystatechange', onState);
        start();
      };
      document.addEventListener('readystatechange', onState);
    })();`,
  );
  return recorderFor(page, null);
}

/** `initialToken` is the document's, or `null` to hold the first one read. */
function recorderFor(page: Page, initialToken: string | null): AnnouncementRecorder {
  let token = initialToken;
  const read = async () => {
    const out = await page.evaluate(
      ({ key, token }) => {
        const rec = (window as unknown as Record<string, RecorderState | undefined>)[key];
        if (!rec || (token !== null && rec.token !== token)) return null;
        return { token: rec.token, entries: rec.entries, idleMs: performance.now() - rec.lastAt };
      },
      { key: KEY, token },
    );
    if (out && token === null) token = out.token;
    if (!out) {
      throw new Error(
        'The announcement recorder is gone: the page loaded a new document after it started. ' +
          'A full page load is not a status message. Start the recorder after the load.',
      );
    }
    return out;
  };
  return {
    async read() {
      return (await read()).entries;
    },
    async clear() {
      await read();
      await page.evaluate(
        ({ key }) => {
          const rec = (window as unknown as Record<string, RecorderState | undefined>)[key];
          if (rec) rec.entries.length = 0;
        },
        { key: KEY },
      );
    },
    async settle({ quietMs = 1_000, timeoutMs = 20_000 } = {}) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const { entries, idleMs } = await read();
        if (idleMs >= quietMs) return entries;
        if (Date.now() > deadline) {
          throw new Error(`The page kept announcing for ${timeoutMs}ms: ${describe(entries)}`);
        }
        await page.waitForTimeout(Math.max(100, quietMs - idleMs));
      }
    },
  };
}

/** Every live region on the page now, in document order. Reads only. */
export async function liveRegions(page: Page): Promise<readonly LiveRegionFact[]> {
  return page.evaluate(() => {
    const SELECTOR = '[aria-live],[role="status"],[role="alert"],[role="log"]';
    const isHidden = (el: Element): boolean =>
      !!el.closest('[aria-hidden="true"],[inert]') ||
      !(el as HTMLElement).checkVisibility({ visibilityProperty: true });
    const politeness = (el: Element): 'polite' | 'assertive' | 'off' => {
      const live = el.getAttribute('aria-live');
      if (live === 'polite' || live === 'assertive' || live === 'off') return live;
      return el.getAttribute('role') === 'alert' ? 'assertive' : 'polite';
    };
    const describeEl = (el: Element): string => {
      const id = el.id ? `#${el.id}` : '';
      const role = el.getAttribute('role');
      const cls = [...el.classList]
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join('');
      return `${el.tagName.toLowerCase()}${id}${cls}${role ? `[role=${role}]` : ''}`;
    };
    return [...document.querySelectorAll(SELECTOR)].map((el) => ({
      politeness: politeness(el),
      role: el.getAttribute('role'),
      region: describeEl(el),
      text: (el.textContent ?? '').replace(/\s+/g, ' ').trim(),
      hidden: isHidden(el),
      srOnly: el.classList.contains('sr-only'),
    }));
  });
}

/**
 * What a screen reader is expected to speak from a record. The model:
 *   - A live change in a hidden region, or one with `aria-live="off"`, is silent.
 *   - A polite region inserted with its text already in it is silent. Screen
 *     readers announce a change to a region they already know, not its arrival
 *     (AECI-1858). An inserted `role="alert"` is spoken: the alert role fires on
 *     arrival.
 *   - A live change with no text is silent.
 *   - Every focus move is spoken, as its name and its description.
 */
export function heard(record: readonly Announcement[]): readonly Announcement[] {
  return record.filter((a) => {
    if (a.channel === 'focus') return true;
    if (a.hidden || a.politeness === 'off' || a.text === '') return false;
    if (a.insertedFilled && a.role !== 'alert') return false;
    return true;
  });
}

/** The spoken text of one announcement. */
export function spokenText(a: Announcement): string {
  return a.channel === 'live' ? a.text : `${a.name} ${a.description}`.trim();
}

/** The entries of `heard(record)` whose spoken text matches. */
export function heardMatching(
  record: readonly Announcement[],
  text: RegExp | string,
): readonly Announcement[] {
  return heard(record).filter((a) => matches(spokenText(a), text));
}

/**
 * The status message is heard exactly once, and through the channel the flow
 * promises: `'focus'` for a view that moves focus to its new heading, or a
 * politeness for a live region. A second hearing (a live region and a focus move
 * that both carry it, or two regions) fails, and so does none.
 */
export function expectHeardOnce(
  record: readonly Announcement[],
  text: RegExp | string,
  via: Politeness | 'focus',
): void {
  const hits = heardMatching(record, text);
  expect(
    hits.length,
    `${String(text)} must be heard exactly once. Heard: ${describe(hits)}. Whole record: ${describe(record)}`,
  ).toBe(1);
  const [hit] = hits;
  const channel = hit!.channel === 'focus' ? 'focus' : hit!.politeness;
  expect(channel, `${String(text)} must be heard via ${via}. Record: ${describe(record)}`).toBe(
    via,
  );
}

/** Nothing matching `text` is heard. */
export function expectNotHeard(record: readonly Announcement[], text: RegExp | string): void {
  const hits = heardMatching(record, text);
  expect(hits, `${String(text)} must not be heard. Heard: ${describe(hits)}`).toEqual([]);
}

/** A record as one line per entry, for failure messages. */
export function describe(record: readonly Announcement[]): string {
  if (record.length === 0) return '(nothing)';
  return record
    .map((a) =>
      a.channel === 'live'
        ? `[live ${a.politeness}${a.insertedFilled ? ' inserted-filled' : ''}${a.hidden ? ' hidden' : ''} ${a.region}] "${a.text}"`
        : `[focus ${a.role ?? a.target}] "${a.name}"${a.description ? ` / "${a.description}"` : ''}`,
    )
    .join(' | ');
}

function matches(value: string, text: RegExp | string): boolean {
  return typeof text === 'string' ? value.includes(text) : text.test(value);
}

/** The recorder's in-page state. */
interface RecorderState {
  token: string;
  entries: Announcement[];
  lastAt: number;
  stop: () => void;
}

/**
 * Runs in the page. Serialized by `page.evaluate`, so it must not close over
 * anything in this module.
 */
function installRecorder(options: { key: string; token: string | null }): string {
  const { key } = options;
  const w = window as unknown as Record<string, RecorderState | undefined>;
  w[key]?.stop();
  const SELECTOR = '[aria-live],[role="status"],[role="alert"],[role="log"]';
  const startedAt = performance.now();
  const token = options.token ?? `${Math.random()}`.slice(2);
  const state: RecorderState = { token, entries: [], lastAt: startedAt, stop: () => undefined };

  const isHidden = (el: Element): boolean =>
    !el.isConnected ||
    !!el.closest('[aria-hidden="true"],[inert]') ||
    !(el as HTMLElement).checkVisibility({ visibilityProperty: true });

  const politeness = (el: Element): 'polite' | 'assertive' | 'off' => {
    const live = el.getAttribute('aria-live');
    if (live === 'polite' || live === 'assertive' || live === 'off') return live;
    return el.getAttribute('role') === 'alert' ? 'assertive' : 'polite';
  };

  /** Text a reader would get from a subtree: skips `aria-hidden` and unrendered parts. */
  const spoken = (root: Node): string => {
    if (root.nodeType === Node.TEXT_NODE) return root.textContent ?? '';
    if (!(root instanceof Element)) return '';
    if (root.getAttribute('aria-hidden') === 'true') return '';
    if (root !== document.body && root instanceof HTMLElement) {
      const style = getComputedStyle(root);
      if (style.display === 'none' || style.visibility === 'hidden') return '';
    }
    let out = '';
    for (const child of root.childNodes) out += spoken(child);
    return out;
  };
  const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();

  const describeEl = (el: Element): string => {
    const id = el.id ? `#${el.id}` : '';
    const role = el.getAttribute('role');
    const cls = [...el.classList]
      .slice(0, 2)
      .map((c) => `.${c}`)
      .join('');
    return `${el.tagName.toLowerCase()}${id}${cls}${role ? `[role=${role}]` : ''}`;
  };

  const textOfIds = (ids: string | null): string =>
    tidy(
      (ids ?? '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const el = document.getElementById(id);
          return el ? (el.textContent ?? '') : '';
        })
        .join(' '),
    );

  const nameOf = (el: Element): string => {
    const by = textOfIds(el.getAttribute('aria-labelledby'));
    if (by) return by;
    const label = el.getAttribute('aria-label');
    if (label) return tidy(label);
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length > 0)
      return tidy([...labels].map((l) => l.textContent ?? '').join(' '));
    return tidy(spoken(el)).slice(0, 300);
  };

  /** Raw text per region, so an alternating no-break space still counts as a change. */
  const last = new WeakMap<Element, string>();
  const inserted = new WeakSet<Element>();
  for (const el of document.querySelectorAll(SELECTOR)) last.set(el, spoken(el));

  const push = (a: Announcement) => {
    state.entries.push(a);
    state.lastAt = performance.now();
  };

  const observer = new MutationObserver((mutations) => {
    const touched = new Set<Element>();
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof Element)) continue;
        const regions = node.matches(SELECTOR) ? [node] : [];
        regions.push(...node.querySelectorAll(SELECTOR));
        for (const r of regions) {
          if (!last.has(r)) inserted.add(r);
          touched.add(r);
        }
      }
      const target = m.target instanceof Element ? m.target : m.target.parentElement;
      const region = target?.closest(SELECTOR);
      if (region) touched.add(region);
    }
    for (const region of touched) {
      if (!region.isConnected) continue;
      const raw = spoken(region);
      const seen = last.has(region);
      if (seen && last.get(region) === raw) continue;
      last.set(region, raw);
      const text = tidy(raw);
      if (text === '') continue;
      push({
        channel: 'live',
        text,
        politeness: politeness(region),
        role: region.getAttribute('role'),
        region: describeEl(region),
        insertedFilled: !seen && inserted.has(region),
        hidden: isHidden(region),
        atMs: Math.round(performance.now() - startedAt),
      });
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });

  /** An option or radio is described by its group when it has no description of its own. */
  const describedBy = (el: Element): string | null =>
    el.getAttribute('aria-describedby') ??
    (el.matches('[role="option"],[role="radio"],input[type="radio"]')
      ? (el
          .closest('[role="listbox"],[role="radiogroup"],fieldset')
          ?.getAttribute('aria-describedby') ?? null)
      : null);

  const onFocus = (event: FocusEvent) => {
    const el = event.target;
    if (!(el instanceof Element) || el === document.body) return;
    const description = textOfIds(describedBy(el));
    const entry: { -readonly [K in keyof FocusChange]: FocusChange[K] } = {
      channel: 'focus',
      name: nameOf(el),
      description,
      descriptionAtFocus: description,
      role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
      target: describeEl(el),
      atMs: Math.round(performance.now() - startedAt),
    };
    push(entry);
    // A screen reader reads the focused element from the accessibility tree,
    // which the browser updates at the next frame. A page that focuses a field
    // and then renders its error in the same frame has the error in the
    // description by then. Read the name and description again at that point.
    requestAnimationFrame(() =>
      setTimeout(() => {
        if (!el.isConnected) return;
        entry.name = nameOf(el);
        entry.description = textOfIds(describedBy(el));
        state.lastAt = performance.now();
      }, 0),
    );
  };
  document.addEventListener('focusin', onFocus, true);

  state.stop = () => {
    observer.disconnect();
    document.removeEventListener('focusin', onFocus, true);
  };
  w[key] = state;
  return token;
}
