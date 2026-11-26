import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecCard } from '../shared/card/card';

import { defaultIntegrationContext } from '@aeci/shared';
import type { AlgoliaIntegrationRecord } from '@aeci/shared/algolia-records';

import { mechanismKindLabel } from './mechanism-labels';
import { directionGlyph, pairFlowSentence } from '../products/pair-direction-labels';
import { Chip } from '../shared/chip/chip';

/**
 * Grid hit card for an `integrations` search result (AECI-142). `<article>` tile
 * bound to the denormalized §7.1 integration record. AECI-298 (Stage 1.5) — the
 * stretched link targets the canonical product-PAIR page
 * `/products/:context/integrations/:other` (context = alphabetically-first slug
 * via `defaultIntegrationContext`, from the record's endpoint slugs), not the
 * retired `/integrations/:objectID` detail route (which now 301-redirects to the
 * same pair page). The mechanism badge reuses the shared `mechanism-labels`.
 *
 * Direction (AECI-1939). The record is oriented so that on a `one-way` record the
 * source is the sender (`AlgoliaIntegrationRecordSchema`), so the headline reads
 * `{source} → {target}` only for a one-way record, `⇄` for a bidirectional one and
 * a neutral `·` when the direction is unknown, which makes no flow claim. The
 * glyphs come from `directionGlyph()` (DESIGN.md "The Arrow Rule"), framed on the
 * source, the name printed first. The meta line names both products
 * (`pairFlowSentence`), as the connector page does, because a search hit is read
 * from neither product. No line for an unknown direction. The `/search`
 * Integrations tab is hidden (STAGE_1_SPEC.md §7.5), so this card is not
 * currently surfaced. Strings `$localize`-wrapped.
 */
@Component({
  selector: 'aec-search-integration-card',
  imports: [RouterLink, AecCard, Chip],
  host: { class: 'group/card block h-full' },
  template: `
    <article aecCard interactive class="flex h-full flex-col p-6">
      <h3 class="text-(--text-primary)">
        <!-- The card title is the heading's link (a stretched link). The size sits on the
             block anchor, not the h3: the unlayered h3 rule beats a text-* utility on
             the h3 itself (DESIGN.md, the Unlayered-Heading Rule). -->
        <a
          [routerLink]="pairLink()"
          class="block text-t-20 leading-tight transition-colors after:absolute after:inset-0 after:rounded-card group-hover/card:text-(--accent-primary) focus-visible:outline-0"
        >
          {{ record().source_product_name }}
          <span
            class="inline-block text-(--text-secondary)"
            [class.rtl:-scale-x-100]="record().direction === 'one-way'"
            aria-hidden="true"
            >{{ glyph() }}</span
          >
          {{ record().target_product_name }}
        </a>
      </h3>

      @if (record().description; as description) {
        <p class="mt-3 line-clamp-2 text-sm leading-relaxed text-(--text-secondary)">
          {{ description }}
        </p>
      }

      <div class="mt-4 flex flex-wrap items-center gap-2">
        @if (mechanismLabel(); as label) {
          <aec-chip density="dense" tone="neutral">{{ label }}</aec-chip>
        }
        @if (flowSentence(); as sentence) {
          <span class="text-xs text-(--text-secondary)">{{ sentence }}</span>
        }
      </div>
    </article>
  `,
})
export class SearchIntegrationCard {
  readonly record = input.required<AlgoliaIntegrationRecord>();

  /** RouterLink to the canonical product-PAIR page for this integration's two
   *  products (context = alphabetically-first slug), as `defaultIntegrationContext` picks it. */
  protected readonly pairLink = computed(() => {
    const r = this.record();
    const context = defaultIntegrationContext(r.source_product_slug, r.target_product_slug);
    const other = context === r.source_product_slug ? r.target_product_slug : r.source_product_slug;
    return ['/products', context, 'integrations', other];
  });

  protected readonly mechanismLabel = computed(() =>
    mechanismKindLabel(this.record().mechanism_kind),
  );

  /** The headline separator: a direction glyph, or a neutral dot when unknown. */
  protected readonly glyph = computed(() => {
    switch (this.record().direction) {
      case 'one-way':
        return directionGlyph('outbound');
      case 'bidirectional':
        return directionGlyph('both');
      default:
        return '·';
    }
  });

  /** "{source} sends to {target}", "{source} and {target} sync both ways", or `''`. */
  protected readonly flowSentence = computed(() => {
    const r = this.record();
    switch (r.direction) {
      case 'one-way':
        return pairFlowSentence('outbound', r.source_product_name, r.target_product_name);
      case 'bidirectional':
        return pairFlowSentence('both', r.source_product_name, r.target_product_name);
      default:
        return '';
    }
  });
}
