import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext } from '@aeci/shared';

import {
  contextDirectionLabel,
  directionLabel,
  mechanismKindLabel,
} from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
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
 * Pairs that share no hub land in a trailing flat card — see
 * `groupPoweredIntegrations`, which also explains why the hub is chosen once
 * per product rather than per edge.
 *
 * Every row links the canonical product-PAIR page for its pair
 * (`defaultIntegrationContext` picks the context slug, matching
 * `IntegrationCard` / `IntegrationTile` / the `/integrations/:id` 301 target, so
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
  imports: [RouterLink, LogoOrInitial],
  // A custom element defaults to `display: inline`, so the parent section's
  // `space-y-4` margin lands on an inline box and is silently dropped. Harmless
  // while this was the section's last child; once the catalog-scope note
  // (§12.7) followed it, the note sat flush against the final card.
  host: { class: 'block' },
  template: `
    <div class="space-y-4">
      @for (group of view().groups; track group.hub.slug) {
        <section
          [attr.aria-labelledby]="'powers-group-' + group.hub.slug"
          class="overflow-hidden rounded-(--radius-lg) border border-(--border-default)"
        >
          <!-- Card header: the hub, as a noun phrase. The tinted fill + the
               border below it carry the grouping, so the heading no longer has
               to shout to separate one group from the next. -->
          <div
            class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1
              border-b border-(--border-default) bg-(--surface-sunken) px-4 py-3"
          >
            <h3 [id]="'powers-group-' + group.hub.slug" class="min-w-0">
              <a
                [routerLink]="['/products', group.hub.slug]"
                class="inline-flex items-center gap-3 rounded-(--radius-sm) text-(--text-primary)
                  transition-colors hover:text-(--accent-primary) focus-visible:outline-2
                  focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <aec-logo-or-initial [src]="group.hub.logo_url" [name]="group.hub.name" size="sm" />
                <!-- text-lg = 1.125rem, the Serif-Floor Rule's minimum for the
                     display face (DESIGN.md §3). Size lives on the SPAN, not
                     the h3: styles.css declares h3 { font-size: 1.25rem }
                     OUTSIDE any cascade layer, and unlayered rules beat every
                     Tailwind utility (which ship in the utilities layer), so a
                     text-* utility on the h3 itself is silently dead. The span
                     inherits the display face and takes its own size. See
                     DESIGN.md §3 "The Unlayered-Heading Rule". -->
                <span class="min-w-0 text-lg">{{ group.hub.name }}</span>
              </a>
            </h3>
            <span class="text-xs text-(--text-secondary)">{{
              connectionCountLabel(group.partners.length)
            }}</span>
          </div>

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
        </section>
      }

      <!-- Pairs with no shared hub. Rendered as whole A-to-B rows, since
           neither endpoint has earned the right to head a card. Only labelled
           "Other connections" when hub cards exist above it to be "other" than;
           on its own it is simply the list. -->
      @if (view().others.length > 0) {
        <section
          aria-labelledby="powers-other"
          class="overflow-hidden rounded-(--radius-lg) border border-(--border-default)"
        >
          <div class="border-b border-(--border-default) bg-(--surface-sunken) px-4 py-3">
            <h3 id="powers-other" class="text-(--text-primary)">
              <!-- Size on the span, for the unlayered-h3 reason above. -->
              <span class="text-lg">
                @if (view().groups.length > 0) {
                  <ng-container i18n="@@products.detail.body.powers.other"
                    >Other connections</ng-container
                  >
                } @else {
                  <ng-container i18n="@@products.detail.body.powers.connections"
                    >Connections</ng-container
                  >
                }
              </span>
            </h3>
          </div>

          <ul class="m-0 list-none divide-y divide-(--border-default) p-0">
            @for (pair of view().others; track pair.key) {
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
        </section>
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
   */
  readonly view = input.required<PoweredHubView>();

  /**
   * RouterLink to the canonical pair page — context slug is the alphabetically
   * -first of the two, which `PoweredConnection.a` already is (both are
   * normalized through `orderedPairSlugs`, the same rule
   * `defaultIntegrationContext` applies). Routed through the shared helper
   * anyway so the two can never drift.
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
  protected connectionCountLabel(count: number): string {
    return $localize`:@@products.detail.body.powers.group.count:${count}:count: connections`;
  }

  protected pairAriaLabel(first: string, second: string): string {
    return $localize`:@@products.detail.body.powers.row.aria:View the ${first}:FIRST: and ${second}:SECOND: integration`;
  }
}
