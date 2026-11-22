import {
  Component,
  PLATFORM_ID,
  REQUEST,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClaimStatus } from '@aeci/shared';

import { SectionNav, type SectionNavItem } from './section-nav';

const sections: SectionNavItem[] = [
  { id: 'about', label: 'About' },
  { id: 'how-teams-use-it', label: 'How teams use it' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'reviews', label: 'Reviews', count: 212 },
];

@Component({
  imports: [SectionNav],
  template: `<aec-section-nav
    [sections]="items()"
    [pageName]="name()"
    [rest]="rest()"
    [claimStatus]="claim()"
  />`,
})
class Host {
  items = signal<readonly SectionNavItem[]>(sections);
  name = signal<string | null>('Bluebeam Revu');
  rest = signal<'solid' | 'clear'>('solid');
  claim = signal<ClaimStatus | null>(null);
}

const Stub = class {};

/**
 * A controllable IntersectionObserver. jsdom has none, so the component's browser-only observers
 * would never be built. Each instance records its options and targets, and `fire` delivers an
 * entry the way the browser would.
 */
class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly targets: Element[] = [];
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.targets.push(el);
  }
  unobserve() {}
  disconnect() {
    this.targets.length = 0;
  }
  takeRecords() {
    return [];
  }
  fire(entry: Partial<IntersectionObserverEntry>) {
    this.callback([entry as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

/** The observer watching the host for the stuck state (threshold [1]). */
const stuckObserver = () => FakeObserver.instances.find((o) => Array.isArray(o.options.threshold))!;

async function setup(
  opts: {
    url?: string;
    platform?: 'browser' | 'server';
    cookie?: string;
    items?: readonly SectionNavItem[];
    name?: string | null;
    rest?: 'solid' | 'clear';
    claim?: ClaimStatus | null;
  } = {},
): Promise<ComponentFixture<Host>> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', component: Stub }]),
      { provide: PLATFORM_ID, useValue: opts.platform ?? 'browser' },
      ...(opts.cookie === undefined
        ? []
        : [
            {
              provide: REQUEST,
              useValue: new Request('https://www.aecintegrations.com/', {
                headers: { cookie: opts.cookie, 'accept-language': 'de-DE' },
              }),
            },
          ]),
    ],
  });
  await TestBed.inject(Router).navigateByUrl(opts.url ?? '/products/bluebeam-revu');
  const fixture = TestBed.createComponent(Host);
  if (opts.items) fixture.componentInstance.items.set(opts.items);
  if (opts.name !== undefined) fixture.componentInstance.name.set(opts.name);
  if (opts.rest) fixture.componentInstance.rest.set(opts.rest);
  if (opts.claim !== undefined) fixture.componentInstance.claim.set(opts.claim);
  fixture.detectChanges();
  await fixture.whenStable();
  return fixture;
}

const links = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>('nav a')];

describe('SectionNav', () => {
  beforeEach(() => {
    FakeObserver.instances = [];
    vi.stubGlobal('IntersectionObserver', FakeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe('links', () => {
    it('renders one anchor per section with a path-preserving href and its label', async () => {
      const el = (await setup()).nativeElement as HTMLElement;
      const a = links(el);
      expect(a).toHaveLength(4);
      // Absolute path (not "/#about") so <base href="/"> can't drop the route.
      expect(a[0]!.getAttribute('href')).toBe('/products/bluebeam-revu#about');
      expect(a[2]!.getAttribute('href')).toBe('/products/bluebeam-revu#integrations');
      for (const link of a) expect(link.hasAttribute('data-smooth-scroll')).toBe(true);
    });

    // AECI-1843: a path-only href on a URL with a query pointed at a different URL, so the
    // browser loaded the whole page again and lost the campaign params.
    it('keeps the whole query in the browser, so a click is a same-document jump', async () => {
      const el = (await setup({ url: '/products/bluebeam-revu?utm_source=mail&view=basic' }))
        .nativeElement as HTMLElement;
      expect(links(el).map((a) => a.getAttribute('href'))).toEqual([
        '/products/bluebeam-revu?utm_source=mail&view=basic#about',
        '/products/bluebeam-revu?utm_source=mail&view=basic#how-teams-use-it',
        '/products/bluebeam-revu?utm_source=mail&view=basic#integrations',
        '/products/bluebeam-revu?utm_source=mail&view=basic#reviews',
      ]);
    });

    it('follows a client-side navigation to another page', async () => {
      const fixture = await setup();
      await TestBed.inject(Router).navigateByUrl('/products/procore?ref=x');
      fixture.detectChanges();
      expect(links(fixture.nativeElement)[0]!.getAttribute('href')).toBe(
        '/products/procore?ref=x#about',
      );
    });

    it('names the nav landmark "On this page"', async () => {
      const nav = ((await setup()).nativeElement as HTMLElement).querySelector('nav');
      expect(nav?.getAttribute('aria-label')).toBe('On this page');
    });
  });

  // The product page is edge-cached on its path alone. Every request that shares that key
  // must get byte-identical nav markup, whatever query, cookie or header it carried.
  describe('server render is cache-neutral', () => {
    const variants = [
      { url: '/products/bluebeam-revu' },
      { url: '/products/bluebeam-revu?utm_source=mail&utm_campaign=nov' },
      { url: '/products/bluebeam-revu?view=basic&fbclid=1#reviews' },
      { url: '/products/bluebeam-revu', cookie: 'sb-access-token=abc; aeci_consent=all' },
      { url: '/products/bluebeam-revu?gclid=9', cookie: 'aeci_notice_dismissed=1' },
    ];

    it('renders byte-identical markup for every request on one cache key', async () => {
      const html: string[] = [];
      for (const v of variants) {
        const fixture = await setup({ ...v, platform: 'server' });
        html.push((fixture.nativeElement as HTMLElement).innerHTML);
      }
      expect(new Set(html).size).toBe(1);
      expect(html[0]).toContain('href="/products/bluebeam-revu#about"');
      expect(html[0]).not.toContain('utm_');
    });

    it('renders an unclaimed listing byte-identical to a claimed one, with no tag (ruling 41)', async () => {
      const html: string[] = [];
      for (const claim of ['unclaimed', 'claimed', null] as const) {
        const fixture = await setup({ platform: 'server', claim });
        html.push((fixture.nativeElement as HTMLElement).innerHTML);
      }
      expect(new Set(html).size).toBe(1);
      expect(html[0]).not.toContain('section-nav-unclaimed');
    });

    it('never renders the stuck brand cluster or builds the stuck observer on the server', async () => {
      const el = (await setup({ platform: 'server', claim: 'unclaimed' }))
        .nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="section-nav-brand"]')).toBeNull();
      expect(el.querySelector('aec-section-nav')!.hasAttribute('data-stuck')).toBe(false);
      // The stuck observer is gated on the platform. (The scroll-spy is an `afterRenderEffect`,
      // which a real server render never runs; TestBed runs it on any platform.)
      expect(FakeObserver.instances.filter((o) => Array.isArray(o.options.threshold))).toHaveLength(
        0,
      );
    });
  });

  // AECI-1778: the caller says what the bar sits on at rest. The CSS keys off the attribute.
  describe('the bar at rest', () => {
    it('is solid by default and says so on the host', async () => {
      const el = (await setup()).nativeElement as HTMLElement;
      expect(el.querySelector('aec-section-nav')!.getAttribute('data-rest')).toBe('solid');
    });

    it('renders rest="clear" on the server, never stuck, so cached HTML is one look', async () => {
      const el = (await setup({ platform: 'server', rest: 'clear' })).nativeElement as HTMLElement;
      const host = el.querySelector('aec-section-nav')!;
      expect(host.getAttribute('data-rest')).toBe('clear');
      expect(host.hasAttribute('data-stuck')).toBe(false);
    });
  });

  describe('the current section', () => {
    it('marks the first link current before any interaction (AECI-831)', async () => {
      const el = (await setup()).nativeElement as HTMLElement;
      const current = el.querySelectorAll('a[aria-current="location"]');
      expect(current).toHaveLength(1);
      expect(current[0]).toBe(links(el)[0]);
    });

    it('marks the clicked link current for instant feedback, one at a time', async () => {
      const fixture = await setup();
      const el = fixture.nativeElement as HTMLElement;
      const link = links(el)[2]!;
      link.addEventListener('click', (e) => e.preventDefault()); // keep jsdom on the page
      link.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
      fixture.detectChanges();
      expect(link.getAttribute('aria-current')).toBe('location');
      expect(el.querySelectorAll('a[aria-current="location"]')).toHaveLength(1);
    });

    it('never prevents the native jump, so the browser does the scrolling (AECI-1655)', async () => {
      const link = links((await setup()).nativeElement)[1]!;
      let prevented: boolean | null = null;
      // Read after the host's bubbling listener has run, then stop jsdom navigating.
      window.addEventListener(
        'click',
        (e) => {
          prevented = e.defaultPrevented;
          e.preventDefault();
        },
        { once: true },
      );
      link.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
      expect(prevented).toBe(false);
    });

    it('follows the scroll-spy', async () => {
      const fixture = await setup();
      const spy = FakeObserver.instances.find((o) => !Array.isArray(o.options.threshold))!;
      expect(spy.targets).toHaveLength(0); // no sections in this host's DOM
      const target = document.createElement('section');
      target.id = 'reviews';
      spy.fire({ isIntersecting: true, target });
      fixture.detectChanges();
      const el = fixture.nativeElement as HTMLElement;
      expect(el.querySelector('a[aria-current="location"]')!.getAttribute('data-section-id')).toBe(
        'reviews',
      );
    });

    // The bold copy is aria-hidden and invisible: it only holds the 600 width so the current
    // item never moves its neighbours. The accessible name is the label once.
    it('reserves the bold width with a hidden copy that screen readers skip', async () => {
      const a = links((await setup()).nativeElement)[0]!;
      const copies = a.querySelectorAll('span.grid > span');
      expect(copies).toHaveLength(2);
      expect(copies[1]!.getAttribute('aria-hidden')).toBe('true');
      expect(copies[1]!.className).toContain('invisible');
      expect(copies[1]!.className).toContain('font-semibold');
    });
  });

  describe('counts', () => {
    it('prints a quiet tabular count only where the section has one', async () => {
      const el = (await setup()).nativeElement as HTMLElement;
      const counts = el.querySelectorAll('[data-testid="section-nav-count"]');
      expect(counts).toHaveLength(1);
      expect(counts[0]!.textContent!.trim()).toBe('212');
      expect(counts[0]!.className).toContain('tabular-nums');
      expect(counts[0]!.className).toContain('text-t-13');
      expect(counts[0]!.closest('a')!.getAttribute('data-section-id')).toBe('reviews');
    });

    it('prints a zero count rather than hiding it', async () => {
      const el = (
        await setup({ items: [...sections.slice(0, 3), { id: 'r', label: 'R', count: 0 }] })
      ).nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="section-nav-count"]')!.textContent!.trim()).toBe('0');
    });
  });

  // PLAN.md §8.5 and DESIGN.md §5: once stuck, the bar leads with OUR wordmark and the page
  // name as text. Never a vendor logo, mark or colour.
  describe('the stuck bar', () => {
    it('watches the host with a root grown below the viewport, so only the top edge counts', async () => {
      const fixture = await setup();
      const o = stuckObserver();
      expect(o.targets).toEqual([fixture.nativeElement.querySelector('aec-section-nav')]);
      expect(o.options.rootMargin).toBe('-1px 0px 100000px 0px');
      expect(o.options.threshold).toEqual([1]);
    });

    it('shows nothing before the bar sticks', async () => {
      const el = (await setup()).nativeElement as HTMLElement;
      expect(el.querySelector('[data-testid="section-nav-brand"]')).toBeNull();
    });

    it('leads with our wordmark linked home, then the page name as plain text', async () => {
      const fixture = await setup();
      stuckObserver().fire({ intersectionRatio: 0.98, boundingClientRect: { top: 0 } as DOMRect });
      fixture.detectChanges();
      await fixture.whenStable();
      const el = fixture.nativeElement as HTMLElement;
      const host = el.querySelector('aec-section-nav')!;
      expect(host.hasAttribute('data-stuck')).toBe(true);

      const brand = el.querySelector('[data-testid="section-nav-brand"]')!;
      // The wordmark link (from md) and the monogram link (below md). CSS shows one.
      const homes = [...brand.querySelectorAll('a')];
      expect(homes).toHaveLength(2);
      for (const home of homes) {
        expect(home.getAttribute('href')).toBe('/');
        expect(home.getAttribute('aria-label')).toBe('AEC Integrations home');
        // The brand links sit outside the "On this page" landmark.
        expect(home.closest('nav')).toBeNull();
      }
      expect(homes[0]!.closest('.md\\:flex')).not.toBeNull();
      expect(homes[1]!.className).toContain('md:hidden');
      expect(brand.textContent).toContain('Bluebeam Revu');
      // The name is text, not a link and not a heading.
      expect(brand.querySelector('h1, h2, h3, h4')).toBeNull();
      // Every image in the bar is one of ours. No vendor logo can reach it.
      const srcs = [...host.querySelectorAll('img')].map((i) => i.getAttribute('src'));
      expect(srcs.length).toBeGreaterThan(0);
      for (const src of srcs) expect(src).toMatch(/^\/branding\/(wordmark|monogram-light)\.svg$/);
    });

    // Ruling 41 (Q61, docs/LEGAL_COUNSEL_RECORD.md): a short "Unclaimed" tag beside the name.
    describe('the Unclaimed tag (ruling 41)', () => {
      async function stuckWith(claim: ClaimStatus | null, name: string | null = 'Bluebeam Revu') {
        const fixture = await setup({ claim, name });
        stuckObserver().fire({
          intersectionRatio: 0.98,
          boundingClientRect: { top: 0 } as DOMRect,
        });
        fixture.detectChanges();
        await fixture.whenStable();
        return fixture.nativeElement as HTMLElement;
      }
      const tagOf = (el: HTMLElement) =>
        el.querySelector<HTMLElement>('[data-testid="section-nav-unclaimed"]');

      it('shows "Unclaimed" as static text after the name on an unclaimed listing', async () => {
        const el = await stuckWith('unclaimed');
        const tag = tagOf(el)!;
        expect(tag).not.toBeNull();
        expect(tag.textContent!.trim()).toBe('Unclaimed');
        // Inside the name element, after the name, outside the "On this page" landmark. The
        // name element carries the responsive hiding, so the tag can never show without it.
        const brand = el.querySelector('[data-testid="section-nav-brand"]')!;
        const nameEl = brand.querySelector<HTMLElement>('[data-testid="section-nav-name"]')!;
        expect(nameEl.contains(tag)).toBe(true);
        expect(nameEl.lastElementChild).toBe(tag);
        expect(nameEl.textContent).toContain('Bluebeam Revu');
        expect(nameEl.className).toContain('hidden');
        expect(nameEl.className).toContain('md:inline-flex');
        expect(tag.closest('nav')).toBeNull();
        // Information, not a control: no link, no button, no focus stop, no live region.
        expect(tag.querySelector('a, button, [tabindex]')).toBeNull();
        expect(tag.querySelector('[aria-live], [role="status"]')).toBeNull();
        expect(brand.closest('[aria-live]')).toBeNull();
        // The hero's status chip recipe, never shrunk (the name truncates first).
        expect(tag.querySelector('.aec-chip')!.getAttribute('data-tone')).toBe('quiet');
        expect(tag.className).toContain('shrink-0');
        // Not a claim sentence: the hero's full note is not repeated here.
        expect(brand.textContent).not.toContain('not affiliated');
      });

      // The owner, 2026-11: never "Unclaimed" without the product name beside it.
      it('never shows the tag when the bar has no name', async () => {
        const el = await stuckWith('unclaimed', null);
        expect(tagOf(el)).toBeNull();
        expect(el.querySelector('[data-testid="section-nav-brand"]')!.textContent).not.toContain(
          'Unclaimed',
        );
      });

      it('adds nothing for a claimed listing', async () => {
        const el = await stuckWith('claimed');
        expect(tagOf(el)).toBeNull();
        expect(el.querySelector('[data-testid="section-nav-brand"]')!.textContent).not.toContain(
          'Unclaimed',
        );
      });

      it('adds nothing when the caller passes no claim status', async () => {
        expect(tagOf(await stuckWith(null))).toBeNull();
      });

      it('never shows before the bar sticks', async () => {
        const el = (await setup({ claim: 'unclaimed' })).nativeElement as HTMLElement;
        expect(tagOf(el)).toBeNull();
      });
    });

    it('omits the name when the page gives none', async () => {
      const fixture = await setup({ name: null });
      stuckObserver().fire({ intersectionRatio: 0.5, boundingClientRect: { top: -10 } as DOMRect });
      fixture.detectChanges();
      const brand = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="section-nav-brand"]',
      )!;
      expect(brand.textContent!.trim()).toBe('');
    });

    it('unsticks when the bar is back at rest, and a bar cut by the viewport bottom is not stuck', async () => {
      const fixture = await setup();
      const el = fixture.nativeElement as HTMLElement;
      stuckObserver().fire({ intersectionRatio: 0.98, boundingClientRect: { top: 0 } as DOMRect });
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="section-nav-brand"]')).not.toBeNull();
      stuckObserver().fire({ intersectionRatio: 1, boundingClientRect: { top: 300 } as DOMRect });
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="section-nav-brand"]')).toBeNull();
      stuckObserver().fire({ intersectionRatio: 0.4, boundingClientRect: { top: 700 } as DOMRect });
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="section-nav-brand"]')).toBeNull();
    });

    // Every section follows the bar, so a bar back at rest means the reader is above them all.
    it('makes the first link current again when the bar returns to rest', async () => {
      const fixture = await setup();
      const el = fixture.nativeElement as HTMLElement;
      stuckObserver().fire({ intersectionRatio: 0.98, boundingClientRect: { top: 0 } as DOMRect });
      const spy = FakeObserver.instances.find((o) => !Array.isArray(o.options.threshold))!;
      const target = document.createElement('section');
      target.id = 'reviews';
      spy.fire({ isIntersecting: true, target });
      fixture.detectChanges();
      const current = () =>
        el.querySelector('a[aria-current="location"]')!.getAttribute('data-section-id');
      expect(current()).toBe('reviews');
      stuckObserver().fire({ intersectionRatio: 1, boundingClientRect: { top: 400 } as DOMRect });
      fixture.detectChanges();
      expect(current()).toBe('about');
    });

    it('disconnects its observers when destroyed', async () => {
      const fixture = await setup();
      const spy = vi.spyOn(stuckObserver(), 'disconnect');
      fixture.destroy();
      expect(spy).toHaveBeenCalled();
    });
  });
});
