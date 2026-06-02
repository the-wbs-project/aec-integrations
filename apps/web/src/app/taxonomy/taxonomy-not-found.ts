import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { TaxonomyKind } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * Inline "taxonomy term not found" panel, rendered by `TaxonomyBrowsePage` when
 * the resolver returns null. Shared across all three browse kinds.
 *
 * The page HTTP status is set to 404 by the resolver via Angular's
 * `RESPONSE_INIT.status = 404`, and `MetaService.setNotFoundMeta` writes the
 * noindex robots tag. This component has no SEO or status side effects — it's
 * purely visual. (Same temporary-inline-panel approach the vendor / product
 * detail pages use; retrofitting all entity 404s to AECI-62's global shell is a
 * separate concern.)
 *
 * Only the `/categories` index exists in Stage 1, so the "browse all" CTA is
 * shown for the `category` kind only; discipline / phase fall back to home.
 */
@Component({
  selector: 'aec-taxonomy-not-found',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section
      class="mx-auto w-full max-w-3xl px-6 py-16 text-(--text-primary) md:py-24"
      aria-labelledby="taxonomy-not-found-title"
    >
      <p
        class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
        i18n="@@taxonomy.notFound.eyebrow"
      >
        404 — Not found
      </p>
      <h1
        id="taxonomy-not-found-title"
        class="mt-3 font-display text-3xl font-semibold tracking-tight md:text-4xl"
      >
        {{ title() }}
      </h1>
      <p
        class="mt-4 max-w-2xl text-base leading-relaxed text-(--text-secondary)"
        i18n="@@taxonomy.notFound.body"
      >
        <code class="font-mono text-(--text-primary)">{{ slug() }}</code> may have been renamed,
        removed, or never existed. Browse the directory or head back home.
      </p>

      <div class="mt-8 flex flex-wrap gap-3">
        @if (kind() === 'category') {
          <a
            routerLink="/categories"
            class="inline-flex items-center rounded-(--radius-md) border border-(--border-strong)
              bg-(--accent-primary) px-5 py-3 text-sm font-bold text-(--surface-base)
              no-underline transition-colors hover:bg-(--accent-primary-hover)
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary)
              focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
            i18n="@@taxonomy.notFound.browseCategories"
          >
            Browse all categories
          </a>
        }
        <a
          routerLink="/"
          class="inline-flex items-center rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) px-5 py-3 text-sm font-bold text-(--text-primary)
            no-underline transition-colors hover:border-(--border-strong)
            hover:text-(--accent-primary) focus-visible:outline-none focus-visible:ring-2
            focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
            focus-visible:ring-offset-(--surface-base)"
          i18n="@@taxonomy.notFound.home"
        >
          Go home
        </a>
      </div>
    </section>
  `,
})
export class TaxonomyNotFound {
  readonly kind = input.required<TaxonomyKind>();
  readonly slug = input.required<string>();

  protected readonly title = computed(() => {
    switch (this.kind()) {
      case 'category':
        return $localize`:@@taxonomy.notFound.title.category:We couldn't find a category with that slug.`;
      case 'discipline':
        return $localize`:@@taxonomy.notFound.title.discipline:We couldn't find a discipline with that slug.`;
      case 'phase':
        return $localize`:@@taxonomy.notFound.title.phase:We couldn't find a project phase with that slug.`;
    }
  });
}
