import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  Injector,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';

import { isReplayedEvent } from '../core/event-replay';
import { TaxonomyNavStore } from '../core/taxonomy/taxonomy-nav.store';

import { HEADER_LINK, HEADER_LINK_ACTIVE } from './header-link-classes';
import { NavDisclosure } from './nav-disclosure';
import { BrowsePanel } from './browse-panel';

/** The panel's id, the trigger's `aria-controls` target. One Browse menu per page. */
export const BROWSE_PANEL_ID = 'browse-menu-panel';

/** The first path segments that make "Browse" the current section (DESIGN.md §5). */
const BROWSE_SECTIONS = new Set(['products', 'categories', 'audiences', 'trades', 'phases']);

/** True when `url` is inside the Browse section: the indexes and their detail pages. */
export function isBrowseSection(url: string): boolean {
  const path = url.split(/[?#]/, 1)[0] ?? '';
  return BROWSE_SECTIONS.has(path.split('/')[1] ?? '');
}

/**
 * The Browse menu (AECI-1774, DESIGN.md §5 "The Browse menu", PLAN.md §4.8).
 *
 * "Browse" is a real link to `/products`. It also discloses one white panel with
 * five columns: Explore ("All products" and the key categories), then Categories,
 * Phases, Audiences and Trades, each ending in a "See all" link to its index.
 *
 * The pattern is disclosure navigation, not an ARIA menu. The trigger carries
 * `aria-expanded` and `aria-controls`, and no `aria-haspopup`, which would announce
 * a menu that is not there. The panel is `[hidden]` while closed, so its links are
 * never silently tabbable. Built on `NavDisclosure`: hover opens after 70ms, the
 * pointer leaving closes after a 260ms grace (WCAG 1.4.13 "hoverable"), Escape
 * closes and returns focus to "Browse", focus leaving closes, and the Safari press
 * guard keeps a click inside the panel from closing it before it lands. The down
 * arrow opens it and moves focus to "All products". Escape also closes a
 * hover-opened panel while focus is elsewhere on the page.
 *
 * Positioning: the host is static, so the panel's containing block is the
 * header (`relative` in `site-header.ts`) and the panel spans the full header
 * width under its bottom edge. The panel is a DOM descendant of the host, so the
 * pointer crossing into it never counts as leaving. The dimmer is NOT in the host
 * (hovering it must count as leaving): `site-header.ts` renders it from
 * `expanded()` and closes the menu through `dismiss()`.
 *
 * Cached HTML: the server renders "All products", every column label and every
 * "See all" link, and no terms or counts. `TaxonomyNavStore` is idle on the
 * server and fetches `/api/taxonomy` once in the browser, so every visitor gets
 * the same HTML. If that fetch fails, the panel keeps exactly what the server
 * rendered.
 */
@Component({
  selector: 'aec-browse-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, BrowsePanel],
  host: {
    class: 'inline-flex items-center',
    '(document:keydown.escape)': 'onDocumentEscape($event)',
  },
  template: `
    <a
      routerLink="/products"
      [class]="sectionActive() ? activeTriggerClass : triggerClass"
      [class.bg-(--surface-on-brand-wash)]="isOpen()"
      [attr.aria-current]="sectionActive() ? 'true' : null"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-controls]="panelId"
      [attr.data-label]="label"
      (click)="close()"
      (keydown.arrowdown)="onArrowDown($event)"
      >{{ label
      }}<span
        aria-hidden="true"
        data-browse-cue
        class="pointer-events-none absolute inset-x-3.5 -bottom-4 h-[3px] rounded-t-[3px] bg-(--accent-secondary) transition-transform duration-slow ease-standard"
        [class.scale-x-0]="!isOpen()"
      ></span
    ></a>

    <div
      [id]="panelId"
      [hidden]="!isOpen()"
      class="absolute inset-x-0 top-full z-10 rounded-b-card border-x border-b bg-(--surface-base) text-start text-(--text-primary) shadow-menu"
    >
      <!--
        The body is lazy (AECI-1774: the initial bundle had under 2 kB of
        headroom). Incremental hydration renders it on the server in full, so the
        cached HTML keeps every index link, and the browser hydrates it the first
        time the panel opens. A browser-only render loads it when idle.
      -->
      @defer (on idle; hydrate when isOpen()) {
        <aec-browse-panel [menu]="menu()" (navigate)="close()" />
      }
    </div>
  `,
})
export class BrowseMenu extends NavDisclosure {
  /** Hover intent and close grace (mock-up 6, `src/catmenu.js` lines 15 and 19). */
  protected override readonly openDelayMs = 70;
  protected override readonly closeGraceMs = 260;

  private readonly taxonomy = inject(TaxonomyNavStore);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly panelId = BROWSE_PANEL_ID;
  protected readonly label = $localize`:@@app.nav.browse:Browse`;
  protected readonly triggerClass = `relative ${HEADER_LINK}`;
  protected readonly activeTriggerClass = `${this.triggerClass} ${HEADER_LINK_ACTIVE}`;
  protected readonly menu = this.taxonomy.browse;

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  /** "Browse" is the current section on the indexes and their detail pages. */
  protected readonly sectionActive = computed(() => isBrowseSection(this.url()));

  /** Open state, for the header's dimmer. */
  readonly expanded = computed(() => this.isOpen());

  /** Close from outside the host: the dimmer click. */
  dismiss(): void {
    this.close();
  }

  /**
   * The down arrow opens the panel and moves focus to "All products". The focus
   * waits for the render that clears `[hidden]`: zoneless change detection runs
   * on a macrotask, so focusing earlier would hit a `display: none` panel.
   */
  protected onArrowDown(event: Event): void {
    if (isReplayedEvent(event)) return; // the native default already ran
    event.preventDefault();
    this.open();
    afterNextRender(
      () => {
        const panel = this.host.nativeElement.querySelector<HTMLElement>(`#${this.panelId}`);
        panel?.querySelector<HTMLAnchorElement>('a')?.focus();
      },
      { injector: this.injector },
    );
  }

  /**
   * Escape anywhere closes a hover-opened panel (WCAG 1.4.13 "dismissible"). An
   * Escape inside the host is the base's: it closes and returns focus to "Browse".
   */
  protected onDocumentEscape(event: Event): void {
    if (!this.isOpen()) return;
    if (this.host.nativeElement.contains(event.target as Node | null)) return;
    this.close();
  }
}
