/**
 * Tests for `RouteFocus` (AECI-1855). Named `.component.spec.ts` so it runs under
 * `ng test`: it needs Angular DI and `afterNextRender`.
 *
 * The `Router` is a stub driven through a `Subject`. The page is real DOM: a
 * `<main id="main" tabindex="-1">` like the app shell's, with an `h1` inside.
 */
import { ApplicationRef, Injector, PLATFORM_ID, afterNextRender } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  type Event,
  NavigationEnd,
  NavigationSkipped,
  NavigationSkippedCode,
  NavigationStart,
  Router,
} from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';

import { ROUTE_FOCUS_ATTR, RouteFocus } from './route-focus';

let navId = 0;

function add<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tag: K,
  id: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.id = id;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

/** The shell: a header link, then `<main>` with an h1, a card link and a box. */
function buildPage(): void {
  document.body.replaceChildren();
  const header = add(document.body, 'header', 'header');
  add(header, 'a', 'header-link', 'Header link').setAttribute('href', '/a');
  const main = add(document.body, 'main', 'main');
  main.tabIndex = -1;
  add(main, 'h1', 'title', 'Page title');
  add(main, 'a', 'in-page', 'A card').setAttribute('href', '/b');
  add(main, 'input', 'search');
}

function setup(platform: 'browser' | 'server' = 'browser') {
  const events = new Subject<Event>();
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: Router, useValue: { events } },
    ],
  });
  const service = TestBed.inject(RouteFocus);
  const appRef = TestBed.inject(ApplicationRef);
  buildPage();

  const start = (url: string) => {
    navId++;
    events.next(new NavigationStart(navId, url));
  };
  const end = (url: string) => {
    events.next(new NavigationEnd(navId, url, url));
    appRef.tick();
  };
  const navigate = (url: string) => {
    start(url);
    end(url);
  };
  const skip = (url: string) => {
    start(url);
    events.next(
      new NavigationSkipped(navId, url, '', NavigationSkippedCode.IgnoredSameUrlNavigation),
    );
    appRef.tick();
  };
  /** NavigationEnd with no render yet, so a test can queue the page's own hooks first. */
  const endBeforeRender = (url: string) => events.next(new NavigationEnd(navId, url, url));
  service.start();
  // The initial (hydration) navigation.
  navigate('/products');
  return { service, start, end, navigate, skip, endBeforeRender, appRef };
}

const el = (id: string) => document.getElementById(id) as HTMLElement;

describe('RouteFocus (AECI-1855)', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('does nothing on the initial navigation', () => {
    setup();
    expect(document.activeElement).toBe(document.body);
  });

  it('moves focus to the page h1 after a navigation to another path', () => {
    const { navigate } = setup();
    navigate('/products/procore');
    expect(document.activeElement).toBe(el('title'));
    expect(el('title').getAttribute('tabindex')).toBe('-1');
    expect(el('title').hasAttribute(ROUTE_FOCUS_ATTR)).toBe(true);
  });

  it('takes the tabindex and the marker off the heading when focus lands elsewhere', () => {
    const { navigate } = setup();
    navigate('/products/procore');
    el('in-page').focus();
    expect(el('title').hasAttribute('tabindex')).toBe(false);
    expect(el('title').hasAttribute(ROUTE_FOCUS_ATTR)).toBe(false);
  });

  it('keeps them through a window or tab blur, so focus can come back to the heading', () => {
    const { navigate } = setup();
    navigate('/products/procore');
    const heading = el('title');
    // What the browser fires on the focused element when the window loses focus.
    heading.dispatchEvent(new FocusEvent('blur'));
    heading.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(heading.getAttribute('tabindex')).toBe('-1');
    expect(heading.hasAttribute(ROUTE_FOCUS_ATTR)).toBe(true);
    // The window comes back: focus returns to the heading, still focusable.
    heading.focus();
    expect(document.activeElement).toBe(heading);
    expect(heading.getAttribute('tabindex')).toBe('-1');
  });

  it("runs after the page's own default-phase afterNextRender, so a page's focus wins", () => {
    const { start, endBeforeRender, appRef } = setup();
    const heading = el('title');
    let headingFocused = 0;
    const original = heading.focus.bind(heading);
    heading.focus = (o?: FocusOptions) => {
      headingFocused++;
      original(o);
    };
    el('header-link').focus();
    start('/search');
    endBeforeRender('/search');
    // The routed page queues its own focus after NavigationEnd, in the default phase.
    // RouteFocus queued first, in the read phase, so it must still run second.
    afterNextRender(() => el('search').focus(), { injector: TestBed.inject(Injector) });
    appRef.tick();
    expect(document.activeElement).toBe(el('search'));
    expect(headingFocused).toBe(0);
  });

  it('falls back to <main> when the page has no h1', () => {
    const { navigate } = setup();
    el('title').remove();
    navigate('/about');
    expect(document.activeElement).toBe(el('main'));
  });

  it('moves focus off a header link that stays on screen', () => {
    const { start, end } = setup();
    el('header-link').focus();
    start('/about');
    end('/about');
    expect(document.activeElement).toBe(el('title'));
  });

  it('moves focus off the pressed link when the page reuses it', () => {
    const { start, end } = setup();
    el('in-page').focus();
    start('/products/other');
    end('/products/other');
    expect(document.activeElement).toBe(el('title'));
  });

  it('leaves focus the new page set itself inside <main>', () => {
    const { start, end } = setup();
    el('header-link').focus();
    start('/search');
    el('search').focus(); // the page focused its own box during render
    end('/search');
    expect(document.activeElement).toBe(el('search'));
  });

  it('leaves focus alone when only the query or the fragment changed', () => {
    const { start, end } = setup();
    el('search').focus();
    start('/products?sort=name');
    end('/products?sort=name');
    expect(document.activeElement).toBe(el('search'));
    start('/products?sort=name#top');
    end('/products?sort=name#top');
    expect(document.activeElement).toBe(el('search'));
  });

  it('on a skipped navigation moves focus only when it was lost', () => {
    const { skip } = setup();
    el('search').focus();
    skip('/products');
    expect(document.activeElement).toBe(el('search'));

    el('search').blur();
    skip('/products');
    expect(document.activeElement).toBe(el('title'));
  });

  it('focusPage() never scrolls', () => {
    const { service } = setup();
    let options: FocusOptions | undefined;
    const heading = el('title');
    const original = heading.focus.bind(heading);
    heading.focus = (o?: FocusOptions) => {
      options = o;
      original(o);
    };
    service.focusPage();
    expect(options).toEqual({ preventScroll: true });
  });

  it('is a no-op on the server', () => {
    const { navigate } = setup('server');
    navigate('/products/procore');
    expect(document.activeElement).toBe(document.body);
  });
});
