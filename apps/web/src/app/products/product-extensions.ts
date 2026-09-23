import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * AECI-710 / `STAGE_1_5_SPEC.md` §13.3b — the `product_extensions` relation on
 * the product detail page, both directions.
 *
 * An extension is a product built INSIDE a host (a Revit add-in, a Dynamics 365
 * vertical). It runs in the host, so there is no boundary for data to cross and
 * it is not an integration. Both components below are therefore deliberately
 * NOT integration vocabulary: no table, no lane, no `IntegrationGroupCard`, no
 * direction, no count. The Integrations section and `integration_count` never
 * see these rows (§13.5's lockstep is unchanged).
 *
 * Anchor site: Faire (the catalog's anchor, `DESIGN.md`). Its "Shop more from
 * {brand}" parent strip is the pattern for the sidebar card, and its brand tile
 * row for the body grid. One verb, "built within", names the relation in both
 * directions so the two read as mirror images. The body tiles carry no chevron,
 * which is what keeps them from reading as integration rows, so they take a
 * surface wash on hover instead of relying on a border shift alone.
 */

/** Shared link-card classes: the vendor card's shape, plus a visible focus ring. */
const CARD_CLASS =
  'flex h-full items-center gap-3 rounded-(--radius-lg) border border-(--border-default) ' +
  'p-3 no-underline transition-colors hover:border-(--border-strong) ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary) ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)';

/**
 * "Built within": the hosts this product is built within, in the metadata
 * sidebar directly under Vendor. Same card as the vendor card, because it is the
 * same kind of fact: what this product is, not what it connects to.
 *
 * Attribute selector on the page's own `<section>`, the same escape hatch as
 * `ProductIntegrationsSection`, so the sidebar's grid and `space-y` rhythm land
 * on the section itself. The parent mounts it only when `hosts` is non-empty.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-built-within]',
  imports: [RouterLink, LogoOrInitial],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2
      id="built-within-title"
      class="aec-overline text-(--text-secondary)"
      i18n="@@products.detail.metadata.builtWithin"
    >
      Built within
    </h2>
    <ul class="space-y-2">
      @for (host of hosts(); track host.id) {
        <li>
          <a
            [routerLink]="['/products', host.slug]"
            [class]="cardClass"
            class="bg-(--surface-base) lg:bg-(--surface-raised) lg:p-4"
          >
            <aec-logo-or-initial [src]="host.logo_url" [name]="host.name" alt="" size="sm" />
            <span class="min-w-0">
              <span class="block break-words font-medium text-(--text-primary)">{{
                host.name
              }}</span>
              @if (host.vendor; as v) {
                <span class="block break-words text-sm text-(--text-secondary)">{{ v.name }}</span>
              }
            </span>
          </a>
        </li>
      }
    </ul>
  `,
})
export class ProductBuiltWithin {
  readonly hosts = input.required<readonly ProductListItem[]>();
  protected readonly cardClass = CARD_CLASS;
}

/**
 * "Extensions built within {product}": the products built within this one, as a
 * body section after Integrations. A grid of linked tiles, never table rows, so
 * it cannot read as a third integrations lane. The heading carries no `(N)`, so
 * the page never shows two counts that look like the same kind.
 *
 * Attribute selector on the page's `<section id="extensions">`, like the
 * Integrations section, so the anchor and the labelled region stay on the
 * element the section nav links to. The parent mounts it only when
 * `extensions` is non-empty.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-extensions-section]',
  imports: [RouterLink, LogoOrInitial],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="space-y-2">
      <h2 id="extensions-title" class="font-display text-2xl font-semibold text-(--text-primary)">
        {{ heading() }}
      </h2>
      <p class="max-w-prose text-(--text-secondary)">{{ lead() }}</p>
    </div>
    <ul class="grid gap-3 sm:grid-cols-2">
      @for (extension of extensions(); track extension.id) {
        <li>
          <a
            [routerLink]="['/products', extension.slug]"
            [class]="cardClass"
            class="bg-(--surface-raised) hover:bg-(--surface-sunken)"
          >
            <aec-logo-or-initial
              [src]="extension.logo_url"
              [name]="extension.name"
              alt=""
              size="sm"
            />
            <span class="min-w-0">
              <span class="block break-words font-medium text-(--text-primary)">{{
                extension.name
              }}</span>
              @if (extension.vendor; as v) {
                <span class="block break-words text-sm text-(--text-secondary)">{{ v.name }}</span>
              }
            </span>
          </a>
        </li>
      }
    </ul>
  `,
})
export class ProductExtensionsSection {
  /** The page product's name: the host every listed extension is built within. */
  readonly productName = input.required<string>();
  readonly extensions = input.required<readonly ProductListItem[]>();
  protected readonly cardClass = CARD_CLASS;

  protected readonly heading = computed(() => {
    const name = this.productName();
    return $localize`:@@products.detail.body.extensions.heading:Extensions built within ${name}:name:`;
  });

  protected readonly lead = computed(() => {
    const name = this.productName();
    return $localize`:@@products.detail.body.extensions.lead:Add-ins and apps that run inside ${name}:name: rather than connecting to it.`;
  });
}
