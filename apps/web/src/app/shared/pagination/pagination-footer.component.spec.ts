import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PaginationFooter } from './pagination-footer';

/**
 * The append-mode listing footer (`/products`, taxonomy browse). The
 * load-bearing guarantees: the "Showing X of Z" status line, a real "Load more"
 * anchor that intercepts an unmodified left-click (emit + `preventDefault`) but
 * lets modified clicks fall through to the genuine `?page=N+1` href, and the
 * "reached the end" terminal state. The `IntersectionObserver` auto-load is
 * browser-only (guarded by `typeof IntersectionObserver`) and does not run under
 * the jsdom unit-test environment, so these tests pin the SSR-safe surface.
 */
function create(
  inputs: {
    loadedCount: number;
    total: number | null;
    hasMore: boolean;
    pending: boolean;
    nextHref?: string | null;
  } = { loadedCount: 2, total: 50, hasMore: true, pending: false },
) {
  TestBed.configureTestingModule({
    providers: [provideZonelessChangeDetection()],
  });
  const fixture = TestBed.createComponent(PaginationFooter);
  fixture.componentRef.setInput('loadedCount', inputs.loadedCount);
  fixture.componentRef.setInput('total', inputs.total);
  fixture.componentRef.setInput('hasMore', inputs.hasMore);
  fixture.componentRef.setInput('pending', inputs.pending);
  fixture.componentRef.setInput('nextHref', inputs.nextHref ?? null);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

function loadMoreLink(el: HTMLElement): HTMLAnchorElement | null {
  return el.querySelector('a');
}

describe('PaginationFooter', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the "Showing X of Z" status line once total is known', () => {
    const { el } = create({ loadedCount: 2, total: 50, hasMore: true, pending: false });
    expect(el.textContent).toContain('Showing 2 of 50');
  });

  it('omits the status count while total is null (before the first load resolves)', () => {
    const { el } = create({ loadedCount: 0, total: null, hasMore: false, pending: true });
    expect(el.textContent).not.toContain('Showing');
  });

  it('renders the "Load more" anchor pointing at the next-page href when more remains', () => {
    const { el } = create({
      loadedCount: 24,
      total: 50,
      hasMore: true,
      pending: false,
      nextHref: '/products?page=2',
    });
    const link = loadMoreLink(el);
    expect(link).not.toBeNull();
    expect(link?.textContent).toContain('Load more');
    expect(link?.getAttribute('href')).toBe('/products?page=2');
  });

  it('emits loadMore and prevents navigation on a plain left-click', () => {
    const { fixture, el } = create({
      loadedCount: 24,
      total: 50,
      hasMore: true,
      pending: false,
      nextHref: '/products?page=2',
    });
    let emitted = 0;
    fixture.componentInstance.loadMore.subscribe(() => (emitted += 1));

    const event = new MouseEvent('click', { button: 0, bubbles: true, cancelable: true });
    loadMoreLink(el)?.dispatchEvent(event);

    expect(emitted).toBe(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('lets a modified click fall through to the real href (open-in-new-tab)', () => {
    const { fixture, el } = create({
      loadedCount: 24,
      total: 50,
      hasMore: true,
      pending: false,
      nextHref: '/products?page=2',
    });
    let emitted = 0;
    fixture.componentInstance.loadMore.subscribe(() => (emitted += 1));

    const event = new MouseEvent('click', {
      button: 0,
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    loadMoreLink(el)?.dispatchEvent(event);

    expect(emitted).toBe(0);
    expect(event.defaultPrevented).toBe(false);
  });

  it('shows the spinner label and aria-busy on the anchor while a fetch is pending', () => {
    const { el } = create({
      loadedCount: 24,
      total: 50,
      hasMore: true,
      pending: true,
      nextHref: '/products?page=2',
    });
    const link = loadMoreLink(el);
    expect(link?.getAttribute('aria-busy')).toBe('true');
    expect(link?.textContent).toContain('Loading');
  });

  it('renders a real <button> when there is no nextHref, not a hrefless anchor', () => {
    // The admin screens fetch client-side behind `requireAdmin()`, so there is no
    // SSR'd `?page=2` to point at. An `<a>` with no `href` is not focusable, which
    // would silently leave scroll auto-load as the only way to page.
    const { fixture, el } = create({ loadedCount: 25, total: 200, hasMore: true, pending: false });
    expect(loadMoreLink(el)).toBeNull();
    const button = el.querySelector('button');
    expect(button?.textContent).toContain('Load more');

    let emitted = 0;
    fixture.componentInstance.loadMore.subscribe(() => (emitted += 1));
    button?.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
    expect(emitted).toBe(1);
  });

  it('renders the terminal "reached the end" state instead of a link when nothing remains', () => {
    const { el } = create({ loadedCount: 50, total: 50, hasMore: false, pending: false });
    expect(loadMoreLink(el)).toBeNull();
    expect(el.textContent).toContain("You've reached the end");
    expect(el.textContent).toContain('50 in total');
  });

  describe('scroll auto-load', () => {
    /** Stand-in observer: records live instances so a test can fire their callback. */
    const live: FakeObserver[] = [];
    class FakeObserver {
      constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {
        live.push(this);
      }
      observe(): void {}
      disconnect(): void {
        live.splice(live.indexOf(this), 1);
      }
    }

    beforeEach(() => {
      live.length = 0;
      vi.stubGlobal('IntersectionObserver', FakeObserver);
    });
    afterEach(() => vi.unstubAllGlobals());

    it('re-arms after each load so a sentinel that never left the margin still loads again', async () => {
      const { fixture } = create({ loadedCount: 12, total: 100, hasMore: true, pending: false });
      await fixture.whenStable();
      let emitted = 0;
      fixture.componentInstance.loadMore.subscribe(() => (emitted += 1));

      live[0].callback([{ isIntersecting: true }]);
      expect(emitted).toBe(1);

      // In flight: the pending guard stops a double load.
      fixture.componentRef.setInput('pending', true);
      await fixture.whenStable();
      live[0].callback([{ isIntersecting: true }]);
      expect(emitted).toBe(1);

      // The page landed but was too short to push the sentinel out of the
      // margin. A fresh observer's initial report is the only event there will
      // be, and it must load the next page.
      const first = live[0];
      fixture.componentRef.setInput('loadedCount', 24);
      fixture.componentRef.setInput('pending', false);
      await fixture.whenStable();
      expect(live).toHaveLength(1);
      expect(live[0]).not.toBe(first);
      live[0].callback([{ isIntersecting: true }]);
      expect(emitted).toBe(2);
    });

    it('does not re-arm after a failed load, so an error cannot retry in a loop', async () => {
      const { fixture } = create({ loadedCount: 24, total: 100, hasMore: true, pending: true });
      await fixture.whenStable();
      const armed = live[0];
      // The fetch failed: pending clears but no page landed.
      fixture.componentRef.setInput('pending', false);
      await fixture.whenStable();
      expect(live).toEqual([armed]);
    });
  });
});
