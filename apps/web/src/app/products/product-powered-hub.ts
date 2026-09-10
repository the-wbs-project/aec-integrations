import { Component, computed, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext } from '@aeci/shared';

import {
  contextDirectionLabel,
  directionLabel,
  mechanismKindLabel,
} from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import {
  filterPoweredHubView,
  INTEGRATION_FILTER_MIN_ROWS,
  isFilterActive,
} from './integration-filter';
import { IntegrationGroupCard } from './integration-group-card';
import { IntegrationListFilter } from './integration-list-filter';

import type { PoweredConnection, PoweredHubView } from './powered-hub-grouping';

/**
 * Stage 1.5 Addendum B — the "Integrations it powers" section on a
 * connector-role product's detail page.
 *
 * A connector (`product_role: 'connector'`, e.g. Agave ERP Sync) exists to link
 * other products to each other. Those edges hang off
 * `integrations.powered_by_product_id`, so the connector is neither endpoint and
 * the endpoint-oriented `#integrations` table on the same page is legitimately
 * empty — which read as "this product integrates with nothing", the exact
 * opposite of the truth. This section is that missing surface.
 *
 * **Cards, not chips.** The first cut rendered a fill-in-the-blank heading
 * ("Connects {hub} with") over a row of name-only chips. That broke three ways:
 * the heading was a sentence fragment (screen readers announced a trailing
 * preposition; the split string can't hold word order under translation), the
 * chips carried none of the mechanism/direction detail the sibling endpoint
 * table shows for the same edges, and `--surface-raised` chips on
 * `--surface-base` sit at 1.03:1 — visually absent. So: one bordered card per
 * hub, its name a real noun-phrase heading, and full-width partner rows with
 * the same logo + direction + mechanism vocabulary as `ProductIntegrationRow`.
 * The two sections now read as siblings, which is what they are.
 *
 * **Since AECI-841 the card is shared and collapsible.** The shape moved into
 * `IntegrationGroupCard`, which the endpoint section now uses too, and each card
 * header is a disclosure control. Cards open by default: collapsing is a reader
 * action, so the SSR HTML, the crawler and a no-JS reader all still see every
 * row. The hub name moved off the heading and onto a compact trailing link,
 * because a link cannot nest inside the header button — see the component's own
 * note, and ADR 0010 for why this is not the Angular Aria accordion.
 *
 * Pairs that share no hub land in a trailing flat card — see
 * `groupPoweredIntegrations`, which also explains why the hub is chosen once
 * per product rather than per edge.
 *
 * Every row links the canonical product-PAIR page for its pair
 * (`defaultIntegrationContext` picks the context slug, matching
 * `IntegrationTile` / the `/integrations/:id` 301 target, so
 * we never link the redirecting orientation), where the mechanism cards —
 * including this connector's own "Powered by" byline — live. One link per row,
 * so there is no stretched-link overlay to manage: the partner's own product
 * page is one hop further, from the pair page.
 *
 * No `@defer`: even at 50+ edges this is a handful of anchors, so the
 * deferred-block machinery the endpoint table needs would cost more than it
 * saves.
 */
@Component({
  selector: 'aec-product-powered-hub',
  imports: [RouterLink, LogoOrInitial, IntegrationGroupCard, IntegrationListFilter],
  // A custom element defaults to `display: inline`, so the parent section's
  // `space-y-4` margin lands on an inline box and is silently dropped. Harmless
  // while this was the section's last child; once the catalog-scope note
  // (§12.7) followed it, the note sat flush against the final card.
  host: { class: 'block' },
  template: `
    <div class="space-y-4">
      @if (showFilter()) {
        <aec-integration-list-filter
          inputId="powers-filter"
          i18n-label="@@products.detail.body.powers.filter.label"
          label="Search these connections"
          i18n-placeholder="@@products.detail.body.powers.filter.placeholder"
          placeholder="Filter by product name"
          [(query)]="query"
          [shown]="filteredView().pairCount"
          [total]="view().pairCount"
        />
      }

      @for (group of filteredView().groups; track group.hub.slug) {
        <aec-integration-group-card
          [headingId]="'powers-group-' + group.hub.slug"
          [heading]="group.hub.name"
          [logoSrc]="group.hub.logo_url"
          [logoName]="group.hub.name"
          [countLabel]="countLabel(group.partners.length, hubTotal(group.hub.slug))"
          [link]="'/products/' + group.hub.slug"
          i18n-linkLabel="@@products.detail.group.link"
          linkLabel="View product"
          [linkAriaLabel]="productLinkAriaLabel(group.hub.name)"
          [expanded]="isExpanded(group.hub.slug)"
          (toggled)="toggle(group.hub.slug)"
        >
          <ul class="m-0 list-none divide-y divide-(--border-default) p-0">
            @for (partner of group.partners; track partner.key) {
              <li>
                <a
                  [routerLink]="pairLink(partner)"
                  [attr.aria-label]="pairAriaLabel(group.hub.name, partner.partner.name)"
                  class="flex items-center gap-3 px-4 py-3 text-(--text-primary) no-underline
                    transition-colors hover:bg-(--surface-muted)
                    focus-visible:outline-2 focus-visible:-outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <aec-logo-or-initial
                    [src]="partner.partner.logo_url"
                    [name]="partner.partner.name"
                    size="sm"
                  />
                  <span class="flex min-w-0 flex-1 flex-col">
                    <span class="truncate font-medium">{{ partner.partner.name }}</span>
                    <!-- Below md the direction + mechanism columns collapse, so
                         the mechanism surfaces here as a muted sublabel: the
                         same fold ProductIntegrationRow uses. -->
                    @if (mechanismSummary(partner); as summary) {
                      <span class="mt-0.5 truncate text-xs text-(--text-secondary) md:hidden">{{
                        summary
                      }}</span>
                    }
                  </span>
                  <!-- Flow relative to the HUB (this card's frame), matching how
                       the endpoint table frames direction relative to its page
                       product. -->
                  <span class="hidden shrink-0 md:inline-flex md:min-w-[7.5rem] md:items-center">
                    @if (hubDirection(partner); as d) {
                      <span class="inline-flex items-center gap-2">
                        <span
                          class="font-display inline-block text-xl leading-none
                            text-(--accent-primary) rtl:-scale-x-100"
                          aria-hidden="true"
                          >{{ d.glyph }}</span
                        >
                        <span class="text-sm text-(--text-secondary)">{{ d.label }}</span>
                      </span>
                    } @else {
                      <span
                        class="text-sm text-(--text-secondary)"
                        i18n="@@products.detail.body.powers.direction.none"
                        i18n-aria-label="@@products.detail.body.powers.direction.none.aria"
                        aria-label="Direction not listed"
                        >–</span
                      >
                    }
                  </span>
                  @if (mechanismSummary(partner); as summary) {
                    <span
                      class="hidden shrink-0 rounded-(--radius-sm) border border-(--border-default)
                        bg-(--surface-raised) px-2.5 py-0.5 text-xs font-bold
                        tracking-[0.01em] text-(--text-secondary) md:inline-flex"
                      >{{ summary }}</span
                    >
                  }
                  <span
                    class="inline-block shrink-0 text-(--text-tertiary) rtl:-scale-x-100"
                    aria-hidden="true"
                    >→</span
                  >
                </a>
              </li>
            }
          </ul>
        </aec-integration-group-card>
      }

      <!-- Pairs with no shared hub. Rendered as whole A-to-B rows, since
           neither endpoint has earned the right to head a card. Only labelled
           "Other connections" when hub cards exist above it to be "other" than;
           on its own it is simply the list. -->
      @if (filteredView().others.length > 0) {
        <aec-integration-group-card
          headingId="powers-other"
          [heading]="othersHeading()"
          [countLabel]="countLabel(filteredView().others.length, view().others.length)"
          [expanded]="isExpanded('powers-other')"
          (toggled)="toggle('powers-other')"
        >
          <ul class="m-0 list-none divide-y divide-(--border-default) p-0">
            @for (pair of filteredView().others; track pair.key) {
              <li>
                <a
                  [routerLink]="pairLink(pair)"
                  [attr.aria-label]="pairAriaLabel(pair.a.name, pair.b.name)"
                  class="flex items-center gap-3 px-4 py-3 text-(--text-primary) no-underline
                    transition-colors hover:bg-(--surface-muted)
                    focus-visible:outline-2 focus-visible:-outline-offset-2
                    focus-visible:outline-(--accent-primary)"
                >
                  <span class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="inline-flex min-w-0 items-center gap-2">
                      <aec-logo-or-initial [src]="pair.a.logo_url" [name]="pair.a.name" size="sm" />
                      <span class="truncate font-medium">{{ pair.a.name }}</span>
                    </span>
                    <span
                      class="font-display inline-block text-xl leading-none text-(--accent-primary)
                        rtl:-scale-x-100"
                      aria-hidden="true"
                      >{{ pairGlyph(pair) }}</span
                    >
                    <span class="inline-flex min-w-0 items-center gap-2">
                      <aec-logo-or-initial [src]="pair.b.logo_url" [name]="pair.b.name" size="sm" />
                      <span class="truncate font-medium">{{ pair.b.name }}</span>
                    </span>
                  </span>
                  @if (pairDirectionLabel(pair); as label) {
                    <span class="hidden shrink-0 text-sm text-(--text-secondary) md:inline">{{
                      label
                    }}</span>
                  }
                  @if (mechanismSummary(pair); as summary) {
                    <span
                      class="hidden shrink-0 rounded-(--radius-sm) border border-(--border-default)
                        bg-(--surface-raised) px-2.5 py-0.5 text-xs font-bold
                        tracking-[0.01em] text-(--text-secondary) md:inline-flex"
                      >{{ summary }}</span
                    >
                  }
                  <span
                    class="inline-block shrink-0 text-(--text-tertiary) rtl:-scale-x-100"
                    aria-hidden="true"
                    >→</span
                  >
                </a>
              </li>
            }
          </ul>
        </aec-integration-group-card>
      }

      @if (filteredView().pairCount === 0) {
        <p
          class="rounded-(--radius-lg) border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
          i18n="@@products.detail.body.powers.filter.empty"
        >
          No connections match that search.
        </p>
      }
    </div>
  `,
})
export class ProductPoweredHub {
  /**
   * The grouped view of the page product's `integrations_as_connector` edges.
   * Computed by the PARENT (`product-detail.ts`) rather than here, so the
   * section heading's count and these rows are provably the same set — the
   * heading previously counted raw edges and over-reported against what
   * rendered.
   *
   * It stays the UNFILTERED view. The `<h2>` count reads it, the filter's
   * "of N" reads it, and every group's total reads it — a filter is a reader's
   * temporary view of the section, never a claim about the product.
   */
  readonly view = input.required<PoweredHubView>();

  /**
   * The reader's filter text (AECI-841). Deliberately component-local and
   * deliberately NOT a route query param: `/products/:slug` is a cacheable SSR
   * route keyed on path + query, so a `?q=` would mint an edge-cache entry per
   * keystroke for HTML that does not vary with it.
   */
  protected readonly query = signal('');

  /** Card keys the reader has closed. Hub slug, or `powers-other`. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly filteredView = computed(() => filterPoweredHubView(this.view(), this.query()));

  /** Below the threshold the whole list is already on one screen. */
  protected readonly showFilter = computed(
    () => this.view().pairCount >= INTEGRATION_FILTER_MIN_ROWS,
  );

  /**
   * "Other connections" only when there are hub cards above it to be other
   * than. Read off the FILTERED view, because a search that leaves only hubless
   * pairs really has left a section with no hub cards in it.
   */
  protected readonly othersHeading = computed(() =>
    this.filteredView().groups.length > 0
      ? $localize`:@@products.detail.body.powers.other:Other connections`
      : $localize`:@@products.detail.body.powers.connections:Connections`,
  );

  /**
   * An active filter opens every surviving card, whatever the reader closed
   * earlier. A search that silently matched rows inside a collapsed card would
   * report "Showing 3 of 40" over an empty screen. Clearing the query restores
   * the reader's own collapsed set rather than discarding it.
   */
  protected isExpanded(key: string): boolean {
    return isFilterActive(this.query()) || !this.collapsed().has(key);
  }

  protected toggle(key: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** This hub's UNFILTERED partner count, for the "3 of 12" label. */
  protected hubTotal(slug: string): number {
    return this.view().groups.find((group) => group.hub.slug === slug)?.partners.length ?? 0;
  }

  /**
   * Group size. Plain while the section is whole; "3 of 12" under a filter, so
   * a reader can tell a small group from a heavily filtered large one.
   */
  protected countLabel(shown: number, total: number): string {
    if (shown !== total) {
      return $localize`:@@products.detail.group.count.filtered:${shown}:SHOWN: of ${total}:TOTAL:`;
    }
    if (total === 1) {
      return $localize`:@@products.detail.body.powers.group.count.one:1 connection`;
    }
    return $localize`:@@products.detail.body.powers.group.count:${total}:count: connections`;
  }

  /**
   * RouterLink to the canonical pair page — context slug is the alphabetically
   * -first of the two, which `PoweredConnection.a` already is (both are
   * normalized through `orderedPairSlugs`, the same rule
   * `defaultIntegrationContext` applies). Routed through the shared helper
   * anyway so the two can never drift.
   *
   * **`routerLink`, not a plain `href`.** Angular's router has no global anchor
   * interception — only the `RouterLink` directive handles the click — so a bare
   * `href` here would turn every row into a full document load and app bootstrap
   * instead of a SPA navigation. Being inside a projected `<ng-content>` changes
   * nothing: the sibling `#integrations` section's `ProductIntegrationRow` is
   * projected into the same `IntegrationGroupCard` panel and keeps `routerLink`
   * too. `routerLink` still serialises a real `href` for crawlers and no-JS
   * readers, so nothing is lost. The card's own trailing "View product" anchor is
   * the deliberate exception — it opens a new tab, where a router navigation
   * would be pointless.
   */
  protected pairLink(pair: PoweredConnection): readonly string[] {
    const context = defaultIntegrationContext(pair.a.slug, pair.b.slug);
    const other = context === pair.a.slug ? pair.b.slug : pair.a.slug;
    return ['/products', context, 'integrations', other];
  }

  /**
   * Mechanism badge text. One kind renders its own label; several (a pair
   * joined by, say, both a marketplace app and an iPaaS flow) collapse to a
   * count rather than a badge pile — the pair page carries the per-mechanism
   * detail. Empty string when no collapsed edge named a kind, which the
   * template's `@if`-as-binding treats as absent.
   */
  protected mechanismSummary(pair: PoweredConnection): string {
    const kinds = pair.mechanismKinds;
    if (kinds.length === 0) return '';
    if (kinds.length === 1) return mechanismKindLabel(kinds[0]);
    return $localize`:@@products.detail.body.powers.mechanism.multiple:${kinds.length}:count: connection types`;
  }

  /** Hub-relative direction presentation (arrow glyph + label), or null when unknown. */
  protected hubDirection(partner: {
    readonly hubDirection: Parameters<typeof contextDirectionLabel>[0];
  }): { label: string; glyph: string } | null {
    const framed = contextDirectionLabel(partner.hubDirection);
    return framed.token === null ? null : framed;
  }

  /** `⇄` for a round trip, `→` for one-way A→B, `←` for B→A, `·` when unknown. */
  protected pairGlyph(pair: PoweredConnection): string {
    switch (pair.direction) {
      case 'both':
        return '⇄';
      case 'outbound':
        return '→';
      case 'inbound':
        return '←';
      default:
        return '·';
    }
  }

  /** One-way / Bidirectional for a hubless pair row; `''` when unknown. */
  protected pairDirectionLabel(pair: PoweredConnection): string {
    if (pair.direction === null) return '';
    return directionLabel(pair.direction === 'both' ? 'bidirectional' : 'one-way');
  }

  /**
   * Built in TS rather than an interpolated `i18n-*` attribute — those emit no
   * attribute at all in this app (see the repo note on interpolated i18n attrs),
   * which would silently leave these row links unnamed.
   */
  protected pairAriaLabel(first: string, second: string): string {
    return $localize`:@@products.detail.body.powers.row.aria:View the ${first}:FIRST: and ${second}:SECOND: integration`;
  }

  /**
   * Accessible name for a card's trailing "View product" link. Same reason, plus
   * the new tab: a link that opens a new browsing context has to say so, and the
   * name starts with the visible "View product" text so WCAG 2.5.3 Label in Name
   * holds and speech input can target it.
   */
  protected productLinkAriaLabel(name: string): string {
    return $localize`:@@products.detail.group.link.aria:View product: ${name}:NAME: (opens in a new tab)`;
  }
}
