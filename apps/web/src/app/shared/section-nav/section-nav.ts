import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  input,
  signal,
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
 * **Scrolling is native, not JS.** The app ships `<base href="/">`, which makes
 * a fragment-only `href="#id"` resolve against the base (`/#id`) and drop the
 * current path — so a bare fragment link would bounce a subpage visitor to the
 * home route. The parent already knows the page path (it resolved the entity),
 * so it passes `basePath` and we render a full, path-preserving
 * `href="{basePath}#{id}"`. A plain anchor to the same path + a new fragment is
 * a same-document scroll the browser handles itself: it honors each target's
 * `scroll-margin-top` (so the heading clears the sticky nav) and — via the
 * global `html { scroll-behavior: smooth }` rule (styles.css, reset to `auto`
 * for `prefers-reduced-motion`) — animates smoothly where supported and jumps
 * instantly otherwise. This works under SSR, for crawlers, no-JS, before
 * hydration, and right-click "copy link" alike, and (unlike
 * `scrollIntoView({behavior:'smooth'})`) can never silently no-op.
 *
 * The only JS is the active-link highlight: a click marks the target active for
 * instant feedback, and an `IntersectionObserver` scrollspy keeps it in sync as
 * the user scrolls. The observer is wired in an `afterRenderEffect` (browser-only
 * by contract, and after the sibling sections are in the DOM) that reads
 * `sections()`, so it re-subscribes whenever the section set changes — e.g. when
 * a client-side navigation reuses this component for a different product. The
 * active link is marked `aria-current="location"`. Link text uses
 * `--text-secondary`, never `--text-tertiary` (fails WCAG AA — AECI-166/149).
 */
@Component({
  selector: 'aec-section-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Sticky lives on the HOST, not the inner <nav>: position:sticky only travels
  // within its containing block, and the host's containing block is the tall
  // body column (same setup the metadata sidebar uses). A sticky <nav> inside
  // the host would be trapped in the host's own (nav-height) box and never stick.
  host: {
    class:
      'block sticky top-0 z-10 border-b border-(--border-default) bg-(--surface-base)/85 backdrop-blur',
  },
  template: `
    <nav aria-label="On this page" i18n-aria-label="@@products.detail.nav.aria">
      <ul class="flex gap-x-6 overflow-x-auto whitespace-nowrap py-3">
        @for (s of sections(); track s.id) {
          <li>
            <a
              [href]="basePath() + '#' + s.id"
              [attr.aria-current]="activeId() === s.id ? 'location' : null"
              (click)="activeId.set(s.id)"
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

  /** DOM id of the section currently in view; drives `aria-current` + emphasis. */
  protected readonly activeId = signal<string | null>(null);

  constructor() {
    // Reading `sections()` makes this effect re-run whenever the section set
    // changes; `onCleanup` disconnects the previous observer first. This matters
    // because the page component is reused across client-side product→product
    // navigations (default RouteReuseStrategy) — a one-shot setup would keep
    // observing the prior product's section nodes. `afterRenderEffect` runs
    // browser-only and after the sibling sections are committed to the DOM.
    afterRenderEffect((onCleanup) => {
      if (typeof IntersectionObserver === 'undefined') return;

      // Bias the trigger band to the upper viewport so the active link reflects
      // the section just under the sticky nav, not whatever is centered.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.target.id) {
              this.activeId.set(entry.target.id);
            }
          }
        },
        { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
      );

      for (const s of this.sections()) {
        const el = document.getElementById(s.id);
        if (el) observer.observe(el);
      }

      onCleanup(() => observer.disconnect());
    });
  }
}
