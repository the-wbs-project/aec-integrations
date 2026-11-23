import type { Listbox } from '@angular/aria/listbox';
import { type Signal, type WritableSignal, effect, linkedSignal } from '@angular/core';

/** Keys that move the active option. The first one enters the list. */
const NAVIGATION_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Home', 'End']);

export interface ListboxEntryOptions<T> {
  /** The popup's `ngListbox`, present only while the popup shows at least one row. */
  readonly listbox: Signal<Listbox<T> | undefined>;
  /** How many options the listbox renders now. */
  readonly count: () => number;
  /** Anything whose change starts the list over with no active option, such as the rows or the open state. */
  readonly resetOn: () => unknown;
}

/**
 * Keeps an editable combobox's list with no active option until the first
 * arrow key (AECI-1860). AECI-1687 found the cause in `search-autocomplete.ts`.
 * The header search, docs search and the product picker all use it.
 *
 * Angular Aria's `ngListbox` makes its first option active as soon as it
 * renders, and the combobox mirrors that as `aria-activedescendant`. A screen
 * reader never speaks that option, the first Down lands on option 2, and Enter
 * commits option 1 unheard. Aria has no input to start with nothing active.
 *
 * The returned `navigated` flag is false until the visitor moves into the list.
 * The caller binds `[activeDescendant]="navigated() ? listbox.activeDescendant() : undefined"`
 * on the listbox and gates the row highlight on `data-navigated`. This helper:
 *
 * - pins the first Down to option 1 and the first Up to the last option, with
 *   the listbox's public `gotoIndex`. The pin runs in a microtask, after Aria's
 *   own handler for the same relayed key, so the wrong option is never exposed;
 * - swallows an Enter that Aria relays to the listbox before the first arrow
 *   key, so the silent default option is never committed. The capture listener
 *   sits on the listbox's parent, so it runs before Aria's listener on the
 *   listbox. The caller's own `(keydown.enter)` on the input still runs;
 * - resets `navigated` whenever `resetOn` changes.
 *
 * Call it in an injection context (a field initializer).
 */
export function listboxEntry<T>(options: ListboxEntryOptions<T>): WritableSignal<boolean> {
  const navigated = linkedSignal<unknown, boolean>({
    source: options.resetOn,
    computation: () => false,
  });

  effect((onCleanup) => {
    const listbox = options.listbox();
    if (!listbox) return;
    const element = listbox.element as HTMLElement;
    const parent = element.parentElement;

    const onKeydown = (event: KeyboardEvent) => {
      if (navigated() || !NAVIGATION_KEYS.has(event.key)) return;
      const key = event.key;
      queueMicrotask(() => {
        const count = options.count();
        if (count === 0) return;
        if (key === 'ArrowDown') listbox.gotoIndex(0);
        else if (key === 'ArrowUp') listbox.gotoIndex(count - 1);
        navigated.set(true);
        listbox.scrollActiveItemIntoView();
      });
    };
    const onEnterCapture = (event: KeyboardEvent) => {
      if (event.target === element && event.key === 'Enter' && !navigated()) {
        event.stopPropagation();
      }
    };

    element.addEventListener('keydown', onKeydown);
    parent?.addEventListener('keydown', onEnterCapture, { capture: true });
    onCleanup(() => {
      element.removeEventListener('keydown', onKeydown);
      parent?.removeEventListener('keydown', onEnterCapture, { capture: true });
    });
  });

  return navigated;
}
