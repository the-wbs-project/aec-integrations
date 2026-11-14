import { EventPhase } from '@angular/core/primitives/event-dispatch';
import { afterEach, describe, expect, it } from 'vitest';

import { inAppLinkPath } from './in-app-link-click';

// A DOM spec, so it runs in the component runner (jsdom), not the node runner.

const SELECTOR = '#panel a[href]';

let root: HTMLElement | undefined;

/** A panel with one link (holding a span) and one link outside the panel. */
function setup(attrs: Record<string, string> = { href: '/phases' }) {
  root = document.createElement('div');
  const panel = document.createElement('div');
  panel.id = 'panel';
  const link = document.createElement('a');
  const span = document.createElement('span');
  span.textContent = 'Phases';
  link.appendChild(span);
  for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
  panel.appendChild(link);
  const outside = document.createElement('a');
  outside.href = '/x';
  root.appendChild(panel);
  root.appendChild(outside);
  document.body.appendChild(root);
  return { link, span, outside };
}

/** Dispatch a click on `target` and return the path the helper chose. */
function clickPath(target: Element, init: MouseEventInit = {}, mutate?: (e: MouseEvent) => void) {
  let path: string | null | undefined;
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  mutate?.(event);
  const read = (e: Event) => (path = inAppLinkPath(e as MouseEvent, SELECTOR));
  // Runs after `read`: keeps jsdom from attempting a navigation.
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener('click', read);
  document.addEventListener('click', stop);
  target.dispatchEvent(event);
  document.removeEventListener('click', read);
  document.removeEventListener('click', stop);
  return path;
}

describe('inAppLinkPath', () => {
  afterEach(() => root?.remove());

  it('returns the path for a plain primary click inside a matched link', () => {
    const { span } = setup();
    expect(clickPath(span)).toBe('/phases');
  });

  it('keeps the query string and fragment', () => {
    const { link } = setup({ href: '/search?q=revit#top' });
    expect(clickPath(link)).toBe('/search?q=revit#top');
  });

  it('ignores a link outside the selector', () => {
    const { outside } = setup();
    expect(clickPath(outside)).toBeNull();
  });

  it.each([
    ['protocol-relative', { href: '//evil.example/x' }],
    ['absolute', { href: 'https://example.com/x' }],
    ['fragment-only', { href: '#x' }],
    ['target', { href: '/x', target: '_blank' }],
    ['download', { href: '/x', download: '' }],
  ])('leaves a %s link to the browser', (_name, attrs) => {
    const { link } = setup(attrs);
    expect(clickPath(link)).toBeNull();
  });

  it.each([
    ['middle-button', { button: 1 }],
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
  ])('leaves a %s click to the browser', (_name, init) => {
    const { link } = setup();
    expect(clickPath(link, init)).toBeNull();
  });

  it('ignores a click something already prevented (a RouterLink)', () => {
    const { link } = setup();
    link.addEventListener('click', (e) => e.preventDefault(), { once: true });
    expect(clickPath(link)).toBeNull();
  });

  it('ignores a replayed click, whose native default already ran', () => {
    const { link } = setup();
    const path = clickPath(link, {}, (e) =>
      Object.defineProperty(e, 'eventPhase', { value: EventPhase.REPLAY }),
    );
    expect(path).toBeNull();
  });
});
