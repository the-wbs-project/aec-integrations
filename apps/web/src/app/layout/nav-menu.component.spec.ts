import { provideHttpClient, withXhr } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { Component, signal, type WritableSignal } from '@angular/core';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { TaxonomyTermWithCount } from '@aeci/shared';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
import { SessionStatus } from '../auth/session-status';
import type { BrowseMenuModel } from '../core/taxonomy/browse-menu-model';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { VendorStatus } from '../vendor/vendor-status';

import { NAV_MENU_PANEL_ID, NavMenu } from './nav-menu';

function term(slug: string, name: string, count: number, order = 0): TaxonomyTermWithCount {
  return { id: slug, slug, name, description: null, display_order: order, product_count: count };
}

/** The model as `buildBrowseMenu` hands it over: already ordered and capped. */
const MENU: BrowseMenuModel = {
  totalProducts: 486,
  keyCategories: [term('ai', 'AI', 69), term('project-management', 'Project management', 1)],
  categories: [term('field', 'Field management', 54), term('scheduling', 'Scheduling', 20)],
  phases: [term('design', 'Design', 40, 1), term('closeout', 'Closeout', 0, 5)],
  audiences: [term('owners', 'Owners', 30)],
  trades: [term('hvac', 'HVAC', 12)],
};

@Component({ template: '' })
class BlankPage {}

/** The header context the menu lives in: a sibling page and a sibling footer. */
@Component({
  imports: [NavMenu],
  template: `
    <header class="relative">
      <a id="wordmark" href="/">Home</a>
      <aec-nav-menu />
    </header>
    <main id="page"><button type="button" id="outside">Outside</button></main>
  `,
})
class Host {}

describe('NavMenu (the mobile menu)', () => {
  let signedIn: WritableSignal<boolean>;
  let root: HTMLElement;

  beforeEach(() => {
    TestBed.resetTestingModule();
    signedIn = signal(false);
    TestBed.configureTestingModule({
      // The body and the account block are `@defer` blocks. Render them on demand.
      deferBlockBehavior: DeferBlockBehavior.Manual,
      providers: [
        provideRouter([{ path: '**', component: BlankPage }]),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        { provide: TaxonomyNavStore, useValue: { browse: signal(MENU) } },
        {
          provide: SessionStatus,
          useValue: {
            signedIn,
            email: signal<string | null>('pat@example.com'),
            avatarUrl: signal<string | null>(null),
            fullName: signal<string | null>(null),
          },
        },
        {
          provide: AdminStatus,
          useValue: { isAdmin: signal(false), ensureProbed: () => Promise.resolve() },
        },
        { provide: VendorStatus, useValue: { isVendor: signal(false) } },
        { provide: AdminSummaryStore, useValue: { operationsTotal: signal(0) } },
        { provide: AuthService, useValue: {} },
      ],
    });
  });

  afterEach(() => {
    root?.remove();
    document.documentElement.style.overflow = '';
  });

  async function render() {
    const fixture = TestBed.createComponent(Host);
    fixture.autoDetectChanges();
    root = fixture.nativeElement as HTMLElement;
    document.body.appendChild(root);
    for (const block of await fixture.getDeferBlocks())
      await block.render(DeferBlockState.Complete);
    // The terms wait for the first browser render (`NavMenuPanel.ready`).
    await fixture.whenStable();
    const settle = async () => {
      fixture.detectChanges();
      await fixture.whenStable();
    };
    await settle();
    const host = root.querySelector<HTMLElement>('aec-nav-menu')!;
    return {
      fixture,
      host,
      settle,
      toggle: host.querySelector<HTMLButtonElement>('[data-nav-menu-toggle]')!,
      panel: () => host.querySelector<HTMLElement>(`#${NAV_MENU_PANEL_ID}`)!,
      text: (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    };
  }

  async function open() {
    const view = await render();
    view.toggle.click();
    await view.settle();
    return view;
  }

  function key(target: Element, name: string, shiftKey = false) {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true }),
    );
  }

  it('is hidden at lg and up through its host class', async () => {
    const { host } = await render();
    expect(host.classList).toContain('lg:hidden');
  });

  it('has a toggle named "Menu" that controls a closed panel', async () => {
    const { host, toggle, panel } = await render();
    expect(toggle.getAttribute('type')).toBe('button');
    expect(toggle.getAttribute('aria-label')).toBe('Menu');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(NAV_MENU_PANEL_ID);
    expect(toggle.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(panel().hidden).toBe(true);
    // Closed, the host is not a dialog.
    expect(host.getAttribute('role')).toBeNull();
  });

  it('opens as a named modal dialog that holds its toggle, and moves focus to "All products"', async () => {
    const { host, toggle, panel, text } = await open();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    // The name stays "Menu" while open; aria-expanded carries the state.
    expect(toggle.getAttribute('aria-label')).toBe('Menu');
    expect(panel().hidden).toBe(false);
    expect(host.getAttribute('role')).toBe('dialog');
    expect(host.getAttribute('aria-modal')).toBe('true');
    expect(host.getAttribute('aria-label')).toBe('Menu');
    expect(host.contains(toggle)).toBe(true);
    expect(text(document.activeElement!)).toBe('All products 486 products');
  });

  it('makes the page behind inert and stops it scrolling, and undoes both on Escape', async () => {
    const { toggle, settle } = await open();
    const wordmark = root.querySelector<HTMLElement>('#wordmark')!;
    const page = root.querySelector<HTMLElement>('#page')!;
    expect(wordmark.inert).toBe(true);
    expect(page.inert).toBe(true);
    expect(document.documentElement.style.overflow).toBe('hidden');

    key(document.activeElement!, 'Escape');
    await settle();

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    expect(wordmark.inert).toBe(false);
    expect(page.inert).toBe(false);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('makes an element added while open inert too, and releases it on close', async () => {
    const { settle } = await open();
    const toast = document.createElement('div');
    document.body.appendChild(toast);
    const banner = document.createElement('section');
    root.appendChild(banner);
    const scrim = document.createElement('div');
    scrim.setAttribute('data-nav-scrim', '');
    root.appendChild(scrim);
    // MutationObserver callbacks run as microtasks.
    await Promise.resolve();
    expect(toast.inert).toBe(true);
    expect(banner.inert).toBe(true);
    // The dimmer takes the click that closes the menu, so it stays live.
    expect(scrim.inert).toBeFalsy();

    key(document.activeElement!, 'Escape');
    await settle();
    expect(toast.inert).toBe(false);
    expect(banner.inert).toBe(false);

    // Closed, nothing watches: a new element stays live.
    const late = document.createElement('div');
    document.body.appendChild(late);
    await Promise.resolve();
    expect(late.inert).toBeFalsy();
    toast.remove();
    late.remove();
  });

  it('traps focus: Tab from the last control wraps to the toggle, Shift+Tab from the toggle to the last', async () => {
    const { host, toggle } = await open();
    const focusable = Array.from(
      host.querySelectorAll<HTMLElement>('a[href], button, input'),
    ).filter((el) => !el.closest('[hidden]'));
    const last = focusable[focusable.length - 1]!;
    expect(last.textContent?.trim()).toBe('Sign in');

    last.focus();
    key(last, 'Tab');
    expect(document.activeElement).toBe(toggle);

    key(toggle, 'Tab', true);
    expect(document.activeElement).toBe(last);
  });

  it('a second press on the toggle closes it', async () => {
    const { toggle, panel, settle } = await open();
    toggle.click();
    await settle();
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(toggle);
  });

  it('shows the Browse model in its order, with counts, then How we rank, For vendors and the footer line', async () => {
    const { panel, text } = await open();
    const nav = panel().querySelector('nav[aria-label="Primary"]')!;
    const rows = Array.from(nav.querySelectorAll(':scope aec-nav-menu-panel > ul > li')).map((li) =>
      text(li.querySelector('a, button')!),
    );
    expect(rows).toEqual([
      'All products 486 products',
      'Categories',
      'Phases',
      'Audiences',
      'Trades',
      'How we rank',
      'For vendors',
    ]);
    const keys = Array.from(nav.querySelectorAll('ul[aria-labelledby="nav-menu-key"] a')).map(text);
    expect(keys).toEqual(['AI 69 products', 'Project management 1 product']);
    expect(text(nav)).toContain(
      'Key categories are chosen by AEC Integrations. Other lists show most products first. Phases in project order.',
    );
  });

  it('each section expands with aria-expanded and shows its terms, counts and "See all"', async () => {
    const { panel, settle, text } = await open();
    const button = panel().querySelector<HTMLButtonElement>('#nav-menu-btn-phase')!;
    const region = panel().querySelector<HTMLElement>('#nav-menu-sec-phase')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.getAttribute('aria-controls')).toBe('nav-menu-sec-phase');
    expect(region.hidden).toBe(true);

    button.click();
    await settle();

    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(region.hidden).toBe(false);
    // Phases keep the model's project order, and a phase at 0 still shows.
    expect(Array.from(region.querySelectorAll(':scope > ul a')).map(text)).toEqual([
      'Design 40 products',
      'Closeout 0 products',
    ]);
    const seeAll = region.querySelector<HTMLAnchorElement>('a[href="/phases"]')!;
    expect(text(seeAll)).toBe('See all phases');
    // The chevron turns, on a wrapper: aec-icon's host is display: contents.
    const chevron = button.querySelector<HTMLElement>('[data-chevron]')!;
    expect(chevron.tagName).toBe('SPAN');
    expect(chevron.classList).toContain('rotate-180');
  });

  it('a click on a panel link closes the menu and routes in the app', async () => {
    const { panel, toggle, settle } = await open();
    const router = TestBed.inject(Router);
    const link = panel().querySelector<HTMLAnchorElement>('a[href="/vendor-program"]')!;
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    await settle();
    expect(click.defaultPrevented).toBe(true);
    expect(router.url).toBe('/vendor-program');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector<HTMLElement>('#page')!.inert).toBe(false);
  });

  it('any route change closes it', async () => {
    const { toggle, settle } = await open();
    await TestBed.inject(Router).navigateByUrl('/search?q=revit');
    await settle();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('a click on the page dimmer path (dismiss) closes it and returns focus to the toggle', async () => {
    const { fixture, toggle, settle } = await open();
    const menu = fixture.debugElement.query((el) => el.name === 'aec-nav-menu')
      .componentInstance as NavMenu;
    expect(menu.expanded()).toBe(true);
    menu.dismiss();
    await settle();
    expect(menu.expanded()).toBe(false);
    expect(document.activeElement).toBe(toggle);
  });

  it('signed out, Sign in is the primary button at full width', async () => {
    const { panel } = await open();
    const signIn = panel().querySelector<HTMLAnchorElement>('a[href^="/auth/login"]')!;
    expect(signIn.getAttribute('data-variant')).toBe('primary');
    expect(signIn.classList).toContain('w-full');
    expect(panel().querySelector('a[href="/account"]')).toBeNull();
  });

  it('signed in, the account block replaces Sign in, with Account as the secondary button', async () => {
    const view = await render();
    signedIn.set(true);
    await view.settle();
    for (const block of await view.fixture.getDeferBlocks()) {
      await block.render(DeferBlockState.Complete);
    }
    await view.settle();
    const account = view.panel().querySelector<HTMLAnchorElement>('a[href="/account"]')!;
    expect(account.getAttribute('data-variant')).toBe('secondary');
    expect(account.classList).toContain('w-full');
    expect(account.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.panel().querySelector('a[href^="/auth/login"]')).toBeNull();
    expect(view.text(view.panel())).toContain('Sign out');
  });
});
