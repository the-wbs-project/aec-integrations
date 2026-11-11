import {
  EventContract,
  EventContractContainer,
  EventDispatcher,
  registerDispatcher,
} from '@angular/core/primitives/event-dispatch';
import { afterEach, describe, expect, it } from 'vitest';

import { isReplayedEvent } from './event-replay';

/** `tag` with optional attributes and children, built without markup strings. */
function el(tag: string, attrs: Record<string, string> = {}, ...children: Element[]): Element {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  for (const child of children) node.appendChild(child);
  return node;
}

/**
 * Drives Angular's real event-replay primitives (the same ones `withEventReplay`
 * wires up after hydration) rather than faking `eventPhase`, so a change in how
 * Angular marks a replay fails here first.
 */
function replayHarness(content: Element) {
  const container = el('div', {}, content);
  document.body.appendChild(container);
  const contract = new EventContract(new EventContractContainer(container));
  contract.addEvent('click');
  const seen: Event[] = [];
  /** Registers the dispatcher. Clicks made before this are queued and replayed. */
  const hydrate = (handler: (e: Event) => void = () => undefined) =>
    registerDispatcher(
      contract,
      new EventDispatcher((event) => {
        seen.push(event);
        handler(event);
      }),
    );
  return { seen, hydrate };
}

function click(target: Element): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('isReplayedEvent', () => {
  it('is true for an event queued before hydration and replayed after it', () => {
    const button = el('button', { jsaction: 'click:;' });
    const { seen, hydrate } = replayHarness(button);
    click(button);

    let replayed = false;
    let threw: unknown = null;
    hydrate((event) => {
      replayed = isReplayedEvent(event);
      // The contract the guard exists for: preventDefault on a replay throws.
      try {
        event.preventDefault();
      } catch (e) {
        threw = e;
      }
    });

    expect(seen).toHaveLength(1);
    expect(replayed).toBe(true);
    expect(String(threw)).toContain('`preventDefault` called during event replay');
  });

  it('is false for a live event dispatched after hydration', () => {
    const button = el('button', { jsaction: 'click:;' });
    const { seen, hydrate } = replayHarness(button);
    hydrate();
    click(button);

    expect(seen).toHaveLength(1);
    expect(isReplayedEvent(seen[0])).toBe(false);
  });

  it('is false for a plain DOM event and for a missing event', () => {
    expect(isReplayedEvent(new MouseEvent('click'))).toBe(false);
    expect(isReplayedEvent(null)).toBe(false);
    expect(isReplayedEvent(undefined)).toBe(false);
  });
});

/**
 * Why `SectionNav` keeps its click listener off the `<a>` (AECI-1655). The action
 * resolver caches an element's parsed `jsaction` on the element. Angular removes
 * the attribute after hydration but not that cache, and with incremental hydration
 * the contract keeps listening. So once an anchor that carried a click action has
 * had an early click, the dispatcher calls `preventDefault` on every later click
 * on it (`shouldPreventDefaultBeforeDispatching`: tag `A` and a click).
 */
describe('anchor click actions after an early click', () => {
  it('an anchor with its own click action has every later click prevented', () => {
    const a = el('a', { href: '#x', jsaction: 'click:;' });
    const { hydrate } = replayHarness(a);
    click(a);
    hydrate();
    a.removeAttribute('jsaction'); // what Angular does once the app is stable

    expect(click(a).defaultPrevented).toBe(true);
  });

  it('a click action on the parent list leaves later anchor clicks alone', () => {
    const a = el('a', { href: '#x' });
    const ul = el('ul', { jsaction: 'click:;' }, el('li', {}, a));
    const { hydrate } = replayHarness(ul);
    click(a);
    hydrate();
    ul.removeAttribute('jsaction');

    expect(click(a).defaultPrevented).toBe(false);
  });
});
