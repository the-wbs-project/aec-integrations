import { afterEach, describe, expect, it } from 'vitest';

import { isSearchShortcut, SEARCH_SHORTCUT_ARIA } from './search-shortcut';

/** The shortcut guard (AECI-1772). Pure: it reads the event and the document. */
describe('isSearchShortcut', () => {
  const added: HTMLElement[] = [];

  function add(tag: string, attrs: Record<string, string> = {}): HTMLElement {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.appendChild(el);
    added.push(el);
    return el;
  }

  function key(init: KeyboardEventInit, target: Element = document.body): KeyboardEvent {
    let captured!: KeyboardEvent;
    const listener = (e: Event) => (captured = e as KeyboardEvent);
    target.addEventListener('keydown', listener, { once: true });
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: '/', code: 'Slash', bubbles: true, ...init }),
    );
    return captured;
  }

  afterEach(() => {
    for (const el of added.splice(0)) el.remove();
  });

  it('accepts Ctrl+/ and Cmd+/ from the page body', () => {
    expect(isSearchShortcut(key({ ctrlKey: true }), document)).toBe(true);
    expect(isSearchShortcut(key({ metaKey: true }), document)).toBe(true);
  });

  it('accepts the slash on a layout where it needs Shift (key "/", code not Slash)', () => {
    expect(isSearchShortcut(key({ ctrlKey: true, code: 'Digit7', shiftKey: true }), document)).toBe(
      true,
    );
  });

  it('rejects a bare slash: a character key shortcut with no way to turn it off', () => {
    expect(isSearchShortcut(key({}), document)).toBe(false);
    expect(isSearchShortcut(key({ shiftKey: true }), document)).toBe(false);
  });

  it('rejects other keys, Alt, and both modifiers at once', () => {
    expect(isSearchShortcut(key({ ctrlKey: true, key: 'k', code: 'KeyK' }), document)).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, altKey: true }), document)).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, metaKey: true }), document)).toBe(false);
  });

  it('rejects a key typed in an input, textarea, select or contenteditable', () => {
    for (const tag of ['input', 'textarea', 'select']) {
      expect(isSearchShortcut(key({ ctrlKey: true }, add(tag)), document), tag).toBe(false);
    }
    const editable = add('div', { contenteditable: 'true' });
    expect(isSearchShortcut(key({ ctrlKey: true }, editable), document)).toBe(false);
    const child = document.createElement('span');
    editable.appendChild(child);
    expect(isSearchShortcut(key({ ctrlKey: true }, child), document)).toBe(false);
  });

  it('allows contenteditable="false" and ordinary elements', () => {
    expect(
      isSearchShortcut(key({ ctrlKey: true }, add('div', { contenteditable: 'false' })), document),
    ).toBe(true);
    expect(isSearchShortcut(key({ ctrlKey: true }, add('button')), document)).toBe(true);
  });

  it('rejects while a dialog is open', () => {
    add('div', { role: 'dialog' });
    expect(isSearchShortcut(key({ ctrlKey: true }), document)).toBe(false);
  });

  it('rejects an event something else already handled, and an IME composition', () => {
    const handled = key({ ctrlKey: true, cancelable: true });
    handled.preventDefault();
    expect(isSearchShortcut(handled, document)).toBe(false);
    expect(isSearchShortcut(key({ ctrlKey: true, isComposing: true }), document)).toBe(false);
  });

  it('names both platform forms for assistive technology', () => {
    expect(SEARCH_SHORTCUT_ARIA).toBe('Control+/ Meta+/');
  });
});
