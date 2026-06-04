import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Global 404 surface (AECI-62 / Phase 2.16). Rendered by:
 *
 *   1. The `**` wildcard route in `app.routes.ts` (unknown URL).
 *   2. Any detail page whose resolver returned `null` because the API
 *      reported NOT_FOUND. The detail component renders this component
 *      inline so the URL the visitor typed stays intact (no router redirect).
 *
 * Status code (404) and noindex meta are set by the calling resolver via
 * `RESPONSE_INIT.status = 404` and `MetaService.setNotFoundMeta` — this
 * component is purely visual.
 *
 * Spec anchors: Stage 1 Spec §9.1b (real 404, no pinned-404 trap) and §20.7
 * (useful 404 — recovery links to top entry points). Phase 3 will replace
 * the static search hint with the live Algolia search input.
 */
@Component({
  selector: 'aec-not-found',
  imports: [RouterLink],
  template: `
    <section
      class="mx-auto w-full max-w-3xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="not-found-title"
    >
      <p
        class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
        i18n="@@notFound.eyebrow"
      >
        404: Not found
      </p>
      <h1
        id="not-found-title"
        class="mt-3 font-display text-3xl font-semibold tracking-tight md:text-4xl"
        i18n="@@notFound.title"
      >
        We couldn't find that page.
      </h1>
      <p
        class="mt-4 max-w-2xl text-base leading-relaxed text-(--text-secondary)"
        i18n="@@notFound.body"
      >
        The page you were looking for may have been renamed, removed, or never existed. Try one of
        the directories below to find what you need.
      </p>

      <p
        class="mt-6 max-w-2xl text-sm leading-relaxed text-(--text-secondary)"
        i18n="@@notFound.searchHint"
      >
        Search is coming soon. In the meantime, browse by directory.
      </p>

      <nav aria-labelledby="not-found-recovery" class="mt-10">
        <h2
          id="not-found-recovery"
          class="text-sm font-semibold uppercase tracking-[0.12em] text-(--text-secondary)"
          i18n="@@notFound.recoveryHeading"
        >
          Browse the directory
        </h2>
        <ul class="mt-4 grid gap-3 sm:grid-cols-2">
          <li>
            <a
              routerLink="/products"
              class="block rounded-(--radius-md) border border-(--border-default)
                bg-(--surface-raised) px-5 py-4 no-underline transition-colors
                hover:border-(--border-strong) hover:text-(--accent-primary)
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                focus-visible:ring-offset-(--surface-base)"
            >
              <span
                class="block text-base font-semibold text-(--text-primary)"
                i18n="@@notFound.links.products.label"
              >
                Products
              </span>
              <span
                class="mt-1 block text-sm text-(--text-secondary)"
                i18n="@@notFound.links.products.helper"
              >
                Every AEC tool in the directory.
              </span>
            </a>
          </li>
          <li>
            <a
              routerLink="/vendors"
              class="block rounded-(--radius-md) border border-(--border-default)
                bg-(--surface-raised) px-5 py-4 no-underline transition-colors
                hover:border-(--border-strong) hover:text-(--accent-primary)
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                focus-visible:ring-offset-(--surface-base)"
            >
              <span
                class="block text-base font-semibold text-(--text-primary)"
                i18n="@@notFound.links.vendors.label"
              >
                Vendors
              </span>
              <span
                class="mt-1 block text-sm text-(--text-secondary)"
                i18n="@@notFound.links.vendors.helper"
              >
                Software companies serving AEC.
              </span>
            </a>
          </li>
          <li>
            <a
              routerLink="/integrations"
              class="block rounded-(--radius-md) border border-(--border-default)
                bg-(--surface-raised) px-5 py-4 no-underline transition-colors
                hover:border-(--border-strong) hover:text-(--accent-primary)
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                focus-visible:ring-offset-(--surface-base)"
            >
              <span
                class="block text-base font-semibold text-(--text-primary)"
                i18n="@@notFound.links.integrations.label"
              >
                Integrations
              </span>
              <span
                class="mt-1 block text-sm text-(--text-secondary)"
                i18n="@@notFound.links.integrations.helper"
              >
                How products connect to each other.
              </span>
            </a>
          </li>
          <li>
            <a
              routerLink="/categories"
              class="block rounded-(--radius-md) border border-(--border-default)
                bg-(--surface-raised) px-5 py-4 no-underline transition-colors
                hover:border-(--border-strong) hover:text-(--accent-primary)
                focus-visible:outline-none focus-visible:ring-2
                focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                focus-visible:ring-offset-(--surface-base)"
            >
              <span
                class="block text-base font-semibold text-(--text-primary)"
                i18n="@@notFound.links.categories.label"
              >
                Categories
              </span>
              <span
                class="mt-1 block text-sm text-(--text-secondary)"
                i18n="@@notFound.links.categories.helper"
              >
                Tools grouped by what they do.
              </span>
            </a>
          </li>
        </ul>
      </nav>

      <a
        routerLink="/"
        class="mt-10 inline-flex items-center rounded-(--radius-md) border border-(--border-strong)
          bg-(--accent-primary) px-5 py-3 text-sm font-bold text-(--surface-base)
          no-underline transition-colors hover:bg-(--accent-primary-hover)
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary)
          focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
        i18n="@@notFound.home"
      >
        Go home
      </a>
    </section>
  `,
})
export class NotFound {}
