/**
 * A link the visitor opens in a new tab (AECI-1988, ruling 2026-11-20). The new tab
 * is a fresh page load, a landing view, so without this it reads `ran` until the
 * visitor touches it. The ruling: a link a person opened in a new tab counts as
 * interaction for the page it opens.
 *
 * **The proof is a trusted input in the opening tab, never the referrer.** A
 * same-origin `document.referrer` proves nothing: crawlers run our bundle and send
 * one. So the opening tab remembers, in memory, the address of a link the visitor
 * opened with a trusted `NEW_TAB_INPUT_EVENTS` event. The new tab asks the other
 * tabs of this site, over a same-origin `BroadcastChannel`, whether one of them just
 * opened its address. A tab answers only from a fresh record, and the answer uses
 * the record up. So one open can mark at most one new tab.
 *
 * Both tabs run the same gates: the `PageViewTracker` creates this only when the
 * browser report is wanted (the tier flag, no DNT or GPC, no held-region stamp). A
 * gated tab neither asks nor answers. Nothing is written to the browser, nothing is
 * added to the URL and nothing leaves it: the address and the question's tag stay in
 * the two tabs' memory. The server still gets one word per view.
 *
 * Known limit, same class as the rest of the report: a client that runs our script
 * can open a second same-origin context and answer for itself. AECI-1716's shadow
 * run checks `interacted` against the other evidence.
 */
import { isUntrackedRoute } from '@aeci/shared/api/page-view-eager';

/** The one channel name. Same-origin and same storage partition only, by the browser. */
export const NEW_TAB_CHANNEL_NAME = 'aeci-browser-evidence';

/**
 * The inputs that open a link in a new tab. `click` with Ctrl, Cmd or Shift, or on a
 * link whose `target` opens a new browsing context; `auxclick` (or an older
 * browser's `click`) with the middle button; `contextmenu` on a link, for "Open link
 * in new tab". On a Mac a Ctrl-click is a `contextmenu`.
 */
export const NEW_TAB_INPUT_EVENTS = ['click', 'auxclick', 'contextmenu'] as const;

/**
 * How long a click or middle click opens the door, from the input to the new tab's
 * question. The new tab has to load, boot and hydrate first, possibly in the
 * background on a slow connection. Long enough for that; short enough that a stale
 * record rarely meets the same address typed in later.
 */
export const NEW_TAB_OPEN_WINDOW_MS = 30_000;

/**
 * The same for a context menu, measured from the right-click. The visitor still has
 * to read the menu and pick "Open link in new tab", and the page sees no event for
 * that choice. A record that outlives its menu can only meet an address the visitor
 * opened by hand, which is still a person.
 */
export const NEW_TAB_MENU_WINDOW_MS = 60_000;

/**
 * Inputs on the same address this close together are one open. A browser that fires
 * both `auxclick` and a middle `click` must not leave two records for one tab.
 */
export const NEW_TAB_SAME_INPUT_MS = 1_000;

/**
 * How long the new tab listens for an answer. The opening tab answers at once if it
 * runs. A background tab's timers are throttled, so the close may come later, which
 * only lengthens the wait.
 */
export const NEW_TAB_ANSWER_WAIT_MS = 5_000;

/** At most this many links remembered at once. The oldest goes first. */
export const NEW_TAB_OPEN_LIMIT = 8;

interface OpenedLink {
  address: string;
  at: number;
  until: number;
}

interface Question {
  tag: string;
  until: number;
  onYes: () => void;
}

type Message = { kind: 'ask'; tag: string; address: string } | { kind: 'yes'; tag: string };

/** The running instance's recorder, for code that opens a new tab itself. */
let activeRecorder: ((event: Event, href: string) => void) | null = null;

/**
 * Record a new tab that our own code opened from a visitor's input, such as a
 * Ctrl-click on a table row that calls `window.open`. `event` must be that input:
 * only a trusted event records anything. A no-op when the report is off.
 */
export function recordNewTabOpen(event: Event, href: string): void {
  activeRecorder?.(event, href);
}

/**
 * The comparable form of a same-origin address: path and query, no fragment, no
 * trailing slash except the root. `null` for another origin or an unparsable one.
 */
export function linkAddress(href: string, origin: string): string | null {
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin) return null;
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') || '/' : '/';
    return path + url.search;
  } catch {
    return null;
  }
}

/** A target that opens the link in a new browsing context. */
function opensNewContext(target: string | null): boolean {
  const name = (target ?? '').trim().toLowerCase();
  return name !== '' && name !== '_self' && name !== '_top' && name !== '_parent';
}

export class NewTabEvidence {
  private opened: OpenedLink[] = [];
  private question: Question | null = null;
  private channel: BroadcastChannel | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly win: Window) {}

  /** Watch for new-tab inputs. Called once, only when the report is wanted. */
  start(): void {
    activeRecorder = this.recordFromCode;
    for (const type of NEW_TAB_INPUT_EVENTS) {
      this.win.addEventListener(type, this.onInput, { capture: true, passive: true });
    }
  }

  /** Stop watching, forget everything and close the channel. */
  stop(): void {
    if (activeRecorder === this.recordFromCode) activeRecorder = null;
    for (const type of NEW_TAB_INPUT_EVENTS) {
      this.win.removeEventListener(type, this.onInput, { capture: true });
    }
    this.opened = [];
    this.question = null;
    this.closeChannel();
  }

  /**
   * Ask whether another tab just opened this page. Only for a page load the browser
   * reports as a plain navigation, not a reload or a history step. `onYes` runs at
   * most once, when an opening tab answers within `NEW_TAB_ANSWER_WAIT_MS`.
   */
  ask(onYes: () => void): void {
    const address = this.landingAddress();
    if (!address) return;
    const channel = this.openChannel();
    if (!channel) return;
    const tag = Math.random().toString(36).slice(2);
    this.question = { tag, until: Date.now() + NEW_TAB_ANSWER_WAIT_MS, onYes };
    this.post({ kind: 'ask', tag, address });
    this.scheduleClose();
  }

  /** Remember a link the visitor opened in a new tab, for `windowMs`. */
  record(event: Event, href: string, windowMs: number): void {
    if (!event.isTrusted) return;
    const address = linkAddress(href, this.win.location.origin);
    if (!address || isUntrackedRoute(address.split('?', 1)[0])) return;
    const now = Date.now();
    this.prune(now);
    const same = this.opened.find(
      (o) => o.address === address && now - o.at < NEW_TAB_SAME_INPUT_MS,
    );
    if (same) {
      same.until = Math.max(same.until, now + windowMs);
    } else {
      this.opened.push({ address, at: now, until: now + windowMs });
      if (this.opened.length > NEW_TAB_OPEN_LIMIT) this.opened.shift();
    }
    if (this.openChannel()) this.scheduleClose();
  }

  private readonly recordFromCode = (event: Event, href: string): void =>
    this.record(event, href, NEW_TAB_OPEN_WINDOW_MS);

  private readonly onInput = (event: Event): void => {
    if (!event.isTrusted) return;
    const target = event.target;
    const link =
      target instanceof Element
        ? (target.closest('a[href], area[href]') as HTMLAnchorElement | HTMLAreaElement | null)
        : null;
    if (!link || link.hasAttribute('download')) return;
    const mouse = event as MouseEvent;
    if (event.type === 'contextmenu') {
      this.record(event, link.href, NEW_TAB_MENU_WINDOW_MS);
      return;
    }
    const opensTab =
      mouse.button === 1 ||
      (event.type === 'click' &&
        mouse.button === 0 &&
        (mouse.ctrlKey ||
          mouse.metaKey ||
          mouse.shiftKey ||
          opensNewContext(link.getAttribute('target'))));
    if (opensTab) this.record(event, link.href, NEW_TAB_OPEN_WINDOW_MS);
  };

  private readonly onMessage = (event: MessageEvent): void => {
    const data = event.data as Partial<Message> | null;
    if (!data || typeof data !== 'object' || typeof data.tag !== 'string') return;
    if (data.kind === 'ask' && typeof (data as { address?: unknown }).address === 'string') {
      this.answer(data.tag, (data as { address: string }).address);
    } else if (data.kind === 'yes' && this.question?.tag === data.tag) {
      const { onYes } = this.question;
      this.question = null;
      this.scheduleClose();
      onYes();
    }
  };

  /** Answer one question from one fresh record, and use the record up. */
  private answer(tag: string, address: string): void {
    this.prune(Date.now());
    const index = this.opened.findIndex((o) => o.address === address);
    if (index < 0) return;
    this.opened.splice(index, 1);
    this.post({ kind: 'yes', tag });
    this.scheduleClose();
  }

  /** This document's own address, when the browser loaded it by a plain navigation. */
  private landingAddress(): string | null {
    const entry = this.win.performance?.getEntriesByType?.('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    if (entry?.type !== 'navigate') return null;
    return linkAddress(entry.name || this.win.location.href, this.win.location.origin);
  }

  private prune(now: number): void {
    this.opened = this.opened.filter((o) => o.until >= now);
    if (this.question && this.question.until < now) this.question = null;
  }

  private openChannel(): BroadcastChannel | null {
    if (this.channel) return this.channel;
    const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
    if (typeof Channel !== 'function') return null;
    try {
      const channel = new Channel(NEW_TAB_CHANNEL_NAME);
      channel.onmessage = this.onMessage;
      this.channel = channel;
      return channel;
    } catch {
      return null;
    }
  }

  private post(message: Message): void {
    try {
      this.channel?.postMessage(message);
    } catch {
      // A closed or failing channel costs the answer, never the page.
    }
  }

  /** Keep the channel open only while a record or a question is live. */
  private scheduleClose(): void {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    const now = Date.now();
    this.prune(now);
    const until = Math.max(this.question?.until ?? 0, ...this.opened.map((o) => o.until));
    if (until < now) {
      this.closeChannel();
      return;
    }
    this.closeTimer = setTimeout(() => this.scheduleClose(), until - now + 1);
  }

  private closeChannel(): void {
    clearTimeout(this.closeTimer);
    this.closeTimer = undefined;
    this.channel?.close();
    this.channel = null;
  }
}
