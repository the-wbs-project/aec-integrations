/**
 * The mobile menu (AECI-1775, DESIGN.md §5 "The mobile menu", clash 30). It is
 * the header's navigation below `lg`: the host is `lg:hidden`, and at `lg` and
 * up the same destinations are the inline row and its Browse menu
 * (`browse-menu.ts`).
 *
 * The toggle sits at the end edge of the Forest header. Its name is "Menu" and
 * `aria-expanded` carries the state, so the name stays true while the glyph is
 * a close mark. It opens one white panel under the header strip: "All products"
 * and the key categories, four tap-to-expand sections (Categories, Phases,
 * Audiences, Trades), How we rank and For vendors, the footer line, then search
 * and the account block or Sign in. Every list comes from
 * `TaxonomyNavStore.browse`, the model the desktop Browse menu reads, so the two
 * menus share one ordering path (`browse-menu-model.ts`).
 *
 * **A dialog that holds its own toggle.** While open, the host is
 * `role="dialog"`, `aria-modal="true"` and named "Menu". The host holds both the
 * toggle and the panel, so the close control is inside the dialog: a screen
 * reader on a phone, with no Escape key, can always reach it. Everything else on
 * the page is made `inert` (the walk in `setInert`), so the page behind can be
 * neither focused nor read. Tab and Shift+Tab cycle inside the host. Escape
 * closes and returns focus to the toggle. So does a click on the page dimmer.
 * A route change closes it, and so does the viewport growing to `lg`, where the
 * host is hidden.
 *
 * **The page behind does not scroll.** `overflow: hidden` on the root element,
 * set on open and removed on close. Nothing moves the page, so its scroll
 * position is untouched and the router's scroll restoration never sees a
 * change (CLAUDE.md, "Router scroll restoration is already solved"). The panel
 * scrolls inside itself and does not chain to the page.
 *
 * **Why not `BrnPopover`.** The shipped menu was a Spartan popover in the CDK
 * overlay. Its dialog had no name (axe `aria-dialog-name`), its focus trap left
 * out the toggle, and its content was an `ng-template` that mounted on the first
 * click, so it had to be in the initial bundle to open at once. The inline panel
 * fixes all three.
 *
 * **The body is lazy and server-rendered.** `nav-menu-panel.ts` sits in
 * `@defer (on idle; hydrate on idle)`, as the Browse panel does. Its links are
 * plain `<a href>` with no listener. This component's host catches the click,
 * closes the menu and routes in the app, so a tap navigates before the body
 * hydrates, and if its chunk never loads. The account block is lazy too
 * (`nav-menu-account.ts`). It only exists in the browser after the session probe.
 *
 * **Cached HTML is visitor-neutral.** The server renders the closed menu: the
 * toggle, the hidden panel with its index links, search and the "Sign in" link.
 * `SessionStatus` swaps in the account block after hydration, and the role
 * probe that reveals the portal doors and the badge is `null` during SSR.
 *
 * The toggle keeps the operator-backlog badge. Below `lg` it is the only menu
 * control, and the Admin portal door lives inside it. Since AECI-922 the badge is
 * the sum of the three Operations queues, as on the console's own trigger.
 */
import { DOCUMENT } from '@angular/common';
import {
  afterNextRender,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  Injector,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NavigationSkipped, NavigationStart, Router, RouterLink } from '@angular/router';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { SessionStatus } from '../auth/session-status';
import { injectSignInQueryParams } from '../auth/sign-in-link';
import { isReplayedEvent } from '../core/event-replay';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';
import { SearchAutocomplete } from '../search/search-autocomplete';
import type { AutocompleteSuggestion } from '../search/autocomplete-mapping';
import { AecButton } from '../shared/button/button';
import { AecIcon } from '../shared/icon/icon';

import { NavMenuAccount } from './nav-menu-account';
import { NavMenuPanel } from './nav-menu-panel';
import { navigateToSearchQuery, navigateToSuggestion } from './search-submit';

/** The panel's id, the toggle's `aria-controls` target. One mobile menu per page. */
export const NAV_MENU_PANEL_ID = 'nav-menu-panel';

/** Tailwind's `lg`, where the inline row takes over and this host is hidden. */
const LG_QUERY = '(min-width: 64rem)';

/** What Tab can land on. Filtered to visible elements in `tabbables()`. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

@Component({
  selector: 'aec-nav-menu',
  // The handover is `lg` (AECI-544, re-measured by AECI-1774). From `lg` the
  // header shows the inline row and its own search. Below `lg` this menu carries
  // navigation and search. If the handover moves, this `lg:hidden` moves with
  // the inline row's `lg:flex` and the header search's `lg:` class in
  // `site-header.ts`, or a width band gets two searches or none.
  host: {
    class: 'lg:hidden',
    '[attr.role]': 'isOpen() ? "dialog" : null',
    '[attr.aria-modal]': 'isOpen() ? "true" : null',
    '[attr.aria-label]': 'isOpen() ? name : null',
    '(keydown.tab)': 'onTab($event)',
    '(keydown.shift.tab)': 'onTab($event)',
    '(document:keydown.escape)': 'onEscape($event)',
    // The panel's links are plain hrefs, so the eager host routes them.
    '(click)': 'onPanelClick($event)',
  },
  imports: [AecButton, AecIcon, RouterLink, SearchAutocomplete, NavMenuAccount, NavMenuPanel],
  template: `
    <button
      type="button"
      class="relative inline-flex h-11 w-11 cursor-pointer items-center justify-center rounded-control border aec-on-brand-edge bg-(--surface-on-brand-wash) text-(--text-on-brand) transition-colors hover:bg-(--surface-on-brand-wash-hover) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--focus-ring-on-brand)"
      [attr.aria-label]="name"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-controls]="panelId"
      [attr.aria-describedby]="showBadge() ? 'aec-nav-menu-pending' : null"
      data-nav-menu-toggle
      (click)="onToggle()"
    >
      <aec-icon [name]="isOpen() ? 'x' : 'menu'" decorative [size]="5" />
      <!-- Pending-review badge: parity with the desktop account trigger, so an
           admin sees there is work waiting without opening the menu (AECI-259). -->
      @if (showBadge()) {
        <span
          class="absolute -end-1 -top-1 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.625rem] font-bold leading-none text-(--surface-base) ring-2 ring-(--text-on-brand) bg-(--color-status-error)"
          aria-hidden="true"
          >{{ badgeText() }}</span
        >
        <span id="aec-nav-menu-pending" class="sr-only" i18n="@@admin.nav.pendingTotal"
          >{{ pending() }} items awaiting action</span
        >
      }
    </button>

    <!-- The panel's containing block is the header (relative in site-header.ts),
         so it spans the header under its bottom edge. Its height stops at the
         viewport: 64px header below md, 76px from md. -->
    <div
      [id]="panelId"
      [hidden]="!isOpen()"
      class="absolute inset-x-0 top-full z-10 max-h-[calc(100dvh-64px)] overflow-y-auto overscroll-contain rounded-b-card border-x border-b bg-(--surface-base) text-start text-(--text-primary) shadow-menu md:max-h-[calc(100dvh-76px)]"
    >
      <!-- The header's 32px gutter, so the menu lines up with the wordmark. Below
           320px (a phone at 200% zoom) it drops to 16px so nothing is cut off. -->
      <div class="mx-auto max-w-7xl px-4 pt-2 pb-6 min-[20rem]:px-8">
        <nav i18n-aria-label="@@app.nav.primary.aria" aria-label="Primary">
          @defer (on idle; hydrate on idle) {
            <aec-nav-menu-panel [menu]="menu()" />
          }
        </nav>

        <!-- Mounted only while open, so the server HTML keeps one search input
             (the header's) and a hidden combobox never hydrates. -->
        @if (isOpen()) {
          <aec-search-autocomplete
            class="mt-6 block"
            inputId="mobile-search"
            inputClass="w-full"
            (querySubmitted)="onSearchQuery($event)"
            (suggestionChosen)="onSuggestion($event)"
          />
        }

        <div class="mt-6">
          <!-- "Sign in" is the cache-safe server default. SessionStatus swaps in
               the account block after hydration (Phase 5 §4.4). -->
          @if (session.signedIn()) {
            @defer (on immediate) {
              <aec-nav-menu-account />
            }
          } @else {
            <a
              aecButton
              routerLink="/auth/login"
              [queryParams]="signInParams()"
              class="w-full"
              i18n="@@app.header.signIn"
            >
              Sign in
            </a>
          }
        </div>
      </div>
    </div>
  `,
})
export class NavMenu {
  private readonly taxonomy = inject(TaxonomyNavStore);
  protected readonly session = inject(SessionStatus);
  /** `?return=<this page>` so signing in lands back here, not on `/`. */
  protected readonly signInParams = injectSignInQueryParams();
  private readonly adminStatus = inject(AdminStatus);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly panelId = NAV_MENU_PANEL_ID;
  /** The toggle's name and the open dialog's name (mock-up 6, line 1196). */
  protected readonly name = $localize`:@@app.nav.menu.name:Menu`;
  protected readonly menu = this.taxonomy.browse;

  private readonly openSig = signal(false);
  protected readonly isOpen = this.openSig.asReadonly();
  /** Open state, for the header's page dimmer. */
  readonly expanded = this.isOpen;

  /** Live operator backlog: the same sum the console's Operations trigger shows. */
  protected readonly pending = computed(() => this.summaryStore.operationsTotal());
  /** The toggle badge shows only for an admin with something waiting. */
  protected readonly showBadge = computed(() => this.adminStatus.isAdmin() && this.pending() > 0);
  /** Capped so the badge cannot grow unbounded; the spoken description stays exact. */
  protected readonly badgeText = computed(() =>
    this.pending() > 9 ? '9+' : String(this.pending()),
  );

  /** Elements this menu made inert, so close undoes exactly those. */
  private inerted: HTMLElement[] = [];
  /** The root element's inline styles before the scroll lock, restored on close. */
  private lockedStyles: { overflow: string; scrollbarGutter: string } | null = null;

  constructor() {
    // A route change closes the menu: a link, a search, or the browser's back
    // button. NavigationSkipped covers a link to the page already showing.
    this.router.events.pipe(takeUntilDestroyed()).subscribe((event) => {
      if (event instanceof NavigationStart || event instanceof NavigationSkipped) {
        this.close(false);
      }
    });

    // At `lg` the host is hidden, so an open menu there would trap focus in an
    // invisible dialog and keep the page inert.
    afterNextRender(() => {
      const query = this.document.defaultView?.matchMedia?.(LG_QUERY);
      if (!query) return;
      const onChange = (event: MediaQueryListEvent) => {
        if (event.matches) this.close(false);
      };
      query.addEventListener('change', onChange);
      this.destroyRef.onDestroy(() => query.removeEventListener('change', onChange));
    });

    this.destroyRef.onDestroy(() => this.release());
  }

  /** Close from outside the host: the page dimmer. Focus returns to the toggle. */
  dismiss(): void {
    this.close(true);
  }

  protected onToggle(): void {
    this.adminStatus.ensureProbed();
    if (this.isOpen()) this.close(true);
    else this.open();
  }

  private open(): void {
    if (this.isOpen()) return;
    this.openSig.set(true);
    this.lockScroll();
    this.setInert();
    // Focus moves into the dialog once the render clears `[hidden]`. Zoneless
    // change detection runs on a macrotask, so focusing earlier would hit a
    // `display: none` panel. The first link is "All products".
    afterNextRender(
      () => {
        if (!this.isOpen()) return;
        this.panel()?.querySelector<HTMLElement>('a[href]')?.focus();
      },
      { injector: this.injector },
    );
  }

  private close(returnFocus: boolean): void {
    if (!this.isOpen()) return;
    this.openSig.set(false);
    this.release();
    if (returnFocus) this.toggleButton()?.focus();
  }

  /** Undo the scroll lock and the inert walk. */
  private release(): void {
    for (const element of this.inerted) element.inert = false;
    this.inerted = [];
    if (this.lockedStyles) {
      const root = this.document.documentElement;
      root.style.overflow = this.lockedStyles.overflow;
      root.style.scrollbarGutter = this.lockedStyles.scrollbarGutter;
      this.lockedStyles = null;
    }
  }

  /**
   * `overflow: hidden` on the root element stops the page scrolling without
   * moving it. Where the page shows a classic scrollbar, `scrollbar-gutter`
   * keeps its width, so the header does not shift sideways.
   */
  private lockScroll(): void {
    const root = this.document.documentElement;
    const view = this.document.defaultView;
    this.lockedStyles = {
      overflow: root.style.overflow,
      scrollbarGutter: root.style.scrollbarGutter,
    };
    if (view && view.innerWidth > root.clientWidth) root.style.scrollbarGutter = 'stable';
    root.style.overflow = 'hidden';
  }

  /**
   * Make the page behind inert: every sibling of the host and of each of its
   * ancestors up to `<body>`. The header's other parts, the skip link, `main`
   * and the footer all go. Left alone: the page dimmer (`data-nav-scrim`), which
   * closes the menu on a click, and the CDK overlay container, where a popup
   * opened from inside the menu would render. Elements already inert are not
   * touched, so close restores exactly what open changed.
   */
  private setInert(): void {
    let node: HTMLElement | null = this.host;
    while (node && node !== this.document.body) {
      const parent: HTMLElement | null = node.parentElement;
      if (!parent) break;
      for (const sibling of Array.from(parent.children) as HTMLElement[]) {
        if (sibling === node || sibling.inert) continue;
        if (sibling.hasAttribute('data-nav-scrim')) continue;
        if (sibling.classList.contains('cdk-overlay-container')) continue;
        sibling.inert = true;
        this.inerted.push(sibling);
      }
      node = parent;
    }
  }

  /**
   * The focus trap. Tab from the last control goes to the first, and Shift+Tab
   * from the first goes to the last. The rest of the page is inert, so this only
   * stops focus leaving for the browser's own controls.
   */
  protected onTab(event: Event): void {
    if (!this.isOpen() || isReplayedEvent(event)) return;
    const items = this.tabbables();
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = this.document.activeElement;
    const shift = (event as KeyboardEvent).shiftKey;
    if (shift && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!shift && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  /**
   * Escape closes the menu and returns focus to the toggle. It listens on the
   * document, so it works after a tap on plain panel text left focus on `<body>`.
   * An open search popup takes its own Escape first.
   */
  protected onEscape(event: Event): void {
    if (!this.isOpen()) return;
    const target = event.target as Element | null;
    if (
      target?.getAttribute?.('role') === 'combobox' &&
      target.getAttribute('aria-expanded') === 'true'
    ) {
      return;
    }
    this.close(true);
  }

  /**
   * A click on a panel destination closes the menu and routes in the app. It is a
   * host listener, so it is eager and it bubbles up from any panel link. The
   * links are plain hrefs (`nav-menu-panel.ts`), so this works whether or not the
   * lazy body has hydrated. A `RouterLink` (Sign in, the account block) handles
   * its own click and prevents the default first, so it is skipped here; the
   * route change closes the menu. A modified or non-primary click is left to the
   * browser. A replayed click already ran its native default, a full page load.
   */
  protected onPanelClick(event: MouseEvent): void {
    if (isReplayedEvent(event) || event.defaultPrevented) return;
    const link = (event.target as Element | null)?.closest?.(`#${this.panelId} a[href]`);
    const href = link?.getAttribute('href');
    // Only a same-origin path is routed in the app. A protocol-relative
    // `//host` href, a `target` or a `download` link stays the browser's.
    if (!href?.startsWith('/') || href.startsWith('//')) return;
    if (link?.hasAttribute('target') || link?.hasAttribute('download')) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    this.close(false);
    void this.router.navigateByUrl(href);
  }

  protected onSearchQuery(query: string): void {
    navigateToSearchQuery(this.router, query);
  }

  protected onSuggestion(suggestion: AutocompleteSuggestion): void {
    navigateToSuggestion(this.router, suggestion);
  }

  private panel(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>(`#${this.panelId}`);
  }

  private toggleButton(): HTMLElement | null {
    return this.host.querySelector<HTMLElement>('[data-nav-menu-toggle]');
  }

  /**
   * The toggle and every focusable control in the panel, in DOM order. A control
   * inside a `[hidden]` region (a collapsed section) is skipped. Those are the
   * only hidden controls in an open menu.
   */
  private tabbables(): HTMLElement[] {
    return Array.from(this.host.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (element) => element.tabIndex >= 0 && !element.closest('[hidden]'),
    );
  }
}
