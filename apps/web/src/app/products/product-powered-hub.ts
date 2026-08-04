import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext, type IntegrationListItem } from '@aeci/shared';

import { groupPoweredIntegrations } from './powered-hub-grouping';

/**
 * Stage 1.5 Addendum B — the "Powers these integrations" hub view on a
 * connector-role product's detail page.
 *
 * A connector (`product_role: 'connector'`, e.g. Agave ERP Sync) exists to link
 * other products to each other. Those edges hang off
 * `integrations.powered_by_product_id`, so the connector is neither endpoint and
 * the endpoint-oriented `#integrations` table on the same page is legitimately
 * empty — which read as "this product integrates with nothing", the exact
 * opposite of the truth. This section is that missing surface.
 *
 * Presentation is a grouped hub view rather than a flat edge table: one heading
 * per hub platform, partner products as chips beneath it. Each chip links to the
 * canonical product-PAIR page for that pair (`defaultIntegrationContext` picks
 * the context slug, matching `IntegrationCard` / `IntegrationTile`), where the
 * mechanism cards — including this connector's own "Powered by" byline — live.
 *
 * No `@defer`: chips are a handful of anchors even at 50+ edges, so the deferred
 * -block machinery the endpoint table needs would cost more than it saves.
 */
@Component({
  selector: 'aec-product-powered-hub',
  imports: [RouterLink],
  template: `
    <div class="space-y-6">
      @for (group of groups(); track group.hub.slug) {
        <section [attr.aria-labelledby]="'powers-group-' + group.hub.slug" class="space-y-3">
          <h3
            [id]="'powers-group-' + group.hub.slug"
            class="text-base font-semibold text-(--text-primary)"
          >
            <ng-container i18n="@@products.detail.body.powers.group"
              >Connects
              <a
                [routerLink]="['/products', group.hub.slug]"
                class="rounded-(--radius-sm) text-(--accent-primary) underline underline-offset-2
                  transition-colors hover:text-(--accent-primary-hover) focus-visible:outline-none
                  focus-visible:ring-2 focus-visible:ring-(--accent-primary)
                  focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)"
                >{{ group.hub.name }}</a
              >
              with</ng-container
            >
          </h3>
          <ul class="flex list-none flex-wrap gap-2 p-0">
            @for (partner of group.partners; track partner.slug) {
              <li>
                <a
                  [routerLink]="pairLink(group.hub.slug, partner.slug)"
                  class="inline-flex items-center rounded-(--radius-sm) border
                    border-(--border-default) bg-(--surface-raised) px-3 py-1
                    text-[0.8125rem] font-medium tracking-[0.01em] text-(--text-primary)
                    no-underline transition-colors duration-150 hover:border-(--border-strong)
                    hover:text-(--accent-primary) focus-visible:outline-none focus-visible:ring-2
                    focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                    focus-visible:ring-offset-(--surface-base)"
                  >{{ partner.name }}</a
                >
              </li>
            }
          </ul>
        </section>
      }
    </div>
  `,
})
export class ProductPoweredHub {
  /** The page product's `integrations_as_connector` edges (may be empty). */
  readonly integrations = input.required<readonly IntegrationListItem[]>();

  protected readonly groups = computed(() => groupPoweredIntegrations(this.integrations()));

  /**
   * RouterLink to the canonical pair page for a hub/partner pair — context slug
   * is the alphabetically-first of the two, matching `IntegrationCard` and the
   * `/integrations/:id` 301 target so we never link the redirecting orientation.
   */
  protected pairLink(hubSlug: string, partnerSlug: string): readonly string[] {
    const context = defaultIntegrationContext(hubSlug, partnerSlug);
    const other = context === hubSlug ? partnerSlug : hubSlug;
    return ['/products', context, 'integrations', other];
  }
}
