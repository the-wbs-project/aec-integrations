/**
 * The "On this page" rail on a docs article (AECI-1259), after Devin's DeepWiki:
 * one short horizontal dash per `h2` at the far right of the content, the
 * current one longer and darker. Hovering the rail, or tabbing into it, opens
 * it into the list of headings.
 *
 * **Real links, not decoration.** Each dash is `aria-hidden`. The link around
 * it carries the heading text, which is visually hidden until the rail opens.
 * A screen reader hears a list of named links, and a keyboard user opens the
 * rail by tabbing into it (`:focus-within`), so the focused link is always
 * visible. The open and closed states are CSS only (`.aec-docs-toc` in
 * `styles.css`); no script decides what is shown.
 *
 * **Links.** Plain anchors to the page's absolute path plus `#id`, never a bare
 * `#id`, which `<base href>` would resolve against `/`. The browser does the
 * same-document jump itself and honours each heading's `scroll-margin-top`, the
 * way the product page section nav does (`shared/section-nav/section-nav.ts`).
 * Each link carries `data-smooth-scroll`, so `InPageSmoothScroll`
 * (`core/in-page-smooth-scroll.ts`) animates the jump, except under reduced
 * motion (AECI-1752). They were `routerLink`s until AECI-1752. A `RouterLink`
 * cancels the click and the router scrolls instead, and `ScrollBehaviorManager`
 * keeps router scrolls instant, so the rail could not animate.
 *
 * The click listener is on the host, never on an `<a>`: an anchor that owns a
 * listener can go dead after an early click (AECI-1655, `ANGULAR_STYLE_GUIDE.md`).
 * The host finds the anchor with `closest('a')`, sets the highlight and never
 * calls `preventDefault`.
 *
 * **Active heading.** The SSR HTML marks the first heading current, the same for
 * every visitor, because the page is edge-cached. Only after the first browser
 * render (`afterNextRender`) does an `IntersectionObserver` move the mark as
 * the reader scrolls. The mark is `aria-current="location"`.
 *
 * The rail shows from `xl` (the parent hides it below) and renders nothing for
 * a page with fewer than two headings, where it would point at one place.
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

import type { DocsHeading } from './docs-markdown';

/** Below this many headings the rail is not worth a column. */
export const DOCS_TOC_MIN_HEADINGS = 2;

@Component({
  selector: 'app-docs-toc',
  host: {
    // Delegated, highlight-only. Kept off the <a> on purpose; see the docblock.
    '(click)': 'onClick($event)',
  },
  template: `
    @if (visible()) {
      <nav class="aec-docs-toc" i18n-aria-label="@@app.docs.toc.aria" aria-label="On this page">
        <ol class="aec-docs-toc-list">
          @for (heading of headings(); track heading.id) {
            <li>
              <a
                [href]="path() + '#' + heading.id"
                [attr.data-heading-id]="heading.id"
                data-smooth-scroll
                [attr.aria-current]="heading.id === activeId() ? 'location' : null"
                class="aec-docs-toc-link rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <span class="aec-docs-toc-label">{{ heading.text }}</span>
                <span aria-hidden="true" class="aec-docs-toc-dash"></span>
              </a>
            </li>
          }
        </ol>
      </nav>
    }
  `,
})
export class DocsTocComponent {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  /** The article's `h2`s, the closing "Related" already left out. */
  readonly headings = input.required<readonly DocsHeading[]>();
  /** The article's absolute path, so each link keeps the page and adds a fragment. */
  readonly path = input.required<string>();

  protected readonly visible = computed(() => this.headings().length >= DOCS_TOC_MIN_HEADINGS);

  /** Set by a click or by the observer. Never set on the server. */
  protected readonly picked = signal<string | null>(null);
  /** The heading in view: the first until the browser says otherwise. */
  protected readonly activeId = computed(() => this.picked() ?? this.headings()[0]?.id ?? null);

  /**
   * Marks the clicked heading current at once, before the observer catches up.
   * Highlight only: the anchor's native same-document jump does the scroll.
   */
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
