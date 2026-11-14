/**
 * Tests for `InPageSmoothScroll` (AECI-1752). Named `.component.spec.ts` so it
 * runs under `ng test`: it needs Angular DI (`DOCUMENT`, `PLATFORM_ID`,
 * `DestroyRef`).
 *
 * It runs against the real jsdom document, so a click bubbles exactly as in a
 * browser. Each test resets the TestBed, which destroys the root injector and
 * removes the service's listener, and clears the `<html>` class.
 * `matchMedia` is stubbed per test because jsdom has none.
 */
import { DOCUMENT } from '@angular/common';
import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  InPageSmoothScroll,
  SMOOTH_SCROLL_CLASS,
  SMOOTH_SCROLL_DISARM_MS,
  SMOOTH_SCROLL_LINK_ATTR,
} from './in-page-smooth-scroll';

const root = () => document.documentElement;
const armed = () => root().classList.contains(SMOOTH_SCROLL_CLASS);

function configure(platform: 'browser' | 'server' = 'browser'): InPageSmoothScroll {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: DOCUMENT, useValue: document },
    ],
  });
  return TestBed.inject(InPageSmoothScroll);
}

// The service reads `matchMedia` off `document.defaultView`, which jsdom leaves
// undefined, so stub it there rather than on `globalThis`.
const view = document.defaultView as Window;
const originalMatchMedia = view.matchMedia;

function stubReducedMotion(reduce: boolean): void {
  view.matchMedia = ((query: string) => ({
    matches: reduce && query.includes('reduce'),
    media: query,
  })) as unknown as Window['matchMedia'];
}

/** Appends a link to the current page's `#target`, opted in unless told not to. */
function link(opts: { optIn?: boolean; href?: string } = {}): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = opts.href ?? `${document.location.pathname}${document.location.search}#target`;
  if (opts.optIn !== false) a.setAttribute(SMOOTH_SCROLL_LINK_ATTR, '');
  a.textContent = 'Jump';
  document.body.appendChild(a);
  return a;
}

/** A click the browser would treat as a plain left click unless `init` says otherwise. */
function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  // Stop jsdom running the link's default action. That leaves `defaultPrevented`
  // false while the service's document listener runs, as in a browser, because
  // a listener on `window` runs after the one on `document`.
  window.addEventListener('click', (e) => e.preventDefault(), { once: true });
  el.dispatchEvent(event);
  return event;
}

describe('InPageSmoothScroll', () => {
  beforeEach(() => stubReducedMotion(false));

  afterEach(() => {
    TestBed.resetTestingModule();
    root().classList.remove(SMOOTH_SCROLL_CLASS);
    document.body.replaceChildren();
    view.matchMedia = originalMatchMedia;
    vi.useRealTimers();
  });

  it('turns on smooth scrolling for an opted-in link to a section on this page', () => {
    configure().start();
    click(link());
    expect(armed()).toBe(true);
  });

  it('arms for a click on an element inside the link', () => {
    configure().start();
    const a = link();
    const span = document.createElement('span');
    a.appendChild(span);
    click(span);
    expect(armed()).toBe(true);
  });

  it('turns it off again when the scroll ends', () => {
    configure().start();
    click(link());
    document.dispatchEvent(new Event('scrollend'));
    expect(armed()).toBe(false);
  });

  it('turns it off after the fallback delay when no scroll ends', () => {
    vi.useFakeTimers();
    configure().start();
    click(link());
    vi.advanceTimersByTime(SMOOTH_SCROLL_DISARM_MS - 1);
    expect(armed()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(armed()).toBe(false);
  });

  it('does nothing for a link that has not opted in, such as the skip link', () => {
    configure().start();
    click(link({ optIn: false }));
    expect(armed()).toBe(false);
  });

  it('does nothing for an opted-in link to another page', () => {
    configure().start();
    click(link({ href: '/some/other/page#target' }));
    expect(armed()).toBe(false);
  });

  it('does nothing for an opted-in link with no fragment', () => {
    configure().start();
    click(link({ href: `${document.location.pathname}${document.location.search}` }));
    expect(armed()).toBe(false);
  });

  it('does nothing for a modified or non-primary click', () => {
    configure().start();
    const a = link();
    click(a, { metaKey: true });
    click(a, { ctrlKey: true });
    click(a, { shiftKey: true });
    click(a, { button: 1 });
    expect(armed()).toBe(false);
  });

  it('does nothing when a handler already cancelled the click', () => {
    configure().start();
    const a = link();
    a.addEventListener('click', (e) => e.preventDefault(), { once: true });
    click(a);
    expect(armed()).toBe(false);
  });

  it('does nothing under prefers-reduced-motion: reduce', () => {
    stubReducedMotion(true);
    configure().start();
    click(link());
    expect(armed()).toBe(false);
  });

  it('is a no-op on the server', () => {
    configure('server').start();
    click(link());
    expect(armed()).toBe(false);
  });

  it('stands down when <html> already carries the class (the switch back to global)', () => {
    root().classList.add(SMOOTH_SCROLL_CLASS);
    configure().start();
    click(link());
    document.dispatchEvent(new Event('scrollend'));
    // The service never removes a class it did not add.
    expect(armed()).toBe(true);
  });

  it('is idempotent and stops listening when the app is destroyed', () => {
    const service = configure();
    service.start();
    service.start();
    TestBed.resetTestingModule();
    click(link());
    expect(armed()).toBe(false);
  });
});
