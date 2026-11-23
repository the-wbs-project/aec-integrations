import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';

/**
 * Global 404 surface (AECI-62 / Phase 2.16). Rendered by:
 *
 *   1. The `**` wildcard route in `app.routes.ts` (unknown URL).
 *   2. Any detail page whose resolver returned `null` because the API
 *      reported NOT_FOUND. The detail component renders this component
 *      inline so the URL the visitor typed stays intact (no router redirect).
 *      The same holds for the admin shell and the vendor portal gate, which
 *      render it so a surface the caller may not see is never revealed.
 *
 * Status code (404) and noindex meta are set by the calling resolver via
 * `RESPONSE_INIT.status = 404` and `MetaService.setNotFoundMeta` — this
 * component is purely visual.
 *
 * Spec anchors: Stage 1 Spec §9.1b (real 404, no pinned-404 trap) and §20.7
 * (useful 404 — recovery links to top entry points). Phase 3 will replace
 * the static search hint with the live Algolia search input.
 *
 * **Design (AECI-1799).** White, no Bone band. Since the AECI-1720 layout pass it
 * sits on the 1328px page wrap (`BAND_WRAP_CLASS`), not a narrow centred column:
 * in a 768px column the five tiles were about 224px wide and every description
 * wrapped, with 40% of the desktop width empty. The prose keeps its `max-w-2xl`
 * measure, and the tiles take the whole wrap in three columns, then two, so each
 * description fits on one line at 1440px. The eyebrow and the recovery heading are
 * the overline role. The h1 is the Headline role, the global h1 size. Each recovery
 * link is a card that is itself the link (`<a aecCard interactive>`, in a
 * `group/card` list item), in the shared three-column `aec-card-grid`. The links,
 * their words and their order are unchanged. "Go home" stays the one filled button.
 */
@Component({
  selector: 'aec-not-found',
  imports: [AecButton, AecCard, RouterLink],
  template: `
    <section [class]="shell" aria-labelledby="not-found-title">
      <p class="aec-overline text-(--text-secondary)" i18n="@@notFound.eyebrow">404: Not found</p>
      <h1 id="not-found-title" class="mt-4 text-(--text-primary)" i18n="@@notFound.title">
        We couldn't find that page.
      </h1>
      <p
        class="mt-6 max-w-2xl text-t-16 leading-relaxed text-(--text-secondary)"
        i18n="@@notFound.body"
      >
        The page you were looking for may have been renamed, removed, or never existed. Try one of
        the directories below to find what you need.
      </p>

      <p
        class="mt-4 max-w-2xl text-t-14 leading-relaxed text-(--text-secondary)"
        i18n="@@notFound.searchHint"
      >
        Search is coming soon. In the meantime, browse by directory.
      </p>

      <nav aria-labelledby="not-found-recovery" class="mt-12">
        <h2
          id="not-found-recovery"
          class="aec-overline text-(--text-secondary)"
          i18n="@@notFound.recoveryHeading"
        >
          Browse the directory
        </h2>
        <ul class="aec-card-grid mt-4">
          <li class="group/card">
            <a
              routerLink="/products"
              aecCard
              interactive
              class="flex h-full flex-col gap-1 p-6 no-underline"
            >
              <span
                class="text-t-16 font-semibold text-(--text-primary) group-hover/card:text-(--accent-primary)"
                i18n="@@notFound.links.products.label"
              >
                Products
              </span>
              <span
                class="text-t-14 text-(--text-secondary)"
                i18n="@@notFound.links.products.helper"
              >
                Every AEC tool in the directory.
              </span>
            </a>
          </li>
          <li class="group/card">
            <a
              routerLink="/categories"
              aecCard
              interactive
              class="flex h-full flex-col gap-1 p-6 no-underline"
            >
              <span
                class="text-t-16 font-semibold text-(--text-primary) group-hover/card:text-(--accent-primary)"
                i18n="@@notFound.links.categories.label"
              >
                Categories
              </span>
              <span
                class="text-t-14 text-(--text-secondary)"
                i18n="@@notFound.links.categories.helper"
              >
                Tools grouped by what they do.
              </span>
            </a>
          </li>
          <li class="group/card">
            <a
              routerLink="/audiences"
              aecCard
              interactive
              class="flex h-full flex-col gap-1 p-6 no-underline"
            >
              <span
                class="text-t-16 font-semibold text-(--text-primary) group-hover/card:text-(--accent-primary)"
                i18n="@@notFound.links.audiences.label"
              >
                Audiences
              </span>
              <span
                class="text-t-14 text-(--text-secondary)"
                i18n="@@notFound.links.audiences.helper"
              >
                Tools for your role and discipline.
              </span>
            </a>
          </li>
          <li class="group/card">
            <a
              routerLink="/trades"
              aecCard
              interactive
              class="flex h-full flex-col gap-1 p-6 no-underline"
            >
              <span
                class="text-t-16 font-semibold text-(--text-primary) group-hover/card:text-(--accent-primary)"
                i18n="@@notFound.links.trades.label"
              >
                Trades
              </span>
              <span class="text-t-14 text-(--text-secondary)" i18n="@@notFound.links.trades.helper">
                Tools built for the work you sell.
              </span>
            </a>
          </li>
          <li class="group/card">
            <a
              routerLink="/phases"
              aecCard
              interactive
              class="flex h-full flex-col gap-1 p-6 no-underline"
            >
              <span
                class="text-t-16 font-semibold text-(--text-primary) group-hover/card:text-(--accent-primary)"
                i18n="@@notFound.links.phases.label"
              >
                Phases
              </span>
              <span class="text-t-14 text-(--text-secondary)" i18n="@@notFound.links.phases.helper">
                Tools grouped by project phase.
              </span>
            </a>
          </li>
        </ul>
      </nav>

      <a aecButton routerLink="/" class="mt-12" i18n="@@notFound.home"> Go home </a>
    </section>
  `,
})
export class NotFound {
  /** The 1328px page wrap, so the recovery tiles take the whole width. */
  protected readonly shell = `${BAND_WRAP_CLASS} py-16 text-(--text-primary) md:py-24`;
}
