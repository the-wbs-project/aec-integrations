import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SectionNav, type SectionNavItem } from './section-nav';

const sections: SectionNavItem[] = [
  { id: 'about', label: 'About' },
  { id: 'how-teams-use-it', label: 'How teams use it' },
  { id: 'integrations', label: 'Integrations' },
];

@Component({
  imports: [SectionNav],
  template: `<aec-section-nav [basePath]="'/products/egnyte'" [sections]="items()" />`,
})
class Host {
  items = signal<readonly SectionNavItem[]>(sections);
}

function setup(items: readonly SectionNavItem[] = sections) {
  TestBed.configureTestingModule({});
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.items.set(items);
  fixture.detectChanges();
  return fixture;
}

describe('SectionNav', () => {
  it('renders one anchor per section with a path-preserving absolute href + label', () => {
    const links = (setup().nativeElement as HTMLElement).querySelectorAll('nav a');
    expect(links).toHaveLength(3);
    // Absolute path (not "/#about") so <base href="/"> can't drop the route;
    // native same-document fragment scrolling then handles the jump + offset.
    expect(links[0]?.getAttribute('href')).toBe('/products/egnyte#about');
    expect(links[0]?.textContent?.trim()).toBe('About');
    expect(links[2]?.getAttribute('href')).toBe('/products/egnyte#integrations');
    expect(links[2]?.textContent?.trim()).toBe('Integrations');
  });

  it('exposes a nav landmark labelled "On this page"', () => {
    const nav = (setup().nativeElement as HTMLElement).querySelector('nav');
    expect(nav?.getAttribute('aria-label')).toBe('On this page');
  });

  it('marks the first link current before any interaction (AECI-831)', () => {
    const el = setup().nativeElement as HTMLElement;
    const current = el.querySelectorAll('a[aria-current="location"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toBe(el.querySelector('nav a'));
  });

  it('marks the clicked link aria-current="location" for instant feedback', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const link = el.querySelectorAll('nav a')[2] as HTMLAnchorElement; // Integrations

    link.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
    fixture.detectChanges();

    expect(link.getAttribute('aria-current')).toBe('location');
    // Only one link is active at a time.
    expect(el.querySelectorAll('a[aria-current="location"]')).toHaveLength(1);
  });

  it('never prevents the native jump, so the browser does the scrolling (AECI-1655)', () => {
    const fixture = setup();
    const link = (fixture.nativeElement as HTMLElement).querySelectorAll('nav a')[1]!;

    const click = new MouseEvent('click', { cancelable: true, bubbles: true });
    link.dispatchEvent(click);

    expect(click.defaultPrevented).toBe(false);
  });

  it('marks the link current when the click lands on a child of the anchor', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    const link = el.querySelectorAll('nav a')[1] as HTMLAnchorElement;
    const inner = document.createElement('span');
    link.appendChild(inner);

    inner.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
    fixture.detectChanges();

    expect(link.getAttribute('aria-current')).toBe('location');
  });

  it('ignores a click on the nav outside any link', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;

    el.querySelector('ul')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    fixture.detectChanges();

    // Still the first-link default.
    expect(el.querySelector('a[aria-current="location"]')).toBe(el.querySelector('nav a'));
  });

  // AECI-1856: a section shorter than the spy's band (a short About) left the
  // next section in the band too, and the spy named that one after the click.
  describe('a clicked section stays current (AECI-1856)', () => {
    type Callback = (entries: Partial<IntersectionObserverEntry>[]) => void;
    let callback: Callback | null = null;

    function withSpy() {
      callback = null;
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          constructor(cb: Callback) {
            callback = cb;
          }
          observe() {}
          disconnect() {}
        },
      );
      for (const s of sections) {
        const el = document.createElement('section');
        el.id = s.id;
        document.body.appendChild(el);
      }
      const fixture = setup();
      const el = fixture.nativeElement as HTMLElement;
      const spy = (...ids: string[]) => {
        callback!(
          ids.map((id) => ({ isIntersecting: true, target: document.getElementById(id)! })),
        );
        fixture.detectChanges();
      };
      const current = () =>
        el.querySelector('a[aria-current="location"]')?.getAttribute('data-section-id');
      return { fixture, el, spy, current };
    }

    afterEach(() => {
      vi.unstubAllGlobals();
      for (const s of sections) document.getElementById(s.id)?.remove();
    });

    it('keeps the clicked short section current when the next one enters the band too', () => {
      const { fixture, el, spy, current } = withSpy();
      spy('integrations');
      expect(current()).toBe('integrations');

      el.querySelector<HTMLAnchorElement>('a[data-section-id="about"]')!.click();
      fixture.detectChanges();
      // The jump puts About and the section after it in the band at once.
      spy('about', 'how-teams-use-it');
      expect(current()).toBe('about');
    });

    it('hands back to the spy once the reader scrolls', () => {
      const { fixture, el, spy, current } = withSpy();
      el.querySelector<HTMLAnchorElement>('a[data-section-id="about"]')!.click();
      fixture.detectChanges();
      spy('how-teams-use-it');
      expect(current()).toBe('about');

      window.dispatchEvent(new WheelEvent('wheel'));
      spy('integrations');
      expect(current()).toBe('integrations');
    });

    it('follows the spy when nothing was clicked', () => {
      const { spy, current } = withSpy();
      spy('how-teams-use-it');
      expect(current()).toBe('how-teams-use-it');
    });
  });

  it('drops sticky in print so the bar does not print over the page (AECI-1856)', () => {
    const host = (setup().nativeElement as HTMLElement).querySelector('aec-section-nav')!;
    expect(host.classList).toContain('sticky');
    expect(host.classList).toContain('print:static');
  });
});
