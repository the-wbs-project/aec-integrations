/**
 * Mobile navigation menu (below `md`).
 *
 * Below the `md` breakpoint the desktop primary `<nav>` (`hidden md:flex` in
 * `site-header.ts`) and the `lg`-only search disappear, leaving phones with no
 * way to reach the four directory sections. This component is the DESIGN.md §5
 * replacement: a labelled hamburger toggle opening a CDK-overlay dropdown with a
 * focus trap. It is the mirror of the desktop nav and only renders below `md`
 * (`host: { class: 'md:hidden' }`); the two are mutually exclusive across `md`.
 *
 * The overlay is `BrnPopover` (extends `BrnDialog`), which supplies the CDK
 * overlay, focus trap, Escape / outside-click close, and focus-return-to-trigger
 * — and reflects `aria-expanded` / `aria-haspopup` / `aria-controls` on the
 * trigger automatically. Same primitive used at `preview/vendor-detail`.
 *
 * SSR-safe: the dropdown content lives in an `ng-template` that only mounts in
 * the CDK overlay on click (always client-side), so the server renders just the
 * static, visitor-state-neutral toggle button.
 *
 * The toggle is the canonical Lucide `menu` glyph inlined as SVG with
 * `stroke="currentColor"` so it themes via `--text-primary` (DESIGN.md: Lucide
 * icons exclusively — no icon library needed for a single glyph).
 *
 * Spec: DESIGN.md §5 (Navigation); §21 (a11y); AECI-96.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

@Component({
  selector: 'aec-mobile-nav-menu',
  imports: [RouterLink, RouterLinkActive, BrnPopover, BrnPopoverContent, BrnPopoverTrigger],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'md:hidden' },
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="menu"
      type="button"
      class="inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border border-(--border-default) bg-(--surface-raised) text-(--text-primary) transition-colors hover:border-(--border-strong) hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      i18n-aria-label="@@app.nav.menu.toggle.aria"
      aria-label="Open menu"
    >
      <svg
        aria-hidden="true"
        class="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <line x1="4" x2="20" y1="6" y2="6" />
        <line x1="4" x2="20" y1="12" y2="12" />
        <line x1="4" x2="20" y1="18" y2="18" />
      </svg>
    </button>

    <brn-popover #menu="brnPopover" class="contents" align="end" [sideOffset]="8">
      <ng-template brnPopoverContent>
        <nav
          class="w-[min(92vw,17rem)] rounded-md border border-(--border-default) bg-(--surface-raised) p-2 text-(--text-primary) shadow-lg"
          i18n-aria-label="@@app.nav.primary.aria"
          aria-label="Primary"
        >
          <a
            routerLink="/products"
            routerLinkActive="text-(--accent-primary)"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.products"
          >
            Products
          </a>
          <a
            routerLink="/vendors"
            routerLinkActive="text-(--accent-primary)"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.vendors"
          >
            Vendors
          </a>
          <a
            routerLink="/integrations"
            routerLinkActive="text-(--accent-primary)"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.integrations"
          >
            Integrations
          </a>
          <a
            routerLink="/categories"
            routerLinkActive="text-(--accent-primary)"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.categories"
          >
            Categories
          </a>
          <label class="relative mt-1 block px-1 pb-1">
            <span class="sr-only" i18n="@@app.header.search.label">Search</span>
            <input
              type="search"
              i18n-placeholder="@@app.header.search.placeholder"
              placeholder="Search integrations"
              class="h-9 w-full rounded-full border border-(--border-default) bg-(--surface-base) px-4 text-sm text-(--text-primary) placeholder:text-(--text-tertiary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
          </label>
        </nav>
      </ng-template>
    </brn-popover>
  `,
})
export class MobileNavMenu {}
