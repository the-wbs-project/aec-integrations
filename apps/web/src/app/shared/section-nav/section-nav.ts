import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  computed,
  Component,
  input,
  signal,
  untracked,
} from '@angular/core';

/** A jumpable section: `id` is the DOM id of the scroll target, `label` is the (already-localized) link text. */
export interface SectionNavItem {
  readonly id: string;
  readonly label: string;
}

/**
 * Sticky in-page "jump to section" nav — an editorial "On this page" pattern.
 *
 * Renders a horizontal row of links that stick to the top of the viewport
 * while scrolling and jump to each section. Nothing is hidden: every target
 * stays in the DOM (crawlable; the `@defer` lazy-load triggers unaffected).
 * First adopted on the product detail page (`/products/:slug`) to keep
 * Integrations one click away as the "How teams use it" section grows.
 *
 * Generic by design — the parent supplies the present sections (with
 * already-localized labels) plus the page's absolute `basePath`, so
 * vendor/integration detail pages can reuse it.
 *
 * **Scrolling is native — but the router still runs.** The app ships `<base href="/">`, which makes
 * a fragment-only `href="#id"` resolve against the base (`/#id`) and drop the
 * current path — so a bare fragment link would bounce a subpage visitor to the
 * home route. The parent already knows the page path (it resolved the entity),
 * so it passes `basePath` and we render a full, path-preserving
 * `href="{basePath}#{id}"`. A plain anchor to the same path + a new fragment is
 * a same-document scroll the browser handles itself: it honors each target's
 * `scroll-margin-top` (so the heading clears the sticky nav). Each link carries
 * `data-smooth-scroll`, so `InPageSmoothScroll` (`core/in-page-smooth-scroll.ts`,
 * AECI-1752) turns on `scroll-behavior: smooth` for the span of the jump and the
 * browser animates it. Under `prefers-reduced-motion`, before the app starts, or
 * where smooth scrolling is unsupported, it jumps instantly. The jump itself
 * works under SSR, for crawlers, no-JS, before hydration, and right-click "copy
 * link" alike, and (unlike `scrollIntoView({behavior:'smooth'})`) can never
 * silently no-op.
 *
 * What this does NOT do is bypass Angular. A same-document fragment navigation
 * fires **`popstate`** as well as `hashchange`, and Angular's `HistoryStateManager`
 * treats `popstate` as a browser-driven navigation — so every click here also runs
 * a router navigation, and `RouterScroller` asks to re-scroll to the same fragment
 * while the browser's smooth scroll is still running.
 * `ScrollMarginViewportScroller` (`core/scroll-margin-viewport-scroller.ts`) skips
 * that second scroll. Angular's stock scroller parked every heading under this nav,
 * and interrupting the animation left Safari hit-testing at a stale position.
 * If you change `scroll-mt-20` on the target sections, nothing else needs to move
 * — but do not assume these anchors are invisible to the router.
 *
 * The only JS is the active-link highlight: a click marks the target active for
 * instant feedback, and an `IntersectionObserver` scrollspy keeps it in sync as
 * the user scrolls. The observer is wired in an `afterRenderEffect` (browser-only
 * by contract, and after the sibling sections are in the DOM) that reads
 * `sections()`, so it re-subscribes whenever the section set changes — e.g. when
 * a client-side navigation reuses this component for a different product. The
 * active link is marked `aria-current="location"`. Until a click or the
 * scrollspy names one, the FIRST link is current, so a screen reader always
 * hears where it is (AECI-831). SSR renders that same default for every visitor.
 *
 * **The click listener is on the host, never on the `<a>` (AECI-1655).** The
 * host's one delegated `(click)` finds the clicked anchor with `closest('a')`
 * and reads its `data-section-id`. It only sets the highlight and never calls
 * `preventDefault`. Do not move it back onto the anchors. Angular's event-replay
 * dispatcher caches each element's `jsaction` and keeps listening after
 * hydration. Once an anchor that owned a click action took a click before the
 * app was stable, the dispatcher called `preventDefault` on every later click on
 * that anchor, so the link went dead. `core/event-replay.component.spec.ts`
 * pins that behaviour. A listener on the host leaves the anchors with no
 * `jsaction`, so their native default always runs. Keyboard users still activate
 * the anchors, and Enter's synthetic click bubbles to the host.
 *
 * Link text uses
 * `--text-secondary`, never `--text-tertiary` (fails WCAG AA — AECI-166/149).
 */
@Component({
  selector: 'aec-section-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Sticky lives on the HOST, not the inner <nav>: position:sticky only travels
  // within its containing block. A sticky <nav> inside the host would be trapped
  // in the host's own (nav-height) box and never stick.
  //
  // For the same reason the host itself must be projected into DetailLayout's
  // `nav` slot, which renders it bare into the page container: the nav sticks
  // only as long as its PARENT is on screen, so any narrower parent (a wrapper
  // div, or the body-lead column) unpins it partway down the page.
  //
  // The background is fully OPAQUE, deliberately. A translucent
  // `bg-(--surface-base)/85 backdrop-blur` let the body underneath read through
  // as legible text — a section <h2> scrolling past sat directly on top of the
  // nav labels (AECi is an editorial surface; overlapping type is not a look).
  // `backdrop-blur` also cannot save it: it blurs, it does not hide. If a frosted
  // treatment is ever wanted back, it needs a solid layer under it, not an alpha.
  host: {
    class: 'block sticky top-0 z-10 border-b border-(--border-default) bg-(--surface-base)',
    // Delegated, highlight-only. Kept off the <a> on purpose; see the docblock.
    '(click)': 'onClick($event)',
  },
  template: `
    <nav aria-label="On this page" i18n-aria-label="@@products.detail.nav.aria">
      <ul class="flex gap-x-6 overflow-x-auto whitespace-nowrap py-3">
        @for (s of sections(); track s.id) {
          <li>
            <a
              [href]="basePath() + '#' + s.id"
              [attr.data-section-id]="s.id"
              data-smooth-scroll
              [attr.aria-current]="activeId() === s.id ? 'location' : null"
              class="text-sm font-medium text-(--text-secondary) no-underline
                transition-colors hover:text-(--text-primary)
                aria-[current=location]:font-bold
                aria-[current=location]:text-(--accent-primary)
                focus-visible:outline-none focus-visible:rounded-(--radius-sm)
                focus-visible:ring-2 focus-visible:ring-(--accent-primary)
                focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
            >
              {{ s.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class SectionNav {
  readonly sections = input.required<readonly SectionNavItem[]>();
  /** Absolute path of the current page (e.g. `/products/egnyte`), used to build path-preserving hrefs. */
  readonly basePath = input.required<string>();

  /** DOM id of the section the scrollspy or a click last named. */
  protected readonly observedId = signal<string | null>(null);

  /** The current section; drives `aria-current` + emphasis. Defaults to the first. */
  protected readonly activeId = computed(() => this.observedId() ?? this.sections()[0]?.id ?? null);

  /**
   * Marks the clicked link current. Highlight only: the anchor's native
   * same-document scroll does the jump, so this never calls `preventDefault`.
   * A replayed early click lands here too, which is right, because the browser
   * already scrolled.
   */
  protected onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest('a[data-section-id]')?.getAttribute('data-section-id');
    if (id) this.observedId.set(id);
  }

  constructor() {
    // Reading `sections()` makes this effect re-run whenever the section set
    // changes; `onCleanup` disconnects the previous observer first. This matters
    // because the page component is reused across client-side product→product
    // navigations (default RouteReuseStrategy) — a one-shot setup would keep
    // observing the prior product's section nodes. `afterRenderEffect` runs
    // browser-only and after the sibling sections are committed to the DOM.
    afterRenderEffect((onCleanup) => {
      // A new section set starts again from its first link.
      const sections = this.sections();
      untracked(() => this.observedId.set(null));
      if (typeof IntersectionObserver === 'undefined') return;

      // Bias the trigger band to the upper viewport so the active link reflects
      // the section just under the sticky nav, not whatever is centered.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.target.id) {
              this.observedId.set(entry.target.id);
            }
          }
        },
        { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
      );

      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el) observer.observe(el);
      }

      onCleanup(() => observer.disconnect());
    });
  }
}
