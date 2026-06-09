/**
 * Site header.
 *
 * Responsive: below `md` it is a minimal `[☰ wordmark]` bar — the hamburger
 * `aec-nav-menu` (its own `md:hidden` host) opens an overlay that holds the
 * links, search, theme toggle, and Sign-in. At `md+` the hamburger drops out and
 * those affordances render inline: a centered primary `<nav>` with the four
 * directory links, plus a right-side cluster (search at `lg+`, theme toggle,
 * Sign-in CTA), over a warm Bone "shelf" that reads as editorial structure
 * rather than chrome. The inline nav reuses the same i18n ids as the overlay, so
 * Angular de-dupes them — no new strings. Only one `<nav aria-label="Primary">`
 * is ever in the a11y tree at a given width (the inline nav is `display:none`
 * below `md`; the overlay nav never mounts at `md+`). The four directory links
 * are also mirrored in the SSR footer for crawlers / no-JS; see `nav-menu.ts`.
 *
 * Spec: §16 Phase 1 ("Basic layout shell"); §3.1 (route inventory drives nav
 * placeholders); §2a (theming); §21 (a11y).
 */
import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { BrandLogo } from './brand-logo';
import { NavMenu } from './nav-menu';
import { ThemeToggle } from './theme-toggle';

@Component({
  selector: 'aec-site-header',
  imports: [RouterLink, RouterLinkActive, BrandLogo, NavMenu, ThemeToggle],
  template: `
    <header class="bg-(--surface-base)">
      <div class="mx-auto flex max-w-7xl items-center gap-3 px-8 py-5 md:gap-8">
        <aec-nav-menu />
        <aec-brand-logo />
        <nav
          class="hidden flex-1 items-center justify-center gap-7 text-sm font-medium md:flex"
          i18n-aria-label="@@app.nav.primary.aria"
          aria-label="Primary"
        >
          <a
            routerLink="/products"
            routerLinkActive="text-(--accent-primary)"
            class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.products"
          >
            Products
          </a>
          <a
            routerLink="/vendors"
            routerLinkActive="text-(--accent-primary)"
            class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.vendors"
          >
            Vendors
          </a>
          <a
            routerLink="/integrations"
            routerLinkActive="text-(--accent-primary)"
            class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.integrations"
          >
            Integrations
          </a>
          <a
            routerLink="/categories"
            routerLinkActive="text-(--accent-primary)"
            class="text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.nav.categories"
          >
            Categories
          </a>
        </nav>
        <div class="hidden items-center gap-3 md:flex">
          <label class="relative hidden lg:block">
            <span class="sr-only" i18n="@@app.header.search.label">Search</span>
            <input
              type="search"
              i18n-placeholder="@@app.header.search.placeholder"
              placeholder="Search integrations"
              class="h-9 w-52 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-4 text-sm text-(--text-primary) placeholder:text-(--text-tertiary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            />
          </label>
          <aec-theme-toggle />
          <a
            routerLink="/auth/login"
            class="inline-flex items-center rounded-(--radius-md) bg-(--accent-primary) px-4 py-1.5 text-sm font-medium text-(--surface-base) hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.header.signIn"
          >
            Sign in
          </a>
        </div>
      </div>
      <div class="h-1 w-full bg-(--accent-warm)" aria-hidden="true"></div>
    </header>
  `,
})
export class SiteHeader {}
