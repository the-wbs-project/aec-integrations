/**
 * The help-center shell (`/docs` layout route, AECI-1259;
 * `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §3). The home, the section indexes and the
 * articles render in its `<router-outlet>`, between the site header and footer.
 *
 * Anchor site: **Devin (DeepWiki)**, Mobbin screen c3936cdb. Its shape is an
 * app shell: a full-height left sidebar on a grey surface holding the page tree,
 * a slim top bar over the content with a slash breadcrumb and "Last updated",
 * and a quiet article column. AECi keeps its own type, tokens and Forest links
 * (`DESIGN.md` "Product docs").
 *
 * **The sidebar** shows one of two trees, picked from the URL alone
 * (AECI-1265). On the help center it lists "Help center", then every help
 * section in manifest order, each with its pages indented under a guide line.
 * On a vendor guide page it lists a "Back to the help center" link, then the
 * vendor guide and its pages, and the `nav` is named "Vendor guide". A
 * single-page section is one item. A section whose landing is a `home` page
 * links to that page and lists its other pages under it. `routerLinkActive`
 * marks the current page with `aria-current="page"`, exact match only, so a
 * section's own item is current on its landing and nowhere else. From `lg` it
 * is a sticky column with its own scroll. The site header is not sticky, so the
 * column pins at the viewport top and is one viewport tall.
 *
 * **Below `lg`** the sidebar is a panel, collapsed by default, under the top
 * bar. The menu button toggles it, Escape closes it, and any navigation closes
 * it. The DOM order is top bar, panel, page at every width, so the SSR HTML is
 * the same for every visitor and the closed panel is `display: none` until a
 * click. From `lg`, grid placement moves the panel into the left column.
 *
 * **The top bar** is derived from the URL alone (the `AdminBreadcrumb`
 * pattern): ancestors as links, the current section or home as text with
 * `aria-current="page"`. On an article the trail stops at the section, as
 * DeepWiki's does, and the right side shows the page's pre-formatted
 * "Last updated" line.
 *
 * Static, SSR-safe and edge-cached with its children: every value here comes
 * from the bundled manifest and the URL, never from the visitor. Light only.
 */
import { Component, ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map } from 'rxjs';

import { DOCS_SECTIONS, type DocsGuide, type DocsPage, type DocsSection } from './docs-content';

export interface Crumb {
  readonly label: string;
  /** Set on an ancestor. The current page has none. */
  readonly path?: string;
}

/** What the shell knows about the current URL. */
export interface DocsLocation {
  readonly crumbs: readonly Crumb[];
  readonly page?: DocsPage;
  /** Which sidebar tree the URL belongs to. */
  readonly guide: DocsGuide;
}

/** One sidebar section: where its item links, and the pages listed under it. */
export interface TreeSection {
  readonly section: DocsSection;
  /** The pages under the item. A `home` page is the item itself, so it is left out. */
  readonly children: readonly DocsPage[];
}

/** Sidebar link: muted text, a grey pill when current. */
const TREE_LINK =
  'block rounded-md px-3 py-1.5 text-sm leading-snug text-(--text-secondary) transition-colors ' +
  'hover:text-(--text-primary) focus-visible:outline-2 focus-visible:-outline-offset-2 ' +
  'focus-visible:outline-(--accent-primary) aria-[current=page]:bg-(--surface-sunken) ' +
  'aria-[current=page]:font-medium aria-[current=page]:text-(--text-primary)';

@Component({
  selector: 'app-docs-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  host: {
    class: 'block border-t border-(--border-default)',
    // On the host, not the panel: a key handler on a non-focusable element fails
    // the template a11y lint. It is a no-op while the panel is closed.
    '(keydown.escape)': 'closeMenu()',
  },
  template: `
    <div class="lg:grid lg:grid-cols-[16rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr]">
      <div
        class="flex min-h-12 items-center gap-3 border-b border-(--border-default) px-4 py-2 md:px-6 lg:col-start-2 lg:row-start-1 lg:px-8"
      >
        <button
          #menuButton
          type="button"
          class="inline-flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-md border border-(--border-default) text-(--text-primary) transition-colors hover:bg-(--surface-muted) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) lg:hidden"
          aria-controls="docs-nav-panel"
          [attr.aria-expanded]="menuOpen()"
          i18n-aria-label="@@app.docs.nav.toggle.aria"
          aria-label="Docs menu"
          (click)="menuOpen.set(!menuOpen())"
        >
          <svg
            aria-hidden="true"
            class="h-4.5 w-4.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          >
            <rect width="18" height="18" x="3" y="3" rx="2" />
            <path d="M9 3v18" />
          </svg>
        </button>

        <nav class="min-w-0" i18n-aria-label="@@app.docs.breadcrumbs.aria" aria-label="Breadcrumb">
          <ol class="flex min-w-0 items-center gap-2 text-sm">
            @for (crumb of location().crumbs; track $index) {
              <li class="flex min-w-0 items-center gap-2">
                @if (!$first) {
                  <span aria-hidden="true" class="text-(--text-tertiary)">/</span>
                }
                @if (crumb.path; as path) {
                  <a
                    [routerLink]="path"
                    class="truncate rounded-sm text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                    >{{ crumb.label }}</a
                  >
                } @else {
                  <span aria-current="page" class="truncate font-medium text-(--text-primary)">{{
                    crumb.label
                  }}</span>
                }
              </li>
            }
          </ol>
        </nav>

        @if (location().page; as page) {
          <p
            class="ms-auto hidden shrink-0 text-sm text-(--text-secondary) sm:block"
            i18n="@@app.docs.lastUpdated"
          >
            Last updated {{ page.lastUpdated }}
          </p>
        }
      </div>

      <div
        id="docs-nav-panel"
        class="border-b border-(--border-default) bg-(--surface-raised) lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:block lg:border-e lg:border-b-0"
        [class.hidden]="!menuOpen()"
      >
        <!-- Two trees, one per guide, picked from the URL alone (AECI-1265), so
             the SSR HTML is the same for every visitor of a page. -->
        <nav
          class="px-3 py-4 lg:sticky lg:top-0 lg:max-h-dvh lg:overflow-y-auto lg:py-6"
          [attr.aria-label]="navLabel()"
          [attr.data-guide]="location().guide"
        >
          @if (location().guide === 'vendor') {
            <a
              routerLink="/docs"
              class="mb-3 flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
            >
              <svg
                aria-hidden="true"
                class="h-4 w-4 shrink-0 rtl:-scale-x-100"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <path d="m15 18-6-6 6-6" />
              </svg>
              <span i18n="@@app.docs.nav.vendor.back">Back to the help center</span>
            </a>
          }
          <ul class="space-y-0.5">
            @if (location().guide === 'help') {
              <li>
                <a
                  routerLink="/docs"
                  routerLinkActive
                  [routerLinkActiveOptions]="exact"
                  ariaCurrentWhenActive="page"
                  [class]="treeLink"
                  i18n="@@app.docs.nav.home"
                  >Help center</a
                >
              </li>
            }
            @for (entry of tree(); track entry.section.id) {
              @let section = entry.section;
              <li [attr.data-section]="section.id">
                <a
                  [routerLink]="section.path"
                  routerLinkActive
                  [routerLinkActiveOptions]="exact"
                  ariaCurrentWhenActive="page"
                  [class]="treeLink"
                  >{{ section.label }}</a
                >
                @if (entry.children.length > 0) {
                  <ul class="ms-3 mt-0.5 mb-2 space-y-0.5 border-s border-(--border-default) ps-2">
                    @for (page of entry.children; track page.slug) {
                      <li>
                        <a
                          [routerLink]="page.path"
                          routerLinkActive
                          [routerLinkActiveOptions]="exact"
                          ariaCurrentWhenActive="page"
                          [class]="treeLink"
                          >{{ page.title }}</a
                        >
                      </li>
                    }
                  </ul>
                }
              </li>
            }
          </ul>
        </nav>
      </div>

      <div class="min-w-0 lg:col-start-2 lg:row-start-2">
        <router-outlet />
      </div>
    </div>
  `,
})
export class DocsShellComponent {
  private readonly router = inject(Router);
  private readonly menuButton = viewChild.required<ElementRef<HTMLButtonElement>>('menuButton');

  protected readonly treeLink = TREE_LINK;
  protected readonly exact = { exact: true };

  /** The small-screen panel. Closed in SSR HTML, so every visitor gets the same page. */
  protected readonly menuOpen = signal(false);

  /** Current path, query and fragment stripped. */
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects.split(/[?#]/)[0] ?? ''),
    ),
    { initialValue: this.router.url.split(/[?#]/)[0] ?? '' },
  );

  protected readonly location = computed<DocsLocation>(() => locate(this.path()));

  /** The current guide's sections, as sidebar items. */
  protected readonly tree = computed<readonly TreeSection[]>(() =>
    sidebarTree(this.location().guide),
  );

  protected readonly navLabel = computed(() =>
    this.location().guide === 'vendor'
      ? $localize`:@@app.docs.nav.vendor.aria:Vendor guide`
      : $localize`:@@app.docs.nav.aria:Help center`,
  );

  constructor() {
    this.router.events
      .pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.menuOpen.set(false));
  }

  /** Escape while the panel is open closes it and returns focus to the button. */
  protected closeMenu(): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    this.menuButton().nativeElement.focus();
  }
}

/**
 * One guide's sidebar items, in section order. A single-page section has no
 * children. A section whose landing is a `home` page links to it, so that page
 * is not listed again under it.
 */
export function sidebarTree(
  guide: DocsGuide,
  sections: readonly DocsSection[] = DOCS_SECTIONS,
): readonly TreeSection[] {
  return sections
    .filter((section) => section.guide === guide)
    .map((section) => ({
      section,
      children: section.singlePage
        ? []
        : section.pages.filter((page) => page.path !== section.path),
    }));
}

/**
 * The breadcrumb trail, the article (if any) and the guide for a docs path.
 * `sections` defaults to the manifest; a spec passes a fixture to reach a
 * single-page section, which the real manifest does not show today.
 */
export function locate(
  path: string,
  sections: readonly DocsSection[] = DOCS_SECTIONS,
): DocsLocation {
  const home = $localize`:@@app.docs.breadcrumbs.helpCenter:Help center`;
  const page = sections.flatMap((entry) => entry.pages).find((entry) => entry.path === path);
  const section = page
    ? sections.find((entry) => entry.id === page.section)
    : sections.find((entry) => entry.hasIndex && entry.path === path);
  const guide = section?.guide ?? 'help';
  if (!section) return { crumbs: [{ label: home }], guide };
  // The section's own landing (its index, its one page, or its `home` page) is
  // the current crumb. On any other page the section is a link.
  const sectionIsCurrent = section.path === path;
  return {
    page,
    guide,
    crumbs: [
      { label: home, path: '/docs' },
      sectionIsCurrent ? { label: section.label } : { label: section.label, path: section.path },
    ],
  };
}
