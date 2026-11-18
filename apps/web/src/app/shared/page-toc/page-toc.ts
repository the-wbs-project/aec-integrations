/**
 * The "On this page" list of a long reading page (AECI-1720 layout pass): the
 * page's own `h2`s as plain links, in the column beside the article from `lg`.
 * Used by `/methodology` and `/legal/*`, whose 42rem or 70ch article would
 * otherwise leave the right half of a desktop screen empty. The article keeps
 * its measure; the list fills the width by layout.
 *
 * **The docs rail's behaviour, with the labels shown.** It works as the docs
 * article's rail does (`docs/docs-toc.ts`), so a reader meets one behaviour:
 *
 * - Links are plain anchors to the current path and query plus `#id`, never a
 *   bare `#id`, which `<base href>` would resolve against `/`. They come from
 *   `injectInPageHrefFor()` (`shared/in-page-href.ts`), so the SSR HTML keeps
 *   only the cache key's params and is the same for every visitor.
 * - Each link carries `data-smooth-scroll`, so `InPageSmoothScroll` animates the
 *   jump except under reduced motion. The browser does the jump itself and
 *   honours each heading's `scroll-margin-top`. No router scroll, no offset.
 * - The click listener is on the host, never on an `<a>` (AECI-1655). It only
 *   moves the highlight and never calls `preventDefault`.
 * - The SSR HTML marks the first heading current, the same for every visitor.
 *   After the first browser render an `IntersectionObserver` moves the mark,
 *   `aria-current="location"`, as the reader scrolls.
 *
 * The difference is the look. The docs rail is a column of dashes that opens on
 * hover, because it sits beside the docs sidebar. Here the column is wide, so
 * the labels show: `--t-14` `--text-secondary` links on a hairline start edge,
 * the current one `--text-primary` at 600 with a 2px Forest bar on that edge.
 * Each link is at least a 24px target (WCAG 2.2 target size), as the docs
 * rail's are, so a 20-heading agreement still fits one screen. The colour is
 * never the only mark of the current link: its weight changes too, and the bar
 * is a background, which forced colours removes, so the weight carries it there.
 *
 * Nothing here reads the visitor, and the page decides where it shows (the
 * callers hide it below `lg`). It renders nothing below two headings.
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

/** The list's place in that row: hidden below `lg`, then sticky beside the article. */
export const PROSE_PAGE_TOC_CLASS =
  'hidden lg:sticky lg:top-8 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:block lg:max-w-sm lg:self-start';

/** Below this many headings a list would point at one place. */
export const PAGE_TOC_MIN_HEADINGS = 2;

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
  selector: 'aec-page-toc',
  host: {
    // Delegated, highlight-only. Kept off the <a> on purpose; see the docblock.
    '(click)': 'onClick($event)',
  },
  template: `
    @if (visible()) {
      <nav [attr.aria-labelledby]="labelId">
        <p [id]="labelId" class="aec-overline text-(--text-secondary)" i18n="@@app.pageToc.heading">
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
  `,
})
export class AecPageToc {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** The page's `h2`s, in order. */
  readonly headings = input.required<readonly DocsHeading[]>();

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
      // The trigger band is the upper part of the viewport, as on the docs rail.
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
