/**
 * The one "On this page" component (AECI-1259; one component since the AECI-1720
 * layout pass): the page's own `h2`s as in-page links, in two looks.
 *
 * - `variant="rail"`, the docs article (`docs/docs-page.ts`, as `<app-docs-toc>`):
 *   after Devin's DeepWiki, one short dash per `h2` at the far right of the
 *   content, the current one longer and darker. Hovering the rail, or tabbing
 *   into it, opens it into the list of headings. Each dash is `aria-hidden`. The
 *   link around it carries the heading text, visually hidden until the rail
 *   opens, so a screen reader hears named links and a keyboard user opens the
 *   rail by tabbing into it (`:focus-within`). Open and closed are CSS only
 *   (`.aec-docs-toc` in `styles.css`).
 * - `variant="list"`, the default, on `/methodology` and `/legal/*`: the labels
 *   shown, in the wide column beside the article, whose 42rem or 70ch measure
 *   would otherwise leave the right half of a desktop screen empty. `--t-14`
 *   `--text-secondary` links on a hairline start edge, the current one
 *   `--text-primary` at 600 with a 2px Forest bar on that edge. A visible
 *   overline "On this page" names the `nav`. The colour is never the only mark of
 *   the current link: its weight changes too, and the bar is a background, which
 *   forced colours removes, so the weight carries it there. It sticks only on a
 *   viewport tall enough to show all of it (`aec-page-toc` in `styles.css`).
 *
 * **One behaviour for both looks:**
 *
 * - Links are plain anchors to the current path and query plus `#id`, never a
 *   bare `#id`, which `<base href>` would resolve against `/`. They come from
 *   `injectInPageHrefFor()` (`shared/in-page-href.ts`), so a URL with a query
 *   (`?utm_source=…`) jumps in place instead of reloading (AECI-1843), and the
 *   server HTML keeps only the cache key's params, so it is the same for every
 *   visitor. The browser does the same-document jump itself and honours each
 *   heading's `scroll-margin-top`, the way the product page section nav does.
 * - Each link carries `data-smooth-scroll`, so `InPageSmoothScroll`
 *   (`core/in-page-smooth-scroll.ts`) animates the jump, except under reduced
 *   motion (AECI-1752). No router scroll, no offset.
 * - The click listener is on the host, never on an `<a>`: an anchor that owns a
 *   listener can go dead after an early click (AECI-1655). The host finds the
 *   anchor with `closest('a')`, sets the highlight and never calls
 *   `preventDefault`.
 * - The SSR HTML marks the first heading current, the same for every visitor,
 *   because the page is edge-cached. Only after the first browser render
 *   (`afterNextRender`) does an `IntersectionObserver` move the mark,
 *   `aria-current="location"`, as the reader scrolls.
 * - Each link is at least a 24px target (WCAG 2.2 target size).
 * - Nothing renders below two headings, where it would point at one place.
 *
 * The page decides where it shows: the docs rail from `xl`, the list from `lg`.
 */
import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import type { DocsHeading } from '../../docs/docs-markdown';
import { injectInPageHrefFor } from '../in-page-href';

/**
 * The body row of a reading page from `lg`: the article at its own measure in the
 * first column, the list in the second. The article sets its own `max-w`; the
 * first track is `auto` so a 42rem and a 70ch article both fit it.
 */
export const PROSE_PAGE_GRID_CLASS =
  'lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:gap-x-16 xl:gap-x-24';

/**
 * The list's place in that row: hidden below `lg`, then sticky beside the
 * article. `styles.css` (`aec-page-toc`) turns the stick off on a viewport too
 * short to show the whole list, as it does for the product page aside. It never
 * prints: on paper it would be a list of links to nowhere.
 */
export const PROSE_PAGE_TOC_CLASS =
  'hidden lg:sticky lg:top-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:block lg:max-w-sm lg:self-start print:hidden';

/** Below this many headings the component would point at one place. */
export const PAGE_TOC_MIN_HEADINGS = 2;

/** The docs article's name for the same threshold. */
export const DOCS_TOC_MIN_HEADINGS = PAGE_TOC_MIN_HEADINGS;

/** The two looks: the docs article's dash rail, or the labelled list. */
export type PageTocVariant = 'rail' | 'list';

/** The id of the list's label. Reserved, so no heading slug can take it. */
export const PAGE_TOC_HEADING_ID = 'page-toc-heading';

const LINK =
  'relative -ms-px flex min-h-6 items-center py-1 ps-4 text-t-14 leading-snug ' +
  'text-(--text-secondary) transition-colors duration-fast ease-standard ' +
  'hover:text-(--text-primary) before:absolute before:inset-y-1 before:start-0 before:w-0.5 ' +
  'before:rounded-full aria-[current=location]:font-semibold ' +
  'aria-[current=location]:text-(--text-primary) aria-[current=location]:before:bg-(--accent-primary) ' +
  'focus-visible:rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 ' +
  'focus-visible:outline-(--accent-primary)';

@Component({
  // `app-docs-toc` is the docs article's name for the rail, kept so the docs HTML
  // and the specs that find it do not change. Both names are this one component.
  selector: 'aec-page-toc, app-docs-toc',
  host: {
    // Delegated, highlight-only. Kept off the <a> on purpose; see the docblock.
    '(click)': 'onClick($event)',
  },
  template: `
    @if (visible()) {
      @if (variant() === 'rail') {
        <nav class="aec-docs-toc" i18n-aria-label="@@app.docs.toc.aria" aria-label="On this page">
          <ol class="aec-docs-toc-list">
            @for (heading of headings(); track heading.id) {
              <li>
                <a
                  [href]="hrefFor()(heading.id)"
                  [attr.data-heading-id]="heading.id"
                  data-smooth-scroll
                  [attr.aria-current]="heading.id === activeId() ? 'location' : null"
                  class="aec-docs-toc-link rounded-mark focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
                >
                  <span class="aec-docs-toc-label">{{ heading.text }}</span>
                  <span aria-hidden="true" class="aec-docs-toc-dash"></span>
                </a>
              </li>
            }
          </ol>
        </nav>
      } @else {
        <nav [attr.aria-labelledby]="labelId">
          <p
            [id]="labelId"
            class="aec-overline text-(--text-secondary)"
            i18n="@@app.pageToc.heading"
          >
            On this page
          </p>
          <ol class="mt-4 border-s border-(--border-default)">
            @for (heading of headings(); track heading.id) {
              <li>
                <a
                  [href]="hrefFor()(heading.id)"
                  [attr.data-heading-id]="heading.id"
                  data-smooth-scroll
                  [attr.aria-current]="heading.id === activeId() ? 'location' : null"
                  [class]="link"
                  >{{ heading.text }}</a
                >
              </li>
            }
          </ol>
        </nav>
      }
    }
  `,
})
export class AecPageToc {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** The page's `h2`s, in order. A docs article has already left out "Related". */
  readonly headings = input.required<readonly DocsHeading[]>();
  /** `rail` for the docs article's dashes, `list` for the labelled list. */
  readonly variant = input<PageTocVariant>('list');

  protected readonly labelId = PAGE_TOC_HEADING_ID;
  protected readonly link = LINK;
  /** Builds `{path}[?query]#id` for the current URL (AECI-1843). */
  protected readonly hrefFor = injectInPageHrefFor();

  protected readonly visible = computed(() => this.headings().length >= PAGE_TOC_MIN_HEADINGS);

  /** Set by a click or by the observer. Never set on the server. */
  protected readonly picked = signal<string | null>(null);
  /** The heading in view: the first until the browser says otherwise. */
  protected readonly activeId = computed(() => this.picked() ?? this.headings()[0]?.id ?? null);

  /** Marks the clicked heading current at once. The anchor's own jump scrolls. */
  protected onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest('a[data-heading-id]')?.getAttribute('data-heading-id');
    if (id) this.picked.set(id);
  }

  constructor() {
    afterNextRender(() => {
      if (!this.visible() || typeof IntersectionObserver === 'undefined') return;
      // Trigger band in the upper part of the viewport, so the mark follows the
      // heading the reader has just reached, not the one in the middle.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.target.id) this.picked.set(entry.target.id);
          }
        },
        { rootMargin: '0px 0px -70% 0px', threshold: 0 },
      );
      for (const heading of this.headings()) {
        const el = this.document.getElementById(heading.id);
        if (el) observer.observe(el);
      }
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
