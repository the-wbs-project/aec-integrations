import { NgTemplateOutlet } from '@angular/common';
import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  input,
  output,
  viewChild,
} from '@angular/core';

/**
 * Infinite-scroll footer for the append-mode listing pages (`/products`, the
 * taxonomy browse pages, and — since the vendor-list revision — `/admin/vendors`). Sits over the accumulating engine
 * (`createPaginatedIndex({ mode: 'append' })`): an `IntersectionObserver`
 * sentinel auto-loads the next page as the reader nears the end, and a real
 * "Load more" link stays present underneath as the keyboard / screen-reader /
 * no-JS floor.
 *
 * **SSR-neutral.** The server renders the "Showing X of Z" status line, the
 * "Load more" anchor, and the sentinel — all independent of any per-visitor
 * state, so the URL-keyed edge cache is never poisoned and hydration never
 * mismatches. The observer attaches client-side only.
 *
 * **Real anchor, progressively enhanced.** "Load more" is a genuine link to the
 * SSR'd next page (`?page=N+1`): it works with no JS and gives crawlers the
 * pagination trail (so the AECI-64 internal-link-graph crawl keeps resolving).
 * JS intercepts an unmodified left-click, `preventDefault()`s, and appends in
 * place instead — so the page number never enters the address bar (paging is
 * internal to the engine). **Omit `nextHref` and the control renders as a
 * `<button>` instead**: the admin screens fetch client-side behind
 * `requireAdmin()`, so there is no SSR'd `?page=2` to point at and no crawler to
 * give a trail to — and an `<a>` with no `href` is not focusable, which would
 * silently make scroll the only way to page.
 *
 * **Accessible.** The status line is an `aria-live` region announced on each
 * append (WCAG 4.1.3); the "Load more" link is a real focusable control that
 * stays present even though scroll auto-loads, so the footer is always reachable
 * and the classic infinite-scroll keyboard trap is avoided. When nothing
 * remains, the link is gone and focus flows naturally to the footer.
 *
 * The `IntersectionObserver` follows the SSR-safe pattern from
 * `shared/section-nav/section-nav.ts`: wired in an `afterRenderEffect`
 * (browser-only by contract), guarded on `typeof IntersectionObserver`, and torn
 * down via `onCleanup`.
 */
@Component({
  selector: 'aec-pagination-footer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet],
  template: `
    <div class="flex flex-col items-center gap-4 pt-2 text-center">
      <p class="text-sm text-(--text-secondary)" aria-live="polite" aria-atomic="true">
        @if (total() !== null) {
          <span i18n="@@pagination.showing">Showing {{ loadedCount() }} of {{ total() }}</span>
        }
      </p>

      @if (hasMore()) {
        <!-- Real link: works with no JS and gives crawlers the page-2 trail. JS
             intercepts (preventDefault) and appends in place; scroll auto-loads
             via the sentinel below. The link is the de-emphasised a11y floor.
             With no nextHref (the admin screens, which have no SSR'd page-2 to
             point at) it is a real button instead: an anchor with no href is not
             focusable, which would leave keyboard and screen-reader users with
             scroll auto-load as the ONLY way to page. -->
        @if (nextHref(); as href) {
          <a
            [href]="href"
            [class]="LOAD_MORE_CLASS"
            [attr.aria-busy]="pending() ? 'true' : null"
            (click)="onClick($event)"
          >
            <ng-container *ngTemplateOutlet="loadMoreLabel" />
          </a>
        } @else {
          <button
            type="button"
            [class]="LOAD_MORE_CLASS"
            [attr.aria-busy]="pending() ? 'true' : null"
            (click)="onClick($event)"
          >
            <ng-container *ngTemplateOutlet="loadMoreLabel" />
          </button>
        }

        <ng-template #loadMoreLabel>
          @if (pending()) {
            <span class="inline-flex items-center gap-2">
              <svg
                class="h-4 w-4 animate-spin"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round" />
              </svg>
              <span i18n="@@pagination.loading">Loading…</span>
            </span>
          } @else {
            <span i18n="@@pagination.loadMore">Load more</span>
          }
        </ng-template>

        <!-- Sentinel: empty + aria-hidden (no visual, no SR noise). The observer
             attaches client-side and auto-loads as it nears the viewport. -->
        <div #sentinel aria-hidden="true" class="h-px w-full"></div>
      } @else if (loadedCount() > 0) {
        <p class="text-sm text-(--text-secondary)" i18n="@@pagination.allLoaded">
          You've reached the end ({{ total() }} in total).
        </p>
      }
    </div>
  `,
})
export class PaginationFooter {
  /** One class list, two elements (anchor / button) — see the template note. */
  protected readonly LOAD_MORE_CLASS =
    'inline-flex cursor-pointer items-center justify-center rounded-(--radius-md) ' +
    'border border-(--border-default) px-5 py-2.5 text-sm font-medium ' +
    'text-(--text-secondary) no-underline transition-colors ' +
    'hover:border-(--border-strong) hover:text-(--text-primary) ' +
    'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
    'focus-visible:outline-(--accent-primary)';

  /** Items currently rendered (the accumulated length). */
  readonly loadedCount = input.required<number>();
  /** Total result count, or `null` before the first load. */
  readonly total = input.required<number | null>();
  /** Whether more pages remain. */
  readonly hasMore = input.required<boolean>();
  /** Whether a page fetch is in flight (drives the spinner + debounces auto-load). */
  readonly pending = input.required<boolean>();
  /** Absolute `?page=N+1` URL (current params merged) for the real anchor / no-JS path. */
  readonly nextHref = input<string | null>(null);

  /** Emitted to advance a page (manual click or scroll auto-load). */
  readonly loadMore = output<void>();

  private readonly sentinel = viewChild<ElementRef<HTMLElement>>('sentinel');

  constructor() {
    afterRenderEffect((onCleanup) => {
      if (typeof IntersectionObserver === 'undefined') return;
      // Reading `sentinel()` re-runs the effect when the sentinel mounts/unmounts
      // (e.g. when `hasMore` flips), re-arming or tearing down the observer.
      const el = this.sentinel()?.nativeElement;
      if (!el) return;

      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && !this.pending() && this.hasMore()) {
              this.loadMore.emit();
            }
          }
        },
        // Pre-load before the sentinel is actually on screen so the next page is
        // ready as the reader arrives — the "endless feed" feel.
        { rootMargin: '600px 0px', threshold: 0 },
      );
      observer.observe(el);
      onCleanup(() => observer.disconnect());
    });
  }

  protected onClick(event: MouseEvent): void {
    // Let modified clicks (open-in-new-tab) and no-JS fall through to the real
    // href; otherwise append in place. (On the <button> branch there is nothing
    // to fall through to, but the guard is harmless and keeps one handler.)
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (this.pending() || !this.hasMore()) return;
    this.loadMore.emit();
  }
}
