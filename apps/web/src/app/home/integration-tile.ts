import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext, type IntegrationListItem } from '@aeci/shared';

import { directionLabel, mechanismKindLabel } from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * AECI-185 (Phase 4.10) — the home "Recently added integrations" tile. The home
 * lists the last 10 integrations as a 2-up grid of these; the existing
 * `IntegrationCard` is a `<tr>` table row (scoped to `IndexLayout`'s body slot),
 * so the home needs a card-shaped tile, not a row.
 *
 * The whole tile is one `<a>` to the product-PAIR page
 * `/products/:contextSlug/integrations/:otherSlug` (AECI-294; the standalone
 * `/integrations/:id` page was retired). The context slug is the
 * alphabetically-first of the two products (`defaultIntegrationContext` — the
 * canonical orientation, matching the 301 + sitemap), since a home tile has no
 * inherent context product. The `mechanism_kind` chip + direction label render
 * as non-link spans to avoid nested anchors (same rule `ProductCardGrid`
 * follows). Labels come from the shared `mechanism-labels` `$localize` set
 * (AECI-142) so the ids can't drift from `/search` and `/integrations`; they
 * return `''` when absent, and the tile simply hides the chip/label then (a tile
 * has no column to align, so it omits rather than rendering the table's en-dash).
 *
 * The `→` glyph is decorative (`aria-hidden`, RTL-mirrored). Per AECI-185 it is
 * `--text-secondary`, NOT `IntegrationCard`'s `--text-tertiary` (which fails AA
 * for visible meta glyphs). Both themes via tokens. No explicit OnPush — it's the
 * Angular v22 default (AECI-125).
 */
@Component({
  selector: 'aec-integration-tile',
  imports: [RouterLink, LogoOrInitial],
  template: `
    <a
      [routerLink]="pairLink()"
      class="flex h-full flex-col gap-3 rounded-(--radius-lg) border border-(--border-default)
        bg-(--surface-raised) p-5 no-underline transition-colors hover:border-(--border-strong)
        focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
    >
      <div class="flex items-center gap-2">
        <aec-logo-or-initial
          [src]="integration().source.logo_url"
          [name]="integration().source.name"
          size="sm"
        />
        <span class="inline-block text-(--text-secondary) rtl:-scale-x-100" aria-hidden="true"
          >→</span
        >
        <aec-logo-or-initial
          [src]="integration().target.logo_url"
          [name]="integration().target.name"
          size="sm"
        />
      </div>

      <p class="min-w-0 flex-1 font-display text-lg font-semibold text-(--text-primary)">
        {{ integration().source.name }}
        <span class="inline-block text-(--text-secondary) rtl:-scale-x-100" aria-hidden="true"
          >→</span
        >
        {{ integration().target.name }}
      </p>

      <div class="flex flex-wrap items-center gap-2">
        @if (mechanismKindLabel(); as label) {
          <span
            class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
              bg-(--surface-base) px-2.5 py-0.5 text-xs font-bold tracking-[0.01em] text-(--text-secondary)"
          >
            {{ label }}
          </span>
        }
        @if (directionLabel(); as label) {
          <span class="text-xs text-(--text-secondary)">{{ label }}</span>
        }
      </div>
    </a>
  `,
})
export class IntegrationTile {
  readonly integration = input.required<IntegrationListItem>();

  /** RouterLink to the canonical product-PAIR page for this integration's two
   *  products (context = alphabetically-first slug). */
  protected readonly pairLink = computed(() => {
    const i = this.integration();
    const context = defaultIntegrationContext(i.source.slug, i.target.slug);
    const other = context === i.source.slug ? i.target.slug : i.source.slug;
    return ['/products', context, 'integrations', other];
  });

  // Shared with the /search + /integrations surfaces via `mechanism-labels.ts`
  // so the `$localize` id set can't drift; wrapped in `computed` (keyed off the
  // input signal) for zoneless memoization, matching `IntegrationCard`.
  protected readonly mechanismKindLabel = computed(() =>
    mechanismKindLabel(this.integration().mechanism_kind),
  );

  protected readonly directionLabel = computed(() => directionLabel(this.integration().direction));
}
