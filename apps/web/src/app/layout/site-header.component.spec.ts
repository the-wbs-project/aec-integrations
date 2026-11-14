import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import {
  Component,
  PLATFORM_ID,
  provideZonelessChangeDetection,
  signal,
  type WritableSignal,
} from '@angular/core';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { beforeEach, describe, expect, it } from 'vitest';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
import { SessionStatus } from '../auth/session-status';

import { SiteHeader } from './site-header';

@Component({ template: '' })
class BlankPage {}

/**
 * The header's auth affordance (Phase 5 §4.4). `SessionStatus.signedIn()` is
 * the cache-neutral signal: `false` is the SSR/pre-hydration default (so the
 * cached HTML carries the neutral "Sign in" link for every visitor), and it
 * flips to `true` only after the browser-only probe. Here we stub the signal
 * directly and pin both rendered branches; the probe timing itself is covered
 * by `auth/session-status.component.spec.ts`.
 */
describe('SiteHeader auth affordance', () => {
  let signedIn: WritableSignal<boolean>;

  beforeEach(() => {
    signedIn = signal(false);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([{ path: '**', component: BlankPage }]),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        // `avatarUrl` / `fullName` feed the AECI-850 identity block inside the
        // menu; null on both is the magic-link shape, which is the default here.
        {
          provide: SessionStatus,
          useValue: {
            signedIn,
            email: signal<string | null>(null),
            avatarUrl: signal<string | null>(null),
            fullName: signal<string | null>(null),
          },
        },
        // The signed-in affordance is now `<aec-user-menu>`; stub its deps so the
        // header spec stays focused on which affordance renders (the menu's own
        // behaviour is covered by user-menu.component.spec.ts).
        {
          provide: AdminStatus,
          useValue: { isAdmin: signal(false), ensureProbed: () => Promise.resolve() },
        },
        { provide: AdminSummaryStore, useValue: { pendingReviews: signal<number | null>(null) } },
        { provide: AuthService, useValue: {} },
      ],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(SiteHeader);
    fixture.detectChanges();
    return fixture;
  }

  /** Sign in, then wait for the lazy account menu (`@defer (on immediate)`). */
  async function signIn(fixture: ReturnType<typeof render>) {
    signedIn.set(true);
    fixture.detectChanges();
    for (const block of await fixture.getDeferBlocks()) {
      await block.render(DeferBlockState.Complete);
    }
    fixture.detectChanges();
  }

  it('shows the neutral "Sign in" link and no account link when signed out', () => {
    const el = render().nativeElement as HTMLElement;
    const signIn = el.querySelector('a[href="/auth/login"]');
    expect(signIn?.textContent?.trim()).toBe('Sign in');
    expect(el.querySelector('a[href="/account"]')).toBeNull();
  });

  it('threads the current page into "Sign in" as ?return= so sign-in lands back here', async () => {
    const fixture = render();
    await TestBed.inject(Router).navigateByUrl('/products/procore?tab=reviews');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const signIn = el.querySelector<HTMLAnchorElement>('a[href^="/auth/login"]');
    expect(signIn?.getAttribute('href')).toBe(
      '/auth/login?return=%2Fproducts%2Fprocore%3Ftab%3Dreviews',
    );
  });

  it('renders "Sign in" with the path alone on the server, so cached HTML carries no query', async () => {
    // The edge key drops utm_* and the email send id `n`, so a rendered query
    // would bake one visitor's params into HTML served to everyone.
    TestBed.overrideProvider(PLATFORM_ID, { useValue: 'server' });
    const fixture = render();
    await TestBed.inject(Router).navigateByUrl('/products/procore?utm_source=email&n=abc#reviews');
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    const signIn = el.querySelector<HTMLAnchorElement>('a[href^="/auth/login"]');
    expect(signIn?.getAttribute('href')).toBe('/auth/login?return=%2Fproducts%2Fprocore');
  });

  it('swaps to the account menu (no "Sign in") once the probe reports a session', async () => {
    const fixture = render();
    await signIn(fixture);

    const el = fixture.nativeElement as HTMLElement;
    const menu = el.querySelector('aec-user-menu');
    expect(menu).not.toBeNull();
    // The icon-only trigger must carry an accessible name.
    const trigger = menu?.querySelector('button');
    expect(trigger?.getAttribute('aria-label')).toBe('Account menu');
    expect(trigger?.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector('a[href="/auth/login"]')).toBeNull();
  });

  /**
   * The row is width-budgeted (DESIGN.md §Navigation): Browse, How we rank and For
   * vendors (clash 26, AECI-1774). Pin the item set, its order and its targets so a
   * new top-level entry cannot slip in without the re-measure that rule requires.
   */
  it('renders exactly the three primary destinations and nothing else', () => {
    const el = render().nativeElement as HTMLElement;
    const nav = el.querySelector('nav[aria-label="Primary"]')!;

    const topLevel = Array.from(nav.children).map((child) => {
      const link = child.tagName === 'A' ? child : child.querySelector('a');
      return [link?.textContent?.trim(), link?.getAttribute('href')];
    });
    expect(topLevel).toEqual([
      ['Browse', '/products'],
      ['How we rank', '/docs/trust/how-ranking-works'],
      ['For vendors', '/vendor-program'],
    ]);
    // Home and the four facet flyouts left the row. The wordmark goes home.
    expect(nav.querySelector('a[href="/"]')).toBeNull();
    expect(el.querySelector('aec-nav-flyout-trigger')).toBeNull();
  });

  /**
   * No JavaScript-only dead end: the panel body carries "All products" and the
   * four "See all" links even with no terms. The server-rendered HTML itself is
   * pinned in `e2e/nav-menu.spec.ts` with JavaScript off, because the panel body
   * is an incrementally hydrated `@defer` block that TestBed does not server-render.
   */
  it('renders the Browse panel with every index link before any terms arrive', async () => {
    TestBed.configureTestingModule({ deferBlockBehavior: DeferBlockBehavior.Manual });
    TestBed.overrideProvider(PLATFORM_ID, { useValue: 'server' });
    const fixture = render();
    for (const block of await fixture.getDeferBlocks()) {
      await block.render(DeferBlockState.Complete);
    }
    const el = fixture.nativeElement as HTMLElement;
    const panel = el.querySelector('#browse-menu-panel')!;
    expect(panel.hasAttribute('hidden')).toBe(true);
    const hrefs = Array.from(panel.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/products', '/categories', '/phases', '/audiences', '/trades']);
    expect(panel.textContent).toContain('Key categories are chosen by AEC Integrations.');
  });

  /**
   * The row is public-only: secondary destinations live in the footer and the
   * portal doors live in the account menu. Nothing role-gated may render here,
   * because the header is server-rendered into URL-keyed cached HTML — an
   * `/admin` href in the row would leak to the next visitor of that URL.
   */
  it('keeps secondary and role-gated destinations out of the row', () => {
    const el = render().nativeElement as HTMLElement;
    const nav = el.querySelector('nav[aria-label="Primary"]')!;

    for (const href of ['/updates', '/roadmap', '/about', '/contact']) {
      expect(nav.querySelector(`a[href="${href}"]`), href).toBeNull();
    }
    expect(el.querySelectorAll('a[href^="/admin"]').length).toBe(0);
    // `/vendor-program` (For vendors) is public. The portal door is `/vendor`.
    expect(el.querySelectorAll('a[href="/vendor"], a[href^="/vendor/"]').length).toBe(0);
  });

  /**
   * AECI-1771: the bar is Forest with Bone ink, the wordmark is the reversed
   * file, and the shipped 4px warm rule under the bar is gone. Tokens only.
   */
  it('sits on Forest with the reversed wordmark and no rule under the bar', () => {
    const el = render().nativeElement as HTMLElement;
    const header = el.querySelector('header')!;
    expect(header.className).toContain('bg-(--accent-primary)');
    expect(header.className).toContain('text-(--text-on-brand)');
    expect(el.querySelector('img')?.getAttribute('src')).toBe('/branding/wordmark-on-dark.svg');
    expect(header.querySelector('.bg-\\(--accent-warm\\)[aria-hidden="true"]')).toBeNull();
  });

  /** Sign in is the solid Bone main button: Forest text, 44px, Bone hover fill and ring. */
  it('renders Sign in as the Bone main button on Forest', () => {
    const el = render().nativeElement as HTMLElement;
    const classes = el.querySelector('a[href^="/auth/login"]')!.className;
    expect(classes).toContain('bg-(--accent-warm)');
    expect(classes).toContain('text-(--accent-primary)');
    expect(classes).toContain('min-h-11');
    expect(classes).toContain('hover:bg-(--surface-on-brand-hover)');
    expect(classes).toContain('focus-visible:outline-(--focus-ring-on-brand)');
  });

  it('gives the signed-in account trigger a Bone edge, wash and ring on Forest', async () => {
    const fixture = render();
    await signIn(fixture);
    const trigger = (fixture.nativeElement as HTMLElement).querySelector('aec-user-menu button')!;
    expect(trigger.classList).toContain('aec-on-brand-edge');
    expect(trigger.className).toContain('bg-(--surface-on-brand-wash)');
    expect(trigger.className).toContain('text-(--text-on-brand)');
    expect(trigger.className).toContain('h-11');
    expect(trigger.className).toContain('focus-visible:outline-(--focus-ring-on-brand)');
    expect(trigger.getAttribute('aria-label')).toBe('Account menu');
  });

  /**
   * The active route is `aria-current`, `page` on an exact match and `true` for
   * a section, plus weight 600. Never colour alone. The Clay bar is the
   * panel-open cue, not the active route.
   */
  async function currentOn(url: string) {
    const fixture = render();
    await TestBed.inject(Router).navigateByUrl(url);
    fixture.detectChanges();
    const nav = (fixture.nativeElement as HTMLElement).querySelector('nav[aria-label="Primary"]')!;
    return Array.from(nav.querySelectorAll('[aria-current]'));
  }

  it('marks nothing current on the home route', async () => {
    expect(await currentOn('/')).toEqual([]);
  });

  for (const url of [
    '/products',
    '/products/procore',
    '/categories',
    '/categories/bim',
    '/audiences/owners',
    '/trades',
    '/phases/design',
  ]) {
    it(`marks Browse aria-current="true" as a section on ${url}, at weight 600`, async () => {
      const current = await currentOn(url);
      expect(current.map((a) => a.textContent?.trim())).toEqual(['Browse']);
      expect(current[0].getAttribute('aria-current')).toBe('true');
      expect(current[0].classList).toContain('font-semibold');
    });
  }

  it('marks How we rank and For vendors aria-current="page" on their own routes', async () => {
    let current = await currentOn('/docs/trust/how-ranking-works');
    expect(current.map((a) => [a.textContent?.trim(), a.getAttribute('aria-current')])).toEqual([
      ['How we rank', 'page'],
    ]);
    current = await currentOn('/vendor-program');
    expect(current.map((a) => [a.textContent?.trim(), a.getAttribute('aria-current')])).toEqual([
      ['For vendors', 'page'],
    ]);
  });

  it('does not light Browse on a page outside the directory', async () => {
    expect(await currentOn('/productsfoo')).toEqual([]);
    expect(await currentOn('/vendors/autodesk')).toEqual([]);
  });

  /**
   * The pill is the header's one inline search. It is hidden below `lg` (the
   * mobile menu carries search there) and flexible from `lg`, so no width band
   * is bare and none holds two inputs. The old icon trigger is gone.
   */
  it('mounts one search pill from lg, with no icon trigger beside it', () => {
    const el = render().nativeElement as HTMLElement;
    expect(el.querySelector('aec-search-trigger')).toBeNull();

    const pill = el.querySelector('aec-search-autocomplete')!;
    const classes = pill.className.split(/\s+/);
    expect(classes).toContain('hidden');
    expect(classes).toContain('lg:block');
    expect(classes).toContain('flex-1');
    expect(classes).toContain('max-w-[460px]');
    expect(classes).not.toContain('xl:block');
  });

  it('styles the pill on Forest: full radius, strong edge, wash fill, ink and one ring set', () => {
    const el = render().nativeElement as HTMLElement;
    const input = el.querySelector<HTMLInputElement>('#header-search')!;
    const classes = input.className.split(/\s+/);
    expect(classes).toContain('rounded-pill');
    expect(classes).toContain('aec-on-brand-edge');
    expect(classes).toContain('h-11');
    expect(classes).toContain('bg-(--surface-on-brand-wash)');
    expect(classes).toContain('aec-on-brand-placeholder');
    expect(classes).toContain('focus-visible:outline-3');
    expect(classes).toContain('focus-visible:outline-(--focus-ring-on-brand)');
    // One ring set: the default Forest ring is not also on the field.
    expect(input.className).not.toContain('outline-(--accent-primary)');
    expect(input.placeholder).toBe('Search directory');
    expect(input.getAttribute('aria-keyshortcuts')).toBe('Control+/ Meta+/');
    const cap = el.querySelector('kbd')!;
    expect(cap.getAttribute('aria-hidden')).toBe('true');
    expect(cap.textContent?.trim()).toBe('Ctrl /');
  });

  describe('the Ctrl+/ shortcut', () => {
    function press(init: KeyboardEventInit, target: EventTarget = document.body) {
      const event = new KeyboardEvent('keydown', {
        key: '/',
        code: 'Slash',
        bubbles: true,
        cancelable: true,
        ...init,
      });
      target.dispatchEvent(event);
      return event;
    }

    /** jsdom has no layout, so the pill reports no boxes. Pretend it is laid out. */
    function renderLaidOut() {
      const fixture = render();
      const input = fixture.nativeElement.querySelector('#header-search') as HTMLInputElement;
      input.getClientRects = () => [{}] as unknown as DOMRectList;
      return { fixture, input };
    }

    it('focuses the search from the page body and consumes the key', () => {
      const { input } = renderLaidOut();
      const event = press({ ctrlKey: true });
      expect(document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(true);
    });

    it('works with Cmd as well as Ctrl', () => {
      const { input } = renderLaidOut();
      press({ metaKey: true });
      expect(document.activeElement).toBe(input);
    });

    it('ignores a bare "/" (a character key shortcut, WCAG 2.1.4)', () => {
      const { input } = renderLaidOut();
      const event = press({});
      expect(document.activeElement).not.toBe(input);
      expect(event.defaultPrevented).toBe(false);
    });

    it('ignores Alt, Ctrl+Alt and Ctrl+Meta', () => {
      const { input } = renderLaidOut();
      for (const init of [
        { altKey: true },
        { ctrlKey: true, altKey: true },
        { ctrlKey: true, metaKey: true },
      ]) {
        press(init);
        expect(document.activeElement).not.toBe(input);
      }
    });

    it('does nothing while the reader types in another field', () => {
      const { input } = renderLaidOut();
      for (const tag of ['input', 'textarea', 'select']) {
        const field = document.createElement(tag);
        document.body.appendChild(field);
        field.focus();
        const event = press({ ctrlKey: true }, field);
        expect(document.activeElement, tag).toBe(field);
        expect(document.activeElement).not.toBe(input);
        expect(event.defaultPrevented, tag).toBe(false);
        field.remove();
      }
      const editable = document.createElement('div');
      editable.setAttribute('contenteditable', 'true');
      document.body.appendChild(editable);
      press({ ctrlKey: true }, editable);
      expect(document.activeElement).not.toBe(input);
      editable.remove();
    });

    it('does nothing while a dialog is open', () => {
      const { input } = renderLaidOut();
      const dialog = document.createElement('div');
      dialog.setAttribute('role', 'dialog');
      document.body.appendChild(dialog);
      const event = press({ ctrlKey: true });
      expect(document.activeElement).not.toBe(input);
      expect(event.defaultPrevented).toBe(false);
      dialog.remove();
    });

    it('does not hijack the key inside the search field itself', () => {
      const { input } = renderLaidOut();
      input.focus();
      const event = press({ ctrlKey: true }, input);
      expect(document.activeElement).toBe(input);
      expect(event.defaultPrevented).toBe(false);
    });

    it('does nothing when the pill is not laid out (below lg)', () => {
      const fixture = render();
      const input = fixture.nativeElement.querySelector('#header-search') as HTMLInputElement;
      const event = press({ ctrlKey: true });
      expect(document.activeElement).not.toBe(input);
      expect(event.defaultPrevented).toBe(false);
    });
  });

  /**
   * The `<label for>` in each `aec-search-autocomplete` is only correct while the
   * ids are unique. The pill is the header's own; `mobile-search` lives in the
   * hamburger's overlay, unmounted until opened, so the only id in the SSR'd
   * header must be this one.
   */
  it('renders exactly one search input server-side, with the inline id', () => {
    const el = render().nativeElement as HTMLElement;
    const inputs = Array.from(el.querySelectorAll('input[type="search"]'));
    expect(inputs.map((i) => i.id)).toEqual(['header-search']);
  });
});
